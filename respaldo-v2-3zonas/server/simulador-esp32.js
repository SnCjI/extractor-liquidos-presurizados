// simulador-esp32.js — Se hace pasar por el ESP32 del extractor para probar
// el HMI SIN tener el hardware conectado.
//
// Hace exactamente lo mismo que el firmware (esp32_extractor.ino):
//   - manda las temperaturas de las 3 zonas al servidor cada 2 segundos,
//   - recibe los set-points que el operador puso en el HMI,
//   - enciende/apaga cada resistencia con la misma regla (histéresis),
//   - aplica los mismos límites de seguridad.
// Las temperaturas se calculan con un modelo térmico sencillo: con la
// resistencia encendida la zona se calienta; apagada, se enfría hacia
// la temperatura ambiente.
//
// Uso:  simular-esp32.bat     (o  node simulador-esp32.js)
//       Con el servidor ya encendido en otra ventana.

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3000/api/data';
const DEVICE_KEY = process.env.DEVICE_KEY || 'cambia-esta-clave';
const INTERVALO_MS = 2000;

// Mismos valores que en el firmware
const HISTERESIS = 1.5;          // °C
const T_MAX_SEGURIDAD = 125;     // °C: por encima, resistencia apagada siempre
const TIMEOUT_SERVIDOR_MS = 15000;

// Modelo térmico (por zona): ganancia al calentar y pérdida al ambiente.
const AMBIENTE = 24;
const zonas = [
  { t: 24.0, ssr: 0, calor: 1.6, perdida: 0.012 },
  { t: 24.5, ssr: 0, calor: 1.4, perdida: 0.011 },
  { t: 23.8, ssr: 0, calor: 1.2, perdida: 0.010 },
];

let setpoints = { sp_z1: 60, sp_z2: 60, sp_z3: 60, sistema_on: 0 };
let ultimaRespuesta = 0;

function paso() {
  const ahora = Date.now();
  const sinServidor = ahora - ultimaRespuesta > TIMEOUT_SERVIDOR_MS && ultimaRespuesta !== 0;
  const alarmas = [];
  if (sinServidor) alarmas.push('Sin comunicación con el servidor: resistencias apagadas');

  const sp = [setpoints.sp_z1, setpoints.sp_z2, setpoints.sp_z3];
  zonas.forEach((z, i) => {
    // --- control (igual que en el ESP32) ---
    if (!setpoints.sistema_on || sinServidor) {
      z.ssr = 0;
    } else if (z.t >= T_MAX_SEGURIDAD) {
      z.ssr = 0;
      alarmas.push(`Zona ${i + 1} sobre ${T_MAX_SEGURIDAD} °C`);
    } else if (z.t < sp[i] - HISTERESIS) {
      z.ssr = 1;
    } else if (z.t > sp[i] + HISTERESIS) {
      z.ssr = 0;
    } // dentro de la banda: se queda como estaba

    // --- física simulada ---
    const dt = INTERVALO_MS / 1000;
    z.t += (z.ssr ? z.calor : 0) * dt * 0.6 - z.perdida * (z.t - AMBIENTE) * dt;
    z.t += (Math.random() - 0.5) * 0.15; // ruido de la sonda
  });

  return {
    device_id: 'esp32-simulado',
    device_ts: Math.round(process.uptime() * 1000),
    t_z1: +zonas[0].t.toFixed(2), t_z2: +zonas[1].t.toFixed(2), t_z3: +zonas[2].t.toFixed(2),
    ssr1: zonas[0].ssr, ssr2: zonas[1].ssr, ssr3: zonas[2].ssr,
    presion: null,
    sistema_on: setpoints.sistema_on && !sinServidor ? 1 : 0,
    alarma: alarmas.join('; '),
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
    const est = (z) => (z ? 'ON ' : 'off');
    console.log(
      `Z1 ${datos.t_z1.toFixed(1)}°C [${est(datos.ssr1)}]  ` +
      `Z2 ${datos.t_z2.toFixed(1)}°C [${est(datos.ssr2)}]  ` +
      `Z3 ${datos.t_z3.toFixed(1)}°C [${est(datos.ssr3)}]  ` +
      `| ajustes ${setpoints.sp_z1}/${setpoints.sp_z2}/${setpoints.sp_z3} °C ` +
      `| sistema ${setpoints.sistema_on ? 'ENCENDIDO' : 'apagado'}`
    );
  } catch (e) {
    console.log('No se pudo contactar al servidor (' + e.message + '). ¿Está encendido?');
  }
}

console.log('Simulador del ESP32 del extractor — enviando a', SERVER_URL);
console.log('Abre el HMI, enciende el sistema y cambia los ajustes para ver la reacción.');
console.log('Para detenerlo: Ctrl + C\n');
enviar();
setInterval(enviar, INTERVALO_MS);
