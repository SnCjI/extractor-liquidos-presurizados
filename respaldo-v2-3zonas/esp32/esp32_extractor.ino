/*
  esp32_extractor.ino — Extractor de líquidos presurizados (H2O)
  ---------------------------------------------------------------
  Controla 3 zonas de calentamiento. Cada zona tiene:
    - una resistencia eléctrica (carga de 127 V AC),
    - un relevador de estado sólido SSR-40DA que la enciende/apaga,
    - una sonda de temperatura DS18B20 (las 3 en el MISMO cable de datos).

  Qué hace:
    1. Lee la temperatura de las 3 zonas cada segundo.
    2. Manda las lecturas al servidor (laptop) cada 2 segundos.
    3. El servidor le responde con los valores de AJUSTE que el operador
       escribió en el HMI (temperatura deseada de cada zona y si el
       sistema está encendido).
    4. Enciende o apaga cada resistencia para mantener su zona en el
       ajuste (control ON/OFF con histéresis).

  SEGURIDAD (el ESP32 decide esto solo, aunque el HMI diga otra cosa):
    - Al arrancar, las 3 resistencias empiezan APAGADAS.
    - Si pasan 15 s sin respuesta del servidor -> todas APAGADAS.
    - Si una sonda se desconecta o falla -> esa resistencia APAGADA.
    - Si una zona pasa de T_MAX_SEGURIDAD -> esa resistencia APAGADA.
    Esto NO sustituye una protección física: instala también un
    termostato/fusible térmico en serie con las resistencias.

  RED (modo Access Point, igual que antes):
    El ESP32 crea la red "HMI-ESP32" (IP 192.168.4.1). La laptop con el
    servidor debe tener IP fija 192.168.4.2. El celular se conecta a la
    misma red y abre http://192.168.4.2:3000

  Librerías (Arduino IDE > Herramientas > Administrar bibliotecas):
    - "OneWire"            (Paul Stoffregen)
    - "DallasTemperature"  (Miles Burton)
    - "ArduinoJson"        (Benoit Blanchon), versión 7
    Placa: "ESP32 Dev Module" (paquete esp32 de Espressif).

  CONEXIONES:
    Sondas DS18B20 (las 3 en paralelo):
      rojo  -> 3V3          negro -> GND
      amarillo (datos) -> GPIO 4   + resistencia de 4.7 kΩ entre GPIO 4 y 3V3
    SSR-40DA (lado de control, terminales 3 (+) y 4 (−)):
      SSR zona 1 (+) -> GPIO 25     SSR zona 2 (+) -> GPIO 26
      SSR zona 3 (+) -> GPIO 27     los 3 (−)      -> GND del ESP32
  ---------------------------------------------------------------
*/

#include <WiFi.h>
#include <HTTPClient.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <ArduinoJson.h>

// ======================= CONFIGURACIÓN =======================

// Red WiFi que crea el ESP32 (contraseña de 8 caracteres o más)
const char* AP_SSID     = "HMI-ESP32";
const char* AP_PASSWORD = "extraccion2024";
IPAddress AP_IP(192, 168, 4, 1);
IPAddress AP_GATEWAY(192, 168, 4, 1);
IPAddress AP_SUBNET(255, 255, 255, 0);

// Servidor en la laptop (IP fija 192.168.4.2 dentro de la red del ESP32)
const char* SERVER_URL = "http://192.168.4.2:3000/api/data";
const char* DEVICE_KEY = "cambia-esta-clave";   // igual que en el servidor
const char* DEVICE_ID  = "esp32-extractor-1";

// Pines
const int PIN_ONEWIRE = 4;                 // datos de las 3 sondas DS18B20
const int PIN_SSR[3]  = { 25, 26, 27 };    // SSR de la zona 1, 2 y 3
// Si tu SSR enciende con LOW en vez de HIGH, cambia esto a LOW:
const int SSR_ENCENDIDO = HIGH;

// Control
const float HISTERESIS          = 1.5;    // °C: enciende bajo (ajuste − 1.5), apaga sobre (ajuste + 1.5)
const float T_MAX_SEGURIDAD     = 125.0;  // °C: por encima, resistencia apagada siempre
const unsigned long TIMEOUT_SERVIDOR_MS = 15000;  // sin respuesta -> todo apagado
const unsigned long INTERVALO_LECTURA_MS = 1000;
const unsigned long INTERVALO_ENVIO_MS   = 2000;

// Orden de las sondas. Al arrancar, el Monitor Serie muestra la dirección
// de cada sonda encontrada. Si la "zona 1" del HMI no corresponde a la
// resistencia 1 real, copia aquí las direcciones en el orden correcto y
// pon USAR_DIRECCIONES_FIJAS en true.
const bool USAR_DIRECCIONES_FIJAS = false;
DeviceAddress DIRECCIONES[3] = {
  { 0x28, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00 },   // zona 1
  { 0x28, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00 },   // zona 2
  { 0x28, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00 },   // zona 3
};

// =============================================================

OneWire oneWire(PIN_ONEWIRE);
DallasTemperature sondas(&oneWire);

float temp[3]     = { NAN, NAN, NAN };
bool  ssrOn[3]    = { false, false, false };
float ajuste[3]   = { 60, 60, 60 };      // se reemplaza con lo que mande el servidor
bool  sistemaOn   = false;               // empieza APAGADO hasta que el servidor diga otra cosa
unsigned long ultimaRespuestaOk = 0;     // 0 = todavía no hay respuesta
unsigned long ultimaLectura = 0, ultimoEnvio = 0;
String alarma = "";

void ponerSSR(int zona, bool encender) {
  ssrOn[zona] = encender;
  digitalWrite(PIN_SSR[zona], encender ? SSR_ENCENDIDO : !SSR_ENCENDIDO);
}

void apagarTodo() {
  for (int i = 0; i < 3; i++) ponerSSR(i, false);
}

void imprimirDireccion(const DeviceAddress d) {
  for (int i = 0; i < 8; i++) {
    Serial.printf("0x%02X%s", d[i], i < 7 ? ", " : "");
  }
}

void iniciarSondas() {
  sondas.begin();
  sondas.setResolution(11);              // 0.125 °C, ~375 ms por lectura
  sondas.setWaitForConversion(false);    // no bloquea el programa mientras mide
  int n = sondas.getDeviceCount();
  Serial.printf("Sondas DS18B20 encontradas: %d (se esperan 3)\n", n);
  if (!USAR_DIRECCIONES_FIJAS) {
    for (int i = 0; i < 3; i++) {
      if (sondas.getAddress(DIRECCIONES[i], i)) {
        Serial.printf("  Zona %d -> ", i + 1);
        imprimirDireccion(DIRECCIONES[i]);
        Serial.println();
      } else {
        Serial.printf("  Zona %d -> NO ENCONTRADA (revisa el cable)\n", i + 1);
      }
    }
  }
  sondas.requestTemperatures();
}

void startAccessPoint() {
  WiFi.mode(WIFI_AP);
  WiFi.softAPConfig(AP_IP, AP_GATEWAY, AP_SUBNET);
  WiFi.softAP(AP_SSID, AP_PASSWORD);
  Serial.printf("Red WiFi creada: %s   IP del ESP32: %s\n",
                AP_SSID, WiFi.softAPIP().toString().c_str());
}

// Lee las sondas y decide el estado de cada resistencia.
void leerYControlar() {
  alarma = "";
  bool sinServidor = (ultimaRespuestaOk == 0) ||
                     (millis() - ultimaRespuestaOk > TIMEOUT_SERVIDOR_MS);
  if (sinServidor && sistemaOn) alarma += "Sin comunicacion con el servidor: resistencias apagadas. ";

  for (int i = 0; i < 3; i++) {
    float t = sondas.getTempC(DIRECCIONES[i]);
    // -127 = sonda desconectada; fuera de -40..150 °C = lectura no válida
    bool sondaOk = (t != DEVICE_DISCONNECTED_C) && t > -40 && t < 150;
    temp[i] = sondaOk ? t : NAN;

    if (!sistemaOn || sinServidor) {
      ponerSSR(i, false);
    } else if (!sondaOk) {
      ponerSSR(i, false);
      alarma += "Sonda zona " + String(i + 1) + " sin lectura. ";
    } else if (t >= T_MAX_SEGURIDAD) {
      ponerSSR(i, false);
      alarma += "Zona " + String(i + 1) + " sobre temperatura maxima. ";
    } else if (t < ajuste[i] - HISTERESIS) {
      ponerSSR(i, true);
    } else if (t > ajuste[i] + HISTERESIS) {
      ponerSSR(i, false);
    }
    // dentro de la banda: se queda como estaba
  }
  sondas.requestTemperatures();   // pide la siguiente lectura (estará lista en 1 s)
}

void agregarTemp(JsonDocument& doc, const char* clave, float t) {
  if (isnan(t)) doc[clave] = nullptr;
  else doc[clave] = roundf(t * 100) / 100.0;
}

void enviarYRecibirAjustes() {
  if (WiFi.softAPgetStationNum() == 0) {
    Serial.println("Nadie conectado a la red HMI-ESP32 todavia (la laptop debe conectarse).");
    return;
  }

  JsonDocument doc;
  doc["device_id"]  = DEVICE_ID;
  doc["device_ts"]  = millis();
  agregarTemp(doc, "t_z1", temp[0]);
  agregarTemp(doc, "t_z2", temp[1]);
  agregarTemp(doc, "t_z3", temp[2]);
  doc["ssr1"] = ssrOn[0] ? 1 : 0;
  doc["ssr2"] = ssrOn[1] ? 1 : 0;
  doc["ssr3"] = ssrOn[2] ? 1 : 0;
  doc["presion"] = nullptr;               // sin sensor de presión por ahora
  doc["sistema_on"] = sistemaOn ? 1 : 0;
  doc["alarma"] = alarma;
  String cuerpo;
  serializeJson(doc, cuerpo);

  HTTPClient http;
  http.setTimeout(2500);
  http.begin(SERVER_URL);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-device-key", DEVICE_KEY);
  int code = http.POST(cuerpo);

  if (code == 200) {
    JsonDocument resp;
    if (deserializeJson(resp, http.getString()) == DeserializationError::Ok &&
        resp["setpoints"].is<JsonObject>()) {
      JsonObject sp = resp["setpoints"];
      ajuste[0] = sp["sp_z1"] | ajuste[0];
      ajuste[1] = sp["sp_z2"] | ajuste[1];
      ajuste[2] = sp["sp_z3"] | ajuste[2];
      sistemaOn = (sp["sistema_on"] | 0) == 1;
      ultimaRespuestaOk = millis();
    }
  } else {
    Serial.printf("Error al enviar (HTTP %d). ¿Esta encendido el servidor en la laptop?\n", code);
  }
  http.end();

  Serial.printf("Z1 %.1f°C %s | Z2 %.1f°C %s | Z3 %.1f°C %s | ajustes %.0f/%.0f/%.0f | sistema %s %s\n",
                temp[0], ssrOn[0] ? "ON " : "off", temp[1], ssrOn[1] ? "ON " : "off",
                temp[2], ssrOn[2] ? "ON " : "off", ajuste[0], ajuste[1], ajuste[2],
                sistemaOn ? "ENCENDIDO" : "apagado", alarma.c_str());
}

void setup() {
  // Lo primero: resistencias apagadas
  for (int i = 0; i < 3; i++) {
    pinMode(PIN_SSR[i], OUTPUT);
    ponerSSR(i, false);
  }
  Serial.begin(115200);
  delay(300);
  Serial.println("\n=== Extractor de liquidos presurizados — ESP32 ===");
  iniciarSondas();
  startAccessPoint();
}

void loop() {
  unsigned long ahora = millis();
  if (ahora - ultimaLectura >= INTERVALO_LECTURA_MS) {
    ultimaLectura = ahora;
    leerYControlar();
  }
  if (ahora - ultimoEnvio >= INTERVALO_ENVIO_MS) {
    ultimoEnvio = ahora;
    enviarYRecibirAjustes();
  }
}
