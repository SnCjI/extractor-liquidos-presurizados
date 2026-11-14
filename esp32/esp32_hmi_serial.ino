/*
  esp32_hmi_serial.ino
  ---------------------------------------------------------
  Variante SERIAL (USB) del firmware del HMI.

  A diferencia de esp32_hmi.ino (que manda los datos por WiFi),
  esta versión NO USA WIFI PARA NADA. El ESP32 se queda conectado
  por el cable USB a tu laptop/PC (el mismo cable con el que lo
  programas) y simplemente imprime una línea JSON por Serial cada
  cierto tiempo:

      {"device_id":"esp32-serial-usb","device_ts":12345,"temperature":24.71,"pressure":1013.20,"humidity":55.30}

  Del lado de la laptop, el script "serial-bridge.js" (carpeta
  server/) lee esas líneas y las reenvía al mismo servidor
  Node.js/SQLite que ya tienes, usando el endpoint /api/data.

  Ventajas de este modo:
    - No depende de WiFi para nada (ni router, ni Access Point).
    - Más simple y más difícil que falle la conexión.
  Desventaja:
    - El ESP32 tiene que quedar físicamente conectado por cable
      USB a la computadora donde corre el servidor. No sirve para
      verlo desde el celular directamente desde el ESP32 (aunque
      la página web sigue funcionando igual para cualquier
      dispositivo en la misma red que la laptop).

  Librerías necesarias (Arduino IDE > Administrador de librerías):
    - "Adafruit BME280 Library" (Adafruit)
    - "Adafruit Unified Sensor" (Adafruit)

  Conexión BME280 (I2C) a un ESP32 típico:
    VIN  -> 3V3
    GND  -> GND
    SCL  -> GPIO 22
    SDA  -> GPIO 21
  ---------------------------------------------------------
*/

#include <Wire.h>
#include <Adafruit_Sensor.h>
#include <Adafruit_BME280.h>

// ------------------- CONFIGURACIÓN -------------------

// Debe coincidir con la velocidad que uses en serial-bridge.js
// (SERIAL_BAUD, por defecto 115200)
const unsigned long SERIAL_BAUD = 115200;

// Identificador de este dispositivo (se guarda junto con cada
// lectura en la base de datos, útil si más adelante tienes
// varios ESP32).
const char* DEVICE_ID = "esp32-serial-usb";

// Cada cuánto se manda una lectura (ms)
const unsigned long SEND_INTERVAL_MS = 5000;

// -------------------------------------------------------

Adafruit_BME280 bme;
unsigned long lastSend = 0;

void setup() {
  Serial.begin(SERIAL_BAUD);
  delay(300);

  Wire.begin(21, 22); // SDA, SCL

  // Mensajes de arranque van SIN llaves { } para que el bridge
  // los distinga de una lectura JSON y solo los muestre como log.
  Serial.println("Iniciando ESP32 (modo Serial/USB)...");

  if (!bme.begin(0x76)) {           // algunos módulos usan 0x77
    Serial.println("No se encontro el BME280. Revisa el cableado / direccion I2C.");
    while (1) delay(1000);
  }

  Serial.println("BME280 listo. Enviando lecturas por USB cada 5 segundos.");
  Serial.println("Conecta este puerto con serial-bridge.js en tu laptop.");
}

void loop() {
  if (millis() - lastSend >= SEND_INTERVAL_MS) {
    lastSend = millis();

    // ---------------- LECTURA DE SENSOR ----------------
    float tempC   = bme.readTemperature();        // °C
    float presHpa = bme.readPressure() / 100.0F;   // Pa -> hPa
    float humPct  = bme.readHumidity();            // %HR
    // -----------------------------------------------------

    // Construye la línea JSON y la imprime en UNA sola línea
    // (println añade el salto de línea que el bridge necesita
    // para saber dónde termina cada lectura).
    String payload = "{";
    payload += "\"device_id\":\"" + String(DEVICE_ID) + "\",";
    payload += "\"device_ts\":" + String(millis()) + ",";
    payload += "\"temperature\":" + String(tempC, 2) + ",";
    payload += "\"pressure\":" + String(presHpa, 2) + ",";
    payload += "\"humidity\":" + String(humPct, 2);
    payload += "}";

    Serial.println(payload);
  }
}
