// calcular-pid.js — Calcula kp, ki y kd para TU equipo a partir de una
// "prueba de escalón" hecha con esp32/prueba_finalpid/prueba_finalpid.ino.
//
// Cómo se usa:
//   1. En prueba_finalpid, con el equipo frío, escribe  pot 40  (potencia fija).
//   2. Déjalo calentar 20-30 min (sin pasar de 80 °C) y escribe  off.
//   3. Copia todo el Monitor Serie (con la marca de tiempo activada) a un
//      archivo de texto, por ejemplo escalon.txt
//   4. En la carpeta server:   node calcular-pid.js escalon.txt
//
// Qué hace:
//   Mide dos cosas de la curva de temperatura:
//     - el RETRASO: cuántos segundos pasan desde que prende la resistencia
//       hasta que el termopar empieza a subir de verdad;
//     - la VELOCIDAD: cuántos °C por segundo sube con esa potencia.
//   Con eso calcula las ganancias con el método SIMC (Skogestad), que está
//   pensado para dar una respuesta firme y sin pasarse del ajuste.
//   Si la curva llegó a estabilizarse, también usa la temperatura final.

const fs = require('fs');

const archivo = process.argv[2];
if (!archivo) {
  console.log('Uso:  node calcular-pid.js escalon.txt');
  process.exit(1);
}

// ---------- 1. Leer el registro del Monitor Serie ----------
// Acepta líneas con o sin la marca de tiempo del Arduino IDE:
//   "12:01:15.123 -> Temperatura:41.25,Ajuste:80.0,Potencia:40.0"
//   "Temperatura:41.25,Ajuste:80.0,Potencia:40.0"
const re = /(?:(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?\s*->\s*)?Temperatura:\s*(-?[\d.]+)\s*,\s*Ajuste:\s*(-?[\d.]+)\s*,\s*Potencia:\s*(-?[\d.]+)/;
const filas = [];
let conHora = 0;
let tAnterior = null, desfase = 0;
for (const linea of fs.readFileSync(archivo, 'utf8').split(/\r?\n/)) {
  const m = linea.match(re);
  if (!m) continue;
  let t;
  if (m[1] !== undefined) {
    conHora++;
    t = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (m[4] ? +('0.' + m[4].padStart(3, '0')) : 0);
    if (tAnterior !== null && t + desfase < tAnterior - 3600) desfase += 86400; // pasó la medianoche
    t += desfase;
    tAnterior = t;
  } else {
    t = filas.length;                 // sin marca de tiempo: 1 línea por segundo
  }
  filas.push({ t, temp: +m[5], pot: +m[7] });
}
if (filas.length < 60) {
  console.log(`Solo encontré ${filas.length} lecturas. Se necesitan varios minutos de datos.`);
  process.exit(1);
}
if (conHora === 0) {
  console.log('Aviso: el registro no tiene marca de tiempo; supongo 1 lectura por segundo.\n');
}
const t0 = filas[0].t;
filas.forEach((f) => { f.t -= t0; });

// ---------- 2. Encontrar el escalón de potencia ----------
let iEsc = -1;
for (let i = 1; i < filas.length; i++) {
  if (filas[i].pot - filas[i - 1].pot >= 5) { iEsc = i; break; }
}
if (iEsc < 0) {
  console.log('No encontré el momento en que subió la potencia (el escalón).');
  console.log('Revisa que el registro empiece ANTES de escribir "pot 40".');
  process.exit(1);
}
const u0 = filas[iEsc - 1].pot;
const u = filas[iEsc].pot;
// Fin del escalón: cuando la potencia cambia otra vez (off, auto…)
let iFin = filas.length;
for (let i = iEsc + 1; i < filas.length; i++) {
  if (Math.abs(filas[i].pot - u) > 0.5) { iFin = i; break; }
}
const esc = filas.slice(iEsc, iFin);
const du = u - u0;
const tEsc = filas[iEsc].t;
const antes = filas.slice(Math.max(0, iEsc - 20), iEsc);
const T0 = antes.length ? antes.reduce((a, f) => a + f.temp, 0) / antes.length : esc[0].temp;
const duracion = esc[esc.length - 1].t - tEsc;

// ---------- 3. Suavizar y medir la pendiente ----------
// El MAX6675 mide en pasos de 0.25 °C: se usa una recta ajustada en
// ventanas de 60 s para medir la velocidad sin que el ruido la engañe.
function pendiente(desde, hasta) {
  const pts = esc.filter((f) => f.t >= desde && f.t <= hasta);
  if (pts.length < 10) return null;
  const n = pts.length;
  const mt = pts.reduce((a, f) => a + f.t, 0) / n;
  const mT = pts.reduce((a, f) => a + f.temp, 0) / n;
  let num = 0, den = 0;
  for (const f of pts) { num += (f.t - mt) * (f.temp - mT); den += (f.t - mt) ** 2; }
  return den > 0 ? { s: num / den, t: mt, T: mT } : null;
}
const VENT = 60;
let max = null;
const pendientes = [];
for (let a = tEsc; a + VENT <= tEsc + duracion; a += 10) {
  const p = pendiente(a, a + VENT);
  if (!p) continue;
  pendientes.push(p);
  if (!max || p.s > max.s) max = p;
}
if (!max || max.s <= 0) {
  console.log('La temperatura no subió durante la prueba. ¿Estaba conectada la resistencia?');
  process.exit(1);
}
const subida = esc[esc.length - 1].temp - T0;

// Retraso (tiempo muerto): donde la recta de máxima pendiente cruza la temperatura inicial
let theta = (max.t - (max.T - T0) / max.s) - tEsc;
theta = Math.max(theta, 2);

// ¿Llegó a estabilizarse? (la pendiente del final es menor al 15 % de la máxima)
const finales = pendientes.slice(-3);
const sFinal = finales.length ? finales.reduce((a, p) => a + p.s, 0) / finales.length : max.s;
const estable = sFinal < 0.15 * max.s && duracion > 3 * theta;

// ---------- 4. Calcular las ganancias (SIMC) ----------
// Integrador con retraso:   K' = pendiente / Δu   (°C/s por cada % de potencia)
//   kp = 1 / (K' · (τc + θ))      Ti = 4 · (τc + θ)
// Primer orden con retraso (si se estabilizó):  K = ΔT/Δu, τ con el 63 %
//   kp = τ / (K · (τc + θ))       Ti = min(τ, 4 · (τc + θ))
// τc = qué tan rápido quieres que responda. τc = θ es el valor recomendado.
const Kprima = max.s / du;
let modelo = 'integrador con retraso';
let K = null, tau = null;
if (estable) {
  K = subida / du;
  const T63 = T0 + 0.632 * subida;
  const f63 = esc.find((f) => f.temp >= T63);
  if (f63) {
    tau = Math.max(f63.t - tEsc - theta, theta);
    modelo = 'primer orden con retraso';
  }
}

function ganancias(tc) {
  let kp, Ti;
  if (tau) {
    kp = tau / (K * (tc + theta));
    Ti = Math.min(tau, 4 * (tc + theta));
  } else {
    kp = 1 / (Kprima * (tc + theta));
    Ti = 4 * (tc + theta);
  }
  const ki = kp / Ti;
  // D opcional: frena antes de llegar. Td = θ/3 (moderado, para no amplificar
  // los saltos de 0.25 °C del MAX6675)
  const kd = kp * theta / 3;
  return { kp, ki, kd };
}
const f = (v, d) => v.toFixed(d);
const rec = ganancias(theta);
const cons = ganancias(2 * theta);
const rap = ganancias(0.5 * theta);

// ---------- 5. Resultado ----------
console.log('================ PRUEBA DE ESCALÓN ================');
console.log(`Lecturas: ${filas.length}   escalón de potencia: ${f(u0, 0)} % → ${f(u, 0)} %`);
console.log(`Temperatura inicial: ${f(T0, 2)} °C   final: ${f(esc[esc.length - 1].temp, 2)} °C   (subió ${f(subida, 1)} °C en ${f(duracion / 60, 1)} min)`);
console.log('');
console.log('Lo que se midió de tu equipo:');
console.log(`  Retraso (tiempo muerto)   θ ≈ ${f(theta, 0)} s   (lo que tarda el termopar en empezar a subir)`);
console.log(`  Velocidad máxima          ${f(max.s * 60, 2)} °C/min con ${f(du, 0)} % de potencia`);
if (tau) {
  console.log(`  Ganancia                  K ≈ ${f(K, 3)} °C por cada % de potencia`);
  console.log(`  Constante de tiempo       τ ≈ ${f(tau / 60, 1)} min`);
}
console.log(`  Modelo usado: ${modelo}`);
console.log('');
console.log('Valores calculados (escríbelos en prueba_finalpid o cópialos a esp32_extractor.ino):');
console.log('');
console.log(`  RECOMENDADO (PI):       kp ${f(rec.kp, 2)}   ki ${f(rec.ki, 4)}   kd 0`);
console.log(`  Con derivativa (PID):   kp ${f(rec.kp, 2)}   ki ${f(rec.ki, 4)}   kd ${f(rec.kd, 1)}`);
console.log(`  Más suave (conservador):kp ${f(cons.kp, 2)}   ki ${f(cons.ki, 4)}   kd 0`);
console.log(`  Más rápido (agresivo):  kp ${f(rap.kp, 2)}   ki ${f(rap.ki, 4)}   kd 0`);
console.log('');
console.log('Siguiente paso: deja enfriar, escribe los valores RECOMENDADOS (kp, ki, kd),');
console.log('luego  sp 60  y  on , y mira en el Serial Plotter si llega sin pasarse.');
console.log('  - Si se pasa del ajuste u oscila  -> usa los "más suave".');
console.log('  - Si llega bien pero muy lento    -> prueba los "más rápido".');

const avisos = [];
if (duracion < 4 * theta) avisos.push('La prueba fue corta comparada con el retraso. Repítela dejando calentar más tiempo.');
if (pendientes.length && max === pendientes[pendientes.length - 1]) avisos.push('La temperatura seguía acelerando al final: deja calentar más tiempo para medir mejor.');
if (subida < 5) avisos.push('La temperatura subió menos de 5 °C: el cálculo puede ser poco preciso. Usa más potencia o más tiempo.');
if (iEsc < 5) avisos.push('Casi no hay lecturas antes del escalón: empieza a copiar desde antes de escribir "pot".');
if (avisos.length) {
  console.log('\nAvisos:');
  avisos.forEach((a) => console.log('  - ' + a));
}
