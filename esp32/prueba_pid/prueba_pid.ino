/*
  prueba_pid.ino — Prueba del CONTROL PID de UNA resistencia
  ---------------------------------------------------------------
  Termopar tipo K + modulo MAX6675  ->  ESP32  ->  SSR-40DA  ->  resistencia
  Sin WiFi y sin servidor: sirve para probar y AFINAR el PID antes de
  usar el programa completo (esp32_extractor.ino).

  CONEXIONES
    MAX6675:  VCC -> 3V3   GND -> GND   SCK -> GPIO 18   CS -> GPIO 5   SO -> GPIO 19
    SSR-40DA (lado de control):  3 (+) -> GPIO 25     4 (-) -> GND
    El lado de 127 V AC (terminales 1 y 2 del SSR) va en serie con la
    resistencia. ¡Conecta y desconecta eso SIEMPRE con la clavija desenchufada!

  COMO SE USA
    1. Sube el programa y abre el Monitor Serie a 115200 baudios.
       Abajo, en la caja de texto, escribe un comando y presiona Enter:
         sp 80      temperatura deseada (de 0 a 100 °C; 80 °C es el maximo recomendado)
         on         enciende el control (la resistencia empieza APAGADA)
         off        apaga la resistencia
         kp 5       cambia la ganancia proporcional   (sin volver a subir el programa)
         ki 0.05    cambia la ganancia integral
         kd 10      cambia la ganancia derivativa
         ?          muestra los valores actuales
    2. Para VER la curva: cierra el Monitor Serie y abre
       Herramientas -> Serial Plotter (115200). Se dibujan 3 lineas:
       Temperatura, Ajuste y Potencia (%).

  QUE HACE EL PID
    Cada segundo compara la temperatura con el ajuste y calcula una
    POTENCIA de 0 a 100 %. El SSR se prende esa fraccion de cada ventana
    de 2 s (ej. 25 % = 0.5 s encendido y 1.5 s apagado).
      P (kp): reacciona a que tan lejos esta del ajuste.
      I (ki): corrige el error que queda con el tiempo (para que llegue exacto).
      D (kd): frena cuando la temperatura sube muy rapido (evita pasarse).

  SEGURIDAD: si el termopar falla o la temperatura pasa de 105 °C,
  la resistencia se apaga sola.
  ---------------------------------------------------------------
*/

// ---------------- Pines ----------------
const int PIN_SO  = 19;
const int PIN_SCK = 18;
const int PIN_CS  = 5;
const int PIN_SSR = 25;
const int SSR_ENCENDIDO = LOW // si tu SSR enciende con LOW, cambia a LOW

// ---------------- Ajustes ----------------
const float SP_MIN = 0.0;              // °C
const float SP_MAX = 100.0;            // °C
const float SP_RECOMENDADO = 80.0;     // °C, temperatura maxima de trabajo recomendada
const float T_MAX_SEGURIDAD = 105.0;   // °C: por encima, resistencia apagada siempre
const unsigned long PERIODO_PID_MS = 1000;   // cada cuanto se calcula el PID
const unsigned long VENTANA_MS     = 2000;   // ventana de encendido del SSR

float ajuste = 80.0;      // °C deseados
bool  controlOn = false;  // empieza APAGADO: escribe "on" para empezar

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

    // D: sobre la MEDICION (no da un "salto" cuando cambias el ajuste)
    float dTdt = isnan(tAnterior) ? 0 : (t - tAnterior) / dt;
    tAnterior = t;
    derivada += 0.3 * (dTdt - derivada);   // filtro: el MAX6675 mide en pasos de 0.25 °C

    float p = kp * error;
    float d = -kd * derivada;

    // I con anti-windup: no acumula si la salida ya esta al tope en esa direccion
    float tentativa = p + integral + ki * error * dt + d;
    bool topeArriba = tentativa > 100 && error > 0;
    bool topeAbajo  = tentativa < 0   && error < 0;
    if (!topeArriba && !topeAbajo) integral += ki * error * dt;
    integral = constrain(integral, 0, 100);

    return constrain(p + integral + d, 0, 100);
  }
};

ControlPID pid = { 5.0, 0.05, 10.0 };   // kp, ki, kd iniciales (ajustalos con tu equipo)

float temperatura = NAN;
float potencia = 0;          // %
String estado = "";
unsigned long ultimoPID = 0, inicioVentana = 0;

// ---------------- MAX6675 ----------------
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

// Devuelve °C, o NAN si hay falla (y explica cual en "estado")
float leerTermopar() {
  uint16_t raw = leerMAX6675();
  if (raw == 0x0000 || raw == 0xFFFF) { estado = "SIN COMUNICACION CON MAX6675"; return NAN; }
  if (raw & 0x0004)                   { estado = "TERMOPAR DESCONECTADO";      return NAN; }
  return (raw >> 3) * 0.25;
}

void ponerSSR(bool encender) {
  digitalWrite(PIN_SSR, encender ? SSR_ENCENDIDO : !SSR_ENCENDIDO);
}

// ---------------- Comandos por el Monitor Serie ----------------
void mostrarAjustes() {
  Serial.printf("# Ajuste %.1f C | control %s | kp %.3f  ki %.4f  kd %.3f\n",
                ajuste, controlOn ? "ENCENDIDO" : "apagado", pid.kp, pid.ki, pid.kd);
}

void leerComando() {
  if (!Serial.available()) return;
  String linea = Serial.readStringUntil('\n');
  linea.trim();
  linea.toLowerCase();
  if (linea.length() == 0) return;

  // Acepta "sp 80" y tambien "sp80" (sin espacio)
  int espacio = linea.indexOf(' ');
  if (espacio < 0) {
    for (int i = 0; i < (int)linea.length(); i++) {
      char c = linea[i];
      if (isdigit(c) || c == '.' || c == '-') { espacio = i; break; }
    }
  }
  String cmd = espacio < 0 ? linea : linea.substring(0, espacio);
  cmd.trim();
  float valor = espacio < 0 ? NAN : linea.substring(espacio + (linea[espacio] == ' ' ? 1 : 0)).toFloat();

  if (cmd == "on") {
    pid.reiniciar();
    controlOn = true;
  } else if (cmd == "off") {
    controlOn = false;
  } else if (cmd == "sp" && !isnan(valor)) {
    if (valor < SP_MIN || valor > SP_MAX) {
      Serial.printf("# El ajuste debe estar entre %.0f y %.0f C\n", SP_MIN, SP_MAX);
      return;
    }
    ajuste = valor;
    if (ajuste > SP_RECOMENDADO) {
      Serial.printf("# AVISO: %.1f C esta arriba del maximo recomendado (%.0f C)\n", ajuste, SP_RECOMENDADO);
    }
  } else if (cmd == "kp" && !isnan(valor) && valor >= 0) {
    pid.kp = valor;
  } else if (cmd == "ki" && !isnan(valor) && valor >= 0) {
    pid.ki = valor;
    pid.integral = 0;
  } else if (cmd == "kd" && !isnan(valor) && valor >= 0) {
    pid.kd = valor;
  } else if (cmd != "?") {
    Serial.println("# Comandos: sp 80 | on | off | kp 5 | ki 0.05 | kd 10 | ?");
    return;
  }
  mostrarAjustes();
}

// ---------------- Programa ----------------
void setup() {
  pinMode(PIN_SSR, OUTPUT);
  ponerSSR(false);                 // lo primero: resistencia apagada
  pinMode(PIN_CS, OUTPUT);
  pinMode(PIN_SCK, OUTPUT);
  pinMode(PIN_SO, INPUT_PULLUP);
  digitalWrite(PIN_CS, HIGH);
  digitalWrite(PIN_SCK, LOW);

  Serial.begin(115200);
  Serial.setTimeout(50);
  delay(500);                      // el MAX6675 tarda ~0.25 s en su primera medicion
  Serial.println();
  Serial.println("# === Prueba PID: termopar K + MAX6675 + SSR ===");
  Serial.println("# Comandos: sp 80 | on | off | kp 5 | ki 0.05 | kd 10 | ?");
  mostrarAjustes();
  inicioVentana = millis();
}

void loop() {
  leerComando();
  unsigned long ahora = millis();

  // 1) Cada segundo: leer temperatura y calcular la potencia
  if (ahora - ultimoPID >= PERIODO_PID_MS) {
    float dt = ultimoPID == 0 ? 1.0 : (ahora - ultimoPID) / 1000.0;
    ultimoPID = ahora;
    estado = "";
    temperatura = leerTermopar();

    if (!controlOn) {
      potencia = 0; pid.reiniciar();
      if (estado == "") estado = "APAGADO (escribe on)";   // si hay falla del termopar, la deja visible
    } else if (isnan(temperatura)) {
      potencia = 0; pid.reiniciar();               // "estado" ya dice la falla
    } else if (temperatura >= T_MAX_SEGURIDAD) {
      potencia = 0; pid.reiniciar(); estado = "SOBRETEMPERATURA: resistencia apagada";
    } else {
      potencia = pid.calcular(ajuste, temperatura, dt);
      estado = "CONTROLANDO";
    }

    // Formato para el Serial Plotter (nombre:valor separados por coma)
    Serial.printf("Temperatura:%.2f,Ajuste:%.1f,Potencia:%.1f\n",
                  isnan(temperatura) ? 0.0 : temperatura, ajuste, potencia);
    if (estado != "CONTROLANDO") Serial.printf("# %s\n", estado.c_str());
  }

  // 2) Todo el tiempo: SSR encendido la fraccion "potencia" de cada ventana de 2 s
  while (ahora - inicioVentana >= VENTANA_MS) inicioVentana += VENTANA_MS;
  ponerSSR((ahora - inicioVentana) < (unsigned long)(potencia / 100.0 * VENTANA_MS));
}
