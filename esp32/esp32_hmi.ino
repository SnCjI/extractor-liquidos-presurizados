/*
  esp32_hmi.ino
  ---------------------------------------------------------
  Lee temperatura, presión y humedad de un sensor BME280 y las
  envía por WiFi (HTTP POST, JSON) al backend del HMI.

  MODO ACCESS POINT: el ESP32 NO se conecta a tu router — es al
  revés, el propio ESP32 crea una red WiFi propia. Tu laptop (con
  el servidor Node.js/SQLite) y el celular Android se conectan a
  esa red del ESP32, no hay router de por medio.

  Librerías necesarias (Arduino IDE > Administrador de librerías):
    - "Adafruit BME280 Library" (Adafruit)
    - "Adafruit Unified Sensor" (Adafruit)

  Conexión BME280 (I2C) a un ESP32 típico:
    VIN  -> 3V3
    GND  -> GND
    SCL  -> GPIO 22
    SDA  -> GPIO 21

  Si usas otro sensor (DHT22, BMP280, etc.) solo cambia el
  bloque "LECTURA DE SENSOR" más abajo.
  ---------------------------------------------------------
*/

#include <WiFi.h>
#include <HTTPClient.h>
#include <Wire.h>
#include <Adafruit_Sensor.h>
#include <Adafruit_BME280.h>

// ------------------- CONFIGURACIÓN -------------------

// Nombre y contraseña de la red WiFi que el ESP32 va a crear.
// La contraseña debe tener 8 caracteres o más.
const char* AP_SSID     = "HMI-ESP32";
const char* AP_PASSWORD = "extraccion2024";

// IP fija del ESP32 dentro de su propia red (no la cambies salvo
// que también cambies las instrucciones de la laptop más abajo).
IPAddress AP_IP(192, 168, 4, 1);
IPAddress AP_GATEWAY(192, 168, 4, 1);
IPAddress AP_SUBNET(255, 255, 255, 0);

// IP que le vas a poner MANUALMENTE a la laptop dentro de esta
// misma red (ver README: "Configurar IP fija en la laptop").
// El servidor Node.js (server.js) debe estar corriendo ahí.
const char* SERVER_URL   = "http://192.168.4.2:3000/api/data";

// Debe coincidir con DEVICE_KEY en server.js
const char* DEVICE_KEY   = "cambia-esta-clave";
const char* DEVICE_ID    = "esp32-planta-1";

// Cada cuánto se envía una lectura (ms)
const unsigned long SEND_INTERVAL_MS = 5000;

// -------------------------------------------------------

Adafruit_BME280 bme;
unsigned long lastSend = 0;

void startAccessPoint() {
  WiFi.mode(WIFI_AP);
  WiFi.softAPConfig(AP_IP, AP_GATEWAY, AP_SUBNET);
  WiFi.softAP(AP_SSID, AP_PASSWORD);

  Serial.println();
  Serial.println("=== ESP32 en modo Access Point ===");
  Serial.print("Red WiFi creada: "); Serial.println(AP_SSID);
  Serial.print("IP del ESP32:    "); Serial.println(WiFi.softAPIP());
  Serial.println("Conecta tu laptop y tu celular a esta red WiFi.");
}

void setup() {
  Serial.begin(115200);
  delay(300);

  Wire.begin(21, 22); // SDA, SCL
  if (!bme.begin(0x76)) {          // algunos módulos usan 0x77
    Serial.println("No se encontró el BME280. Revisa el cableado / dirección I2C.");
    while (1) delay(1000);
  }

  startAccessPoint();
}

void sendReading(float tempC, float presHpa, float humPct) {
  // Solo tiene sentido mandar el dato si ya hay al menos un
  // dispositivo conectado a la red del ESP32 (idealmente la laptop).
  if (WiFi.softAPgetStationNum() == 0) {
    Serial.println("Nadie conectado todavía a la red del ESP32, no se envía.");
    return;
  }

  HTTPClient http;
  http.begin(SERVER_URL);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-device-key", DEVICE_KEY);

  String payload = "{";
  payload += "\"device_id\":\"" + String(DEVICE_ID) + "\",";
  payload += "\"device_ts\":" + String(millis()) + ",";
  payload += "\"temperature\":" + String(tempC, 2) + ",";
  payload += "\"pressure\":" + String(presHpa, 2) + ",";
  payload += "\"humidity\":" + String(humPct, 2);
  payload += "}";

  int code = http.POST(payload);

  if (code > 0) {
    Serial.printf("POST enviado, respuesta HTTP %d\n", code);
  } else {
    Serial.printf("Error al enviar POST (¿está corriendo server.js en la laptop?): %s\n", http.errorToString(code).c_str());
  }

  http.end();
}

void loop() {
  if (millis() - lastSend >= SEND_INTERVAL_MS) {
    lastSend = millis();

    // ---------------- LECTURA DE SENSOR ----------------
    float tempC   = bme.readTemperature();       // °C
    float presHpa = bme.readPressure() / 100.0F;  // Pa -> hPa
    float humPct  = bme.readHumidity();           // %HR
    // -----------------------------------------------------

    Serial.printf("T=%.2f C  P=%.2f hPa  H=%.2f %%  (%d dispositivo(s) conectado(s))\n",
                  tempC, presHpa, humPct, WiFi.softAPgetStationNum());
    sendReading(tempC, presHpa, humPct);
  }
}
