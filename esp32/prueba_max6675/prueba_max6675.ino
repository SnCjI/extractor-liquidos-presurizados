// prueba_max6675.ino
// PRUEBA SOLO DEL SENSOR DE TEMPERATURA: termopar tipo K + modulo MAX6675.
// No necesita librerias. Abre el Monitor Serie a 115200 baudios.
//
// Conexiones (modulo MAX6675 -> ESP32):
//   VCC -> 3V3     (NO a 5V: el ESP32 no aguanta 5 V en sus pines)
//   GND -> GND
//   SCK -> GPIO 18
//   CS  -> GPIO 5
//   SO  -> GPIO 19

const int PIN_SO  = 19;
const int PIN_SCK = 18;
const int PIN_CS  = 5;

// Lee los 16 bits que manda el MAX6675
uint16_t leerMAX6675() {
  digitalWrite(PIN_CS, LOW);
  delayMicroseconds(10);
  uint16_t v = 0;
  for (int i = 15; i >= 0; i--) {
    digitalWrite(PIN_SCK, LOW);
    delayMicroseconds(10);
    if (digitalRead(PIN_SO)) v |= (1 << i);
    digitalWrite(PIN_SCK, HIGH);
    delayMicroseconds(10);
  }
  digitalWrite(PIN_CS, HIGH);
  return v;
}

void setup() {
  Serial.begin(115200);
  pinMode(PIN_CS, OUTPUT);
  pinMode(PIN_SCK, OUTPUT);
  pinMode(PIN_SO, INPUT_PULLUP);  // si nadie maneja SO, se lee 1 (ayuda al diagnostico)
  digitalWrite(PIN_CS, HIGH);
  digitalWrite(PIN_SCK, LOW);
  delay(500);  // el MAX6675 necesita ~0.25 s para su primera medicion
  Serial.println();
  Serial.println("=== Prueba termopar tipo K + MAX6675 ===");
}

void loop() {
  uint16_t raw = leerMAX6675();

  Serial.print("[dato crudo 0x");
  Serial.print(raw, HEX);
  Serial.print("]  ");

  if (raw == 0xFFFF) {
    Serial.println("El modulo NO contesta: revisa VCC->3V3, GND->GND, SO->GPIO19 y CS->GPIO5.");
  } else if (raw == 0x0000) {
    Serial.println("El modulo contesta pero no recibe reloj: revisa SCK->GPIO18 (y que tenga 3.3 V).");
  } else if (raw & 0x0004) {
    Serial.println("Termopar DESCONECTADO: revisa los tornillos + y - del modulo.");
  } else {
    float tempC = (raw >> 3) * 0.25;
    Serial.print("Temperatura: ");
    Serial.print(tempC, 2);
    Serial.println(" C");
  }

  delay(500);  // no leer mas rapido que cada 250 ms
}
