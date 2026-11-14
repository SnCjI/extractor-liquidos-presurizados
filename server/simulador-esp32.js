// simulador-esp32.js — Se hace pasar por el ESP32 del extractor para probar
// el HMI SIN tener el hardware conectado.
//
// Hace lo mismo que el firmware (esp32_extractor.ino v4):
//   - manda las temperaturas y la potencia de las 2 zonas cada 2 segundos,
//   - recibe los set-points que el operador puso en el HMI,
//   - calcula la potencia de cada resistencia con el MISMO control PID
//     (mismas ganancias, anti-windup y derivada filtrada),
//   - aplica los mismos límites de seguridad.
// Las temperaturas se calculan con un modelo térmico sencillo: la zona se
// calienta según la potencia y se enfría hacia la temperatura ambiente.
//
// Uso:  simular-esp32.bat     (o  node simulador-esp32.js)
//       Con el servidor ya encendido en otra ventana.

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3000/api/data';
const DEVICE_KEY = process.env.DEVICE_KEY || 'cambia-esta-clave';
const INTERVALO_MS = 2000;

// Mismos valores que en el firmware
const KP = 5.0, KI = 0.05, KD = 10.0;
const T_MAX_SEGURIDAD = 105;     // °C: por encima, resistencia apagada siempre
const TIMEOUT_SERVIDOR_MS = 15000;

// ---------- PID (igual que ControlPID en el firmware) ----------
class ControlPID {
  constructor(kp, ki, kd) { this.kp = kp; this.ki = ki; this.kd = kd; this.reiniciar(); }
  reiniciar() { this.integral = 0; this.tAnterior = null; this.derivada = 0; }
  calcular(sp, t, dt) {
    const error = sp - t;
    const dTdt = this.tAnterior === null ? 0 : (t - this.tAnterior) / dt;
    this.tAnterior = t;
    this.derivada += 0.3 * (dTdt - this.derivada);
    const p = this.kp * error;
    const d = -this.kd * this.derivada;
    const tentativa = p + this.integral + this.ki * error * dt + d;
    const topeArriba = tentativa > 100 && error > 0;
    const topeAbajo = tentativa < 0 && error < 0;
    if (!topeArriba && !topeAbajo) this.integral += this.ki * error * dt;
    this.integral = Math.min(100, Math.max(0, this.integral));
    return Math.min(100, Math.max(0, p + this.integral + d));
  }
}

// Modelo térmico (por zona): °C/s a potencia completa y pérdida al ambiente.
// "medida" va un poco atrasada de "real", como un termopar dentro del equipo.
const AMBIENTE = 24;
const zonas = [
  { real: 24.0, medida: 24.0, pot: 0, calor: 0.9, perdida: 0.008, pid: new ControlPID(KP, KI, KD) }, // zona 1 (superior)
  { real: 23.8, medida: 23.8, pot: 0, calor: 0.75, perdida: 0.007, pid: new ControlPID(KP, KI, KD) }, // zona 2 (inferior)
];

let setpoints = { sp_z1: 60, sp_z2: 60, sistema_on: 0 };
let ultimaRespuesta = 0;

// Un segundo de "vida" del equipo: física + PID (el firmware calcula cada 1 s)
function segundo(sinServidor, alarmas) {
  const sp = [setpoints.sp_z1, setpoints.sp_z2];
  zonas.forEach((z, i) => {
    // física en pasos de 0.1 s con la potencia actual
    for (let k = 0; k < 10; k++) {
      z.real += (z.calor * z.pot / 100 - z.perdida * (z.real - AMBIENTE)) * 0.1;
      z.medida += (z.real - z.medida) / 8 * 0.1;
    }
    // el MAX6675 mide en pasos de 0.25 °C
    const t = Math.round((z.medida + (Math.random() - 0.5) * 0.2) * 4) / 4;
    z.t = t;
    if (!setpoints.sistema_on || sinServidor) {
      z.pot = 0; z.pid.reiniciar();
    } else if (t >= T_MAX_SEGURIDAD) {
      z.pot = 0; z.pid.reiniciar();
      alarmas.add(`Zona ${i + 1} sobre ${T_MAX_SEGURIDAD} C: resistencia apagada.`);
    } else {
      z.pot = z.pid.calcular(sp[i], t, 1);
    }
  });
}

function paso() {
  const sinServidor = ultimaRespuesta === 0 || Date.now() - ultimaRespuesta > TIMEOUT_SERVIDOR_MS;
  const alarmas = new Set();
  if (sinServidor && setpoints.sistema_on) alarmas.add('Sin comunicacion con el servidor: resistencias apagadas.');
  for (let s = 0; s < INTERVALO_MS / 1000; s++) segundo(sinServidor, alarmas);

  const r1 = (v) => Math.round(v * 10) / 10;
  return {
    device_id: 'esp32-simulado',
    device_ts: Math.round(process.uptime() * 1000),
    t_z1: zonas[0].t, t_z2: zonas[1].t,
    pot1: r1(zonas[0].pot), pot2: r1(zonas[1].pot),
    ssr1: zonas[0].pot > 0 ? 1 : 0, ssr2: zonas[1].pot > 0 ? 1 : 0,
    presion: null,
    sistema_on: setpoints.sistema_on ? 1 : 0,
    alarma: [...alarmas].join(' '),
  };
}

async function enviar() {
  const datos = paso();
  try {
    const res = await fetch(SERVER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-device-key': DEVICE_KEY },
      body: JSON.stringify(datos),
    });
    const r = await res.json();
    if (r.ok && r.setpoints) {
      setpoints = r.setpoints;
      ultimaRespuesta = Date.now();
    }
    const pot = (p) => String(p.toFixed(0)).padStart(3) + ' %';
    console.log(
      `Z1 ${datos.t_z1.toFixed(2)}°C pot ${pot(datos.pot1)}   ` +
      `Z2 ${datos.t_z2.toFixed(2)}°C pot ${pot(datos.pot2)}  ` +
      `| ajustes ${setpoints.sp_z1}/${setpoints.sp_z2} °C ` +
      `| sistema ${setpoints.sistema_on ? 'ENCENDIDO' : 'apagado'}`
    );
  } catch (e) {
    console.log('No se pudo contactar al servidor (' + e.message + '). ¿Está encendido?');
  }
}

console.log('Simulador del ESP32 del extractor (control PID) — enviando a', SERVER_URL);
console.log('Abre el HMI, enciende el sistema y cambia los ajustes para ver la reacción.');
console.log('Para detenerlo: Ctrl + C\n');
enviar();
setInterval(enviar, INTERVALO_MS);
