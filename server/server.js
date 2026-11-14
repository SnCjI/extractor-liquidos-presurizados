// server.js — Backend del HMI
// Recibe lecturas del ESP32 por HTTP POST, las guarda en SQLite,
// y expone endpoints para que el dashboard las lea.

const path = require('path');
const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'hmi_data.db');

// Zona horaria usada para calcular "día" y "hora" del registro de
// operador, sin importar en qué servidor/país corra este servicio.
const TIMEZONE = process.env.TIMEZONE || 'America/Mexico_City';

// Clave simple para autenticar al ESP32 (cambiala en tu despliegue real).
// El ESP32 debe mandar este valor en el header "x-device-key".
const DEVICE_KEY = process.env.DEVICE_KEY || 'cambia-esta-clave';

// ---------- Base de datos ----------
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,              -- epoch ms en el servidor (llegada)
    device_ts INTEGER,                -- millis() del ESP32, opcional
    device_id TEXT NOT NULL,
    temperature REAL,
    pressure REAL,
    humidity REAL
  );
  CREATE INDEX IF NOT EXISTS idx_readings_ts ON readings (ts);

  CREATE TABLE IF NOT EXISTS operator_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,              -- epoch ms (momento exacto del registro)
    fecha TEXT NOT NULL,              -- 'YYYY-MM-DD', día del registro
    hora TEXT NOT NULL,               -- 'HH:MM:SS', hora del registro
    operador TEXT NOT NULL,           -- nombre de la persona que usó el sistema
    nota TEXT                         -- qué hizo / observaciones
  );
  CREATE INDEX IF NOT EXISTS idx_operator_log_fecha ON operator_log (fecha);
`);

const insertStmt = db.prepare(`
  INSERT INTO readings (ts, device_ts, device_id, temperature, pressure, humidity)
  VALUES (@ts, @device_ts, @device_id, @temperature, @pressure, @humidity)
`);

const latestStmt = db.prepare(`
  SELECT * FROM readings ORDER BY ts DESC LIMIT 1
`);

const historyStmt = db.prepare(`
  SELECT * FROM readings ORDER BY ts DESC LIMIT ?
`);

const rangeStmt = db.prepare(`
  SELECT * FROM readings WHERE ts BETWEEN ? AND ? ORDER BY ts ASC
`);

const insertLogStmt = db.prepare(`
  INSERT INTO operator_log (ts, fecha, hora, operador, nota)
  VALUES (@ts, @fecha, @hora, @operador, @nota)
`);

const logByDateStmt = db.prepare(`
  SELECT * FROM operator_log WHERE fecha = ? ORDER BY ts DESC
`);

const logRecentStmt = db.prepare(`
  SELECT * FROM operator_log ORDER BY ts DESC LIMIT ?
`);

const logDaysStmt = db.prepare(`
  SELECT fecha, COUNT(*) AS total FROM operator_log GROUP BY fecha ORDER BY fecha DESC
`);

// Da "fecha" (YYYY-MM-DD) y "hora" (HH:MM:SS) a partir de un timestamp,
// ya ajustados a TIMEZONE (para que el "día" no cambie de madrugada por
// culpa de UTC si el servidor está en otro país).
function fechaHoraLocal(date) {
  const partsFecha = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date); // en-CA da YYYY-MM-DD directo
  const partsHora = new Intl.DateTimeFormat('es-MX', {
    timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(date);
  return { fecha: partsFecha, hora: partsHora };
}

// ---------- App ----------
const app = express();
app.use(cors());
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Salud del servicio
app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: Date.now() });
});

// Recibe datos del ESP32
// Body esperado (JSON):
// {
//   "device_id": "esp32-planta-1",
//   "device_ts": 123456,        // opcional, millis() del ESP32
//   "temperature": 24.7,        // °C
//   "pressure": 1013.2,         // hPa
//   "humidity": 55.3            // %HR
// }
app.post('/api/data', (req, res) => {
  const key = req.header('x-device-key');
  if (key !== DEVICE_KEY) {
    return res.status(401).json({ ok: false, error: 'device key invalida' });
  }

  const { device_id, device_ts, temperature, pressure, humidity } = req.body || {};

  if (!device_id) {
    return res.status(400).json({ ok: false, error: 'falta device_id' });
  }
  if ([temperature, pressure, humidity].every((v) => v === undefined || v === null)) {
    return res.status(400).json({ ok: false, error: 'no se recibio ninguna variable' });
  }

  const row = {
    ts: Date.now(),
    device_ts: Number.isFinite(device_ts) ? device_ts : null,
    device_id: String(device_id),
    temperature: temperature ?? null,
    pressure: pressure ?? null,
    humidity: humidity ?? null,
  };

  insertStmt.run(row);
  res.json({ ok: true });
});

// Ultima lectura (para los gauges en vivo)
app.get('/api/latest', (req, res) => {
  const row = latestStmt.get();
  res.json(row || null);
});

// Historial reciente (para las graficas). ?limit=200
app.get('/api/history', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 200, 5000);
  const rows = historyStmt.all(limit).reverse();
  res.json(rows);
});

// Historial por rango de fechas (epoch ms). ?from=...&to=...
app.get('/api/history/range', (req, res) => {
  const from = parseInt(req.query.from, 10) || 0;
  const to = parseInt(req.query.to, 10) || Date.now();
  const rows = rangeStmt.all(from, to);
  res.json(rows);
});

// Exporta todo como CSV (para respaldo / analisis externo)
app.get('/api/export.csv', (req, res) => {
  const rows = db.prepare('SELECT * FROM readings ORDER BY ts ASC').all();
  const header = 'id,ts,device_ts,device_id,temperature,pressure,humidity\n';
  const body = rows
    .map((r) => [r.id, r.ts, r.device_ts, r.device_id, r.temperature, r.pressure, r.humidity].join(','))
    .join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="hmi_export.csv"');
  res.send(header + body);
});

// ---------- Registro de operador (quién usó el sistema, cuándo, y qué hizo) ----------

// Crea un nuevo registro.
// Body esperado (JSON):
// {
//   "operador": "Julia",          // obligatorio, nombre de quien usa el sistema
//   "nota": "Cambié el setpoint..." // opcional, qué hizo / observaciones
// }
// fecha y hora las calcula el servidor (no se mandan desde el navegador),
// así el registro es confiable aunque la hora de la laptop esté mal puesta.
app.post('/api/log', (req, res) => {
  const { operador, nota } = req.body || {};

  if (!operador || !String(operador).trim()) {
    return res.status(400).json({ ok: false, error: 'falta el nombre del operador' });
  }

  const now = new Date();
  const { fecha, hora } = fechaHoraLocal(now);

  const row = {
    ts: now.getTime(),
    fecha,
    hora,
    operador: String(operador).trim(),
    nota: nota ? String(nota).trim() : null,
  };

  insertLogStmt.run(row);
  res.json({ ok: true, fecha, hora });
});

// Lista los registros. ?fecha=YYYY-MM-DD para un día específico,
// o sin parámetro para traer los más recientes (?limit=, default 100).
app.get('/api/log', (req, res) => {
  if (req.query.fecha) {
    const rows = logByDateStmt.all(req.query.fecha);
    return res.json(rows);
  }
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 2000);
  const rows = logRecentStmt.all(limit);
  res.json(rows);
});

// Lista los días que tienen al menos un registro, con el total de cada uno
// (útil para un selector de "ver día X" en el monitor).
app.get('/api/log/days', (req, res) => {
  res.json(logDaysStmt.all());
});

// Exporta todo el registro de operador como CSV
app.get('/api/log/export.csv', (req, res) => {
  const rows = db.prepare('SELECT * FROM operator_log ORDER BY ts ASC').all();
  const header = 'id,fecha,hora,operador,nota\n';
  const esc = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const body = rows
    .map((r) => [r.id, esc(r.fecha), esc(r.hora), esc(r.operador), esc(r.nota)].join(','))
    .join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="registro_operador.csv"');
  res.send(header + body);
});

app.listen(PORT, () => {
  console.log(`HMI server escuchando en http://localhost:${PORT}`);
  console.log(`Base de datos: ${DB_PATH}`);
  console.log(`Device key esperada en header x-device-key: ${DEVICE_KEY}`);
});
