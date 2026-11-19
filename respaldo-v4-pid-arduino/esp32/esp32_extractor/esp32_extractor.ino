/*
  esp32_extractor.ino — Extractor de líquidos presurizados (H2O)   v4
  ---------------------------------------------------------------
  Controla 2 zonas de calentamiento (zona 1 = superior, zona 2 = inferior).
  Cada zona tiene:
    - una resistencia eléctrica (carga de 127 V AC),
    - un relevador de estado sólido SSR-40DA que la enciende/apaga,
    - un termopar tipo K con su módulo MAX6675.

  Qué hace:
    1. Lee la temperatura de las 2 zonas cada segundo.
    2. Con un control PID calcula la POTENCIA (0 a 100 %) de cada
       resistencia y prende su SSR esa fracción de cada ventana de 2 s
       (ej. 40 % = 0.8 s encendida y 1.2 s apagada).
    3. Manda las lecturas y la potencia al servidor (laptop) cada 2 s.
    4. El servidor responde con los AJUSTES que el operador escribió en el
       HMI (temperatura deseada de cada zona, 0 a 100 °C, y si el sistema
       está encendido).

  El control corre en una tarea aparte (FreeRTOS), así que aunque el envío
  al servidor tarde, los SSR se siguen prendiendo y apagando a tiempo.

  SEGURIDAD (el ESP32 decide esto solo, aunque el HMI diga otra cosa):
    - Al arrancar, las 2 resistencias empiezan APAGADAS.
    - Si pasan 15 s sin respuesta del servidor -> todas APAGADAS.
    - Si un termopar se desconecta o falla -> esa resistencia APAGADA.
    - Si una zona pasa de T_MAX_SEGURIDAD (105 °C) -> esa resistencia APAGADA.
    Esto NO sustituye una protección física: instala también un
    termostato/fusible térmico en serie con las resistencias.

  RED (modo Access Point):
    El ESP32 crea la red "HMI-ESP32" (IP 192.168.4.1). La laptop con el
    servidor debe tener IP fija 192.168.4.2. El celular se conecta a la
    misma red y abre http://192.168.4.2:3000

  Librerías (Arduino IDE > Herramientas > Administrar bibliotecas):
    - "ArduinoJson" (Benoit Blanchon), versión 7
    (Ya NO se usan OneWire ni DallasTemperature.)
    Placa: "ESP32 Dev Module" (paquete esp32 de Espressif).

  CONEXIONES:
    Módulos MAX6675 (los 2 comparten SCK y SO; cada uno tiene su CS):
      VCC -> 3V3 (no a 5V)        GND -> GND
      SCK -> GPIO 18 (los 2)      SO  -> GPIO 19 (los 2)
      CS zona 1 -> GPIO 5         CS zona 2 -> GPIO 17
    SSR-40DA (lado de control, terminales 3 (+) y 4 (−)):
      SSR zona 1 (+) -> GPIO 25     SSR zona 2 (+) -> GPIO 26
      los 2 (−)      -> GND del ESP32
  ---------------------------------------------------------------
*/

#include <WiFi.h>
#include <HTTPClient.h>
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
const int NUM_ZONAS = 2;                    // zona 1 = superior, zona 2 = inferior
const int PIN_SCK   = 18;                   // reloj de los 2 MAX6675
const int PIN_SO    = 19;                   // datos de los 2 MAX6675
const int PIN_CS[NUM_ZONAS]  = { 5, 17 };   // CS del MAX6675 de la zona 1 y 2
const int PIN_SSR[NUM_ZONAS] = { 25, 26 };  // SSR de la zona 1 y 2
// Si tu SSR enciende con LOW en vez de HIGH, cambia esto a LOW:
const int SSR_ENCENDIDO = HIGH;

// Ganancias del PID de cada zona. Son valores CONSERVADORES que no se pasan
// del ajuste ni en una celda de acero pesada (pueden ser lentos).
// Saca los de TU equipo con la prueba de escalón de prueba_finalpid.ino y
// server/calcular-pid.js, y cópialos aquí (cada zona puede tener los suyos).
//                               zona 1  zona 2
const float KP[NUM_ZONAS] = {    4.0,    4.0   };   // % de potencia por °C de error
const float KI[NUM_ZONAS] = {    0.005,  0.005 };   // % por (°C · s)
const float KD[NUM_ZONAS] = {    40.0,   40.0  };   // % por (°C / s)

// Límites y tiempos
const float SP_MIN = 0.0;                  // °C  (el servidor usa los mismos límites)
const float SP_MAX = 100.0;                // °C
const float T_MAX_SEGURIDAD = 105.0;       // °C: por encima, resistencia apagada siempre
const unsigned long PERIODO_PID_MS = 1000; // cada cuánto se lee y se calcula el PID
const unsigned long VENTANA_MS     = 2000; // ventana de encendido de los SSR
const unsigned long TIMEOUT_SERVIDOR_MS = 15000;  // sin respuesta -> todo apagado
const unsigned long INTERVALO_ENVIO_MS  = 2000;

// =============================================================

// ---------------- PID ----------------
struct ControlPID {
  float kp, ki, kd;
  float integral = 0;      // parte I acumulada (en %)
  float tAnterior = NAN;   // para la parte D
  float derivada = 0;      // derivada filtrada (°C/s)

  void reiniciar() { integral = 0; tAnterior = NAN; derivada = 0; }

  // Devuelve la potencia de 0 a 100 %. dt en segundos.
  float calcular(float sp, float t, float dt) {
    float error = sp - t;

    // D: sobre la MEDICIÓN (no da un "salto" cuando cambias el ajuste)
    float dTdt = isnan(tAnterior) ? 0 : (t - tAnterior) / dt;
    tAnterior = t;
    derivada += 0.3 * (dTdt - derivada);   // filtro: el MAX6675 mide en pasos de 0.25 °C

    float p = kp * error;
    float d = -kd * derivada;

    // I con anti-windup: no acumula si la salida ya está al tope en esa dirección
    float tentativa = p + integral + ki * error * dt + d;
    bool topeArriba = tentativa > 100 && error > 0;
    bool topeAbajo  = tentativa < 0   && error < 0;
    if (!topeArriba && !topeAbajo) integral += ki * error * dt;
    integral = constrain(integral, 0, 100);

    return constrain(p + integral + d, 0, 100);
  }
};

ControlPID pid[NUM_ZONAS];

// ---------------- Datos compartidos entre las 2 tareas ----------------
// "candado" evita que una tarea lea a medias lo que la otra está escribiendo.
portMUX_TYPE candado = portMUX_INITIALIZER_UNLOCKED;

// Los escribe loop() (respuesta del servidor), los lee la tarea de control:
float ajuste[NUM_ZONAS] = { 60, 60 };   // se reemplaza con lo que mande el servidor
bool  sistemaOn = false;                // empieza APAGADO hasta que el servidor diga otra cosa
unsigned long ultimaRespuestaOk = 0;    // 0 = todavía no hay respuesta

// Los escribe la tarea de control, los lee loop() para mandarlos:
float temp[NUM_ZONAS]     = { NAN, NAN };
float potencia[NUM_ZONAS] = { 0, 0 };   // % de 0 a 100
char  alarma[160] = "";

unsigned long ultimoEnvio = 0;

// ---------------- Hardware ----------------
void ponerSSR(int zona, bool encender) {
  digitalWrite(PIN_SSR[zona], encender ? SSR_ENCENDIDO : !SSR_ENCENDIDO);
}

// Lee los 16 bits de un MAX6675 (los 2 comparten SCK y SO)
uint16_t leerMAX6675(int pinCS) {
  digitalWrite(pinCS, LOW);
  delayMicroseconds(10);
  uint16_t v = 0;
  for (int i = 15; i >= 0; i--) {
    digitalWrite(PIN_SCK, LOW);
    delayMicroseconds(10);
    if (digitalRead(PIN_SO)) v |= (1 << i);
    digitalWrite(PIN_SCK, HIGH);
    delayMicroseconds(10);
  }
  digitalWrite(pinCS, HIGH);
  return v;
}

// Devuelve °C, o NAN si hay falla (y en "motivo" explica cuál)
float leerTermopar(int zona, const char** motivo) {
  uint16_t raw = leerMAX6675(PIN_CS[zona]);
  if (raw == 0x0000 || raw == 0xFFFF) { *motivo = "sin comunicacion con su MAX6675"; return NAN; }
  if (raw & 0x0004)                   { *motivo = "termopar desconectado";           return NAN; }
  return (raw >> 3) * 0.25;
}

// ---------------- Tarea de control (PID + SSR) ----------------
void calcularControl(float dt) {
  // Copia de lo que mandó el servidor
  float sp[NUM_ZONAS];
  bool on;
  unsigned long ultResp;
  taskENTER_CRITICAL(&candado);
  for (int i = 0; i < NUM_ZONAS; i++) sp[i] = ajuste[i];
  on = sistemaOn;
  ultResp = ultimaRespuestaOk;
  taskEXIT_CRITICAL(&candado);

  bool sinServidor = (ultResp == 0) || (millis() - ultResp > TIMEOUT_SERVIDOR_MS);
  char txt[160] = "";
  if (on && sinServidor) strlcat(txt, "Sin comunicacion con el servidor: resistencias apagadas. ", sizeof(txt));

  float t[NUM_ZONAS], pot[NUM_ZONAS];
  for (int i = 0; i < NUM_ZONAS; i++) {
    const char* motivo = "";
    t[i] = leerTermopar(i, &motivo);
    char linea[80] = "";

    if (!on || sinServidor) {
      pot[i] = 0; pid[i].reiniciar();
    } else if (isnan(t[i])) {
      pot[i] = 0; pid[i].reiniciar();
      snprintf(linea, sizeof(linea), "Zona %d: %s. ", i + 1, motivo);
    } else if (t[i] >= T_MAX_SEGURIDAD) {
      pot[i] = 0; pid[i].reiniciar();
      snprintf(linea, sizeof(linea), "Zona %d sobre %.0f C: resistencia apagada. ", i + 1, T_MAX_SEGURIDAD);
    } else {
      pot[i] = pid[i].calcular(sp[i], t[i], dt);
    }
    // Aunque el sistema esté apagado, avisa si un termopar falla
    if (!linea[0] && isnan(t[i])) snprintf(linea, sizeof(linea), "Zona %d: %s. ", i + 1, motivo);
    strlcat(txt, linea, sizeof(txt));
  }

  taskENTER_CRITICAL(&candado);
  for (int i = 0; i < NUM_ZONAS; i++) { temp[i] = t[i]; potencia[i] = pot[i]; }
  memcpy(alarma, txt, sizeof(alarma));
  taskEXIT_CRITICAL(&candado);
}

void tareaControl(void*) {
  TickType_t marca = xTaskGetTickCount();
  unsigned long ultimoPID = millis();
  calcularControl(PERIODO_PID_MS / 1000.0);
  unsigned long inicioVentana = millis();

  for (;;) {
    unsigned long ahora = millis();
    if (ahora - ultimoPID >= PERIODO_PID_MS) {
      calcularControl((ahora - ultimoPID) / 1000.0);
      ultimoPID = ahora;
    }

    // Salida proporcional en el tiempo. La zona 2 va desfasada media
    // ventana para que las 2 resistencias no arranquen al mismo instante.
    while (ahora - inicioVentana >= VENTANA_MS) inicioVentana += VENTANA_MS;
    for (int i = 0; i < NUM_ZONAS; i++) {
      unsigned long fase = (ahora - inicioVentana + i * VENTANA_MS / NUM_ZONAS) % VENTANA_MS;
      unsigned long tiempoOn = (unsigned long)(potencia[i] / 100.0 * VENTANA_MS);
      ponerSSR(i, fase < tiempoOn);
    }
    vTaskDelayUntil(&marca, pdMS_TO_TICKS(10));
  }
}

// ---------------- Comunicación con el servidor ----------------
void startAccessPoint() {
  WiFi.mode(WIFI_AP);
  WiFi.softAPConfig(AP_IP, AP_GATEWAY, AP_SUBNET);
  WiFi.softAP(AP_SSID, AP_PASSWORD);
  Serial.printf("Red WiFi creada: %s   IP del ESP32: %s\n",
                AP_SSID, WiFi.softAPIP().toString().c_str());
}

void agregarValor(JsonDocument& doc, const char* clave, float v, float escala) {
  if (isnan(v)) doc[clave] = nullptr;
  else doc[clave] = roundf(v * escala) / escala;
}

void enviarYRecibirAjustes() {
  // Copia de lo que midió la tarea de control
  float t[NUM_ZONAS], pot[NUM_ZONAS], sp[NUM_ZONAS];
  bool on;
  char txt[160];
  taskENTER_CRITICAL(&candado);
  for (int i = 0; i < NUM_ZONAS; i++) { t[i] = temp[i]; pot[i] = potencia[i]; sp[i] = ajuste[i]; }
  on = sistemaOn;
  memcpy(txt, alarma, sizeof(txt));
  taskEXIT_CRITICAL(&candado);

  Serial.printf("Z1 %.2f°C pot %5.1f%% | Z2 %.2f°C pot %5.1f%% | ajustes %.1f/%.1f | sistema %s %s\n",
                t[0], pot[0], t[1], pot[1], sp[0], sp[1], on ? "ENCENDIDO" : "apagado", txt);

  if (WiFi.softAPgetStationNum() == 0) {
    Serial.println("Nadie conectado a la red HMI-ESP32 todavia (la laptop debe conectarse).");
    return;
  }

  JsonDocument doc;
  doc["device_id"] = DEVICE_ID;
  doc["device_ts"] = millis();
  agregarValor(doc, "t_z1", t[0], 100);
  agregarValor(doc, "t_z2", t[1], 100);
  agregarValor(doc, "pot1", pot[0], 10);   // potencia PID en %
  agregarValor(doc, "pot2", pot[1], 10);
  doc["ssr1"] = pot[0] > 0 ? 1 : 0;        // 1 = la resistencia está calentando
  doc["ssr2"] = pot[1] > 0 ? 1 : 0;
  doc["presion"] = nullptr;                // sin sensor de presión por ahora
  doc["sistema_on"] = on ? 1 : 0;
  doc["alarma"] = txt;
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
      JsonObject s = resp["setpoints"];
      float nuevo1 = constrain((float)(s["sp_z1"] | sp[0]), SP_MIN, SP_MAX);
      float nuevo2 = constrain((float)(s["sp_z2"] | sp[1]), SP_MIN, SP_MAX);
      bool nuevoOn = (s["sistema_on"] | 0) == 1;
      taskENTER_CRITICAL(&candado);
      ajuste[0] = nuevo1;
      ajuste[1] = nuevo2;
      sistemaOn = nuevoOn;
      ultimaRespuestaOk = millis();
      taskEXIT_CRITICAL(&candado);
    }
  } else {
    Serial.printf("Error al enviar (HTTP %d). ¿Esta encendido el servidor en la laptop?\n", code);
  }
  http.end();
}

// ---------------- Programa ----------------
void setup() {
  // Lo primero: resistencias apagadas
  for (int i = 0; i < NUM_ZONAS; i++) {
    pinMode(PIN_SSR[i], OUTPUT);
    ponerSSR(i, false);
  }
  // MAX6675
  pinMode(PIN_SCK, OUTPUT);
  digitalWrite(PIN_SCK, LOW);
  pinMode(PIN_SO, INPUT_PULLUP);
  for (int i = 0; i < NUM_ZONAS; i++) {
    pinMode(PIN_CS[i], OUTPUT);
    digitalWrite(PIN_CS[i], HIGH);
    pid[i].kp = KP[i]; pid[i].ki = KI[i]; pid[i].kd = KD[i];
  }

  Serial.begin(115200);
  delay(500);   // el MAX6675 tarda ~0.25 s en su primera medición
  Serial.println("\n=== Extractor de liquidos presurizados — ESP32 v4 (PID) ===");
  startAccessPoint();

  // Tarea de control: prioridad más alta que loop(), en el mismo núcleo
  xTaskCreatePinnedToCore(tareaControl, "control", 4096, NULL, 2, NULL, 1);
}

void loop() {
  unsigned long ahora = millis();
  if (ahora - ultimoEnvio >= INTERVALO_ENVIO_MS) {
    ultimoEnvio = ahora;
    enviarYRecibirAjustes();
  }
  delay(10);
}
