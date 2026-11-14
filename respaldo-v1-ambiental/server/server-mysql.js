// server-mysql.js — Backend del HMI usando MySQL
// Es el mismo servidor que server.js, pero guarda los datos en MySQL
// en lugar de SQLite. Los endpoints (/api/...) son exactamente iguales,
// así que el dashboard, el monitor, el celular y el ESP32 NO cambian.
//
// Para arrancarlo:   npm run start:mysql

const path = require('path');
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const os = require('os');
const mysql = require('mysql2/promise');
const { DB_NAME, crearBaseYTablas } = require('./esquema-mysql');

function leerConfigGuardada() {
  let guardada = {};
  try {
    guardada = JSON.parse(fs.readFileSync(path.join(__dirname, 'db-config.json'), 'utf8'));
  } catch { /* todavía no existe */ }
  return {
    user: process.env.DB_USER || guardada.user || 'root',
    password: process.env.DB_PASSWORD ?? guardada.password ?? '',
  };
}

// =====================================================================
//  CONFIGURACIÓN DE MYSQL  —  lo único que normalmente tienes que tocar
// =====================================================================
// El usuario y la contraseña se guardan en db-config.json
// (lo crea crear-base-de-datos.bat la primera vez).
const DB_CONFIG = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 3306,
  ...leerConfigGuardada(),
};
// =====================================================================

const PORT = process.env.PORT || 3000;
const TIMEZONE = process.env.TIMEZONE || 'America/Mexico_City';
const DEVICE_KEY = process.env.DEVICE_KEY || 'cambia-esta-clave';

let pool; // conexión a MySQL (se crea en iniciarBaseDeDatos)

// ---------- Base de datos ----------
// Crea la base de datos y las tablas si todavía no existen
// (definidas en esquema-mysql.js) y abre la conexión.
async function iniciarBaseDeDatos() {
  await crearBaseYTablas(DB_CONFIG);
  pool = mysql.createPool({ ...DB_CONFIG, database: DB_NAME, connectionLimit: 10 });
}

// Atajo: ejecuta una consulta y devuelve solo las filas.
async function q(sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return rows;
}

function fechaHoraLocal(date) {
  const fecha = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
  const hora = new Intl.DateTimeFormat('es-MX', {
    timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(date);
  return { fecha, hora };
}

// Envuelve las rutas async para que un error de MySQL responda 500
// en lugar de tumbar el servidor.
const ruta = (fn) => (req, res) =>
  fn(req, res).catch((err) => {
    console.error('Error de base de datos:', err.message);
    res.status(500).json({ ok: false, error: 'error de base de datos' });
  });

// ---------- App ----------
const app = express();
app.use(cors());
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/health', ruta(async (req, res) => {
  await q('SELECT 1');
  res.json({ ok: true, time: Date.now(), db: 'mysql' });
}));

// Recibe datos del ESP32
app.post('/api/data', ruta(async (req, res) => {
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

  await q(
    `INSERT INTO readings (ts, device_ts, device_id, temperature, pressure, humidity)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      Date.now(),
      Number.isFinite(device_ts) ? device_ts : null,
      String(device_id),
      temperature ?? null,
      pressure ?? null,
      humidity ?? null,
    ]
  );
  res.json({ ok: true });
}));

// Última lectura (gauges en vivo)
app.get('/api/latest', ruta(async (req, res) => {
  const rows = await q('SELECT * FROM readings ORDER BY ts DESC LIMIT 1');
  res.json(rows[0] || null);
}));

// Historial reciente (gráficas). ?limit=200
app.get('/api/history', ruta(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 200, 5000);
  const rows = await q('SELECT * FROM readings ORDER BY ts DESC LIMIT ?', [limit]);
  res.json(rows.reverse());
}));

// Historial por rango (epoch ms). ?from=...&to=...
app.get('/api/history/range', ruta(async (req, res) => {
  const from = parseInt(req.query.from, 10) || 0;
  const to = parseInt(req.query.to, 10) || Date.now();
  res.json(await q('SELECT * FROM readings WHERE ts BETWEEN ? AND ? ORDER BY ts ASC', [from, to]));
}));

// Exporta lecturas a CSV
app.get('/api/export.csv', ruta(async (req, res) => {
  const rows = await q('SELECT * FROM readings ORDER BY ts ASC');
  const header = 'id,ts,device_ts,device_id,temperature,pressure,humidity\n';
  const body = rows
    .map((r) => [r.id, r.ts, r.device_ts, r.device_id, r.temperature, r.pressure, r.humidity].join(','))
    .join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="hmi_export.csv"');
  res.send(header + body);
}));

// Direcciones de esta computadora en la red, para abrir la página desde
// el celular (las usa el botón "Ver en celular" del dashboard).
app.get('/api/red', (req, res) => {
  res.json({
    puerto: Number(PORT),
    direcciones: direccionesDeRed().map((r) => ({
      nombre: r.nombre,
      url: `http://${r.ip}:${PORT}`,
      esRedEsp32: r.ip === '192.168.4.2',
    })),
  });
});

// ---------- Registro de operador ----------
app.post('/api/log', ruta(async (req, res) => {
  const { operador, nota } = req.body || {};
  if (!operador || !String(operador).trim()) {
    return res.status(400).json({ ok: false, error: 'falta el nombre del operador' });
  }

  const now = new Date();
  const { fecha, hora } = fechaHoraLocal(now);
  await q(
    'INSERT INTO operator_log (ts, fecha, hora, operador, nota) VALUES (?, ?, ?, ?, ?)',
    [now.getTime(), fecha, hora, String(operador).trim(), nota ? String(nota).trim() : null]
  );
  res.json({ ok: true, fecha, hora });
}));

app.get('/api/log', ruta(async (req, res) => {
  if (req.query.fecha) {
    return res.json(await q('SELECT * FROM operator_log WHERE fecha = ? ORDER BY ts DESC', [req.query.fecha]));
  }
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 2000);
  res.json(await q('SELECT * FROM operator_log ORDER BY ts DESC LIMIT ?', [limit]));
}));

app.get('/api/log/days', ruta(async (req, res) => {
  res.json(await q(
    'SELECT fecha, COUNT(*) AS total FROM operator_log GROUP BY fecha ORDER BY fecha DESC'
  ));
}));

app.get('/api/log/export.csv', ruta(async (req, res) => {
  const rows = await q('SELECT * FROM operator_log ORDER BY ts ASC');
  const header = 'id,fecha,hora,operador,nota\n';
  const esc = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const body = rows
    .map((r) => [r.id, esc(r.fecha), esc(r.hora), esc(r.operador), esc(r.nota)].join(','))
    .join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="registro_operador.csv"');
  res.send(header + body);
}));

// ---------- Direcciones para abrir desde el celular ----------
// Busca las IPs de esta computadora en las redes WiFi/Ethernet
// (ignora las internas y las de adaptadores virtuales).
function direccionesDeRed() {
  const virtuales = /vethernet|virtualbox|vmware|hyper-v|loopback|wsl|docker|bluetooth/i;
  const lista = [];
  for (const [nombre, ifaces] of Object.entries(os.networkInterfaces())) {
    if (virtuales.test(nombre)) continue;
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal) lista.push({ nombre, ip: i.address });
    }
  }
  return lista;
}

// ---------- Arranque ----------
iniciarBaseDeDatos()
  .then(() => {
    // Sin indicar dirección, Node acepta conexiones de cualquier dispositivo
    // de la red (celular, tablet, otra computadora), no solo de esta laptop.
    // Además, si ya hay otro servidor del HMI abierto, este marca EADDRINUSE
    // y avisa, en lugar de que queden dos funcionando a la vez.
    const servidor = app.listen(PORT, () => {
      console.log(`HMI server (MySQL) escuchando en http://localhost:${PORT}`);
      console.log(`Base de datos MySQL: ${DB_NAME} en ${DB_CONFIG.host}:${DB_CONFIG.port}`);
      console.log(`Device key esperada en header x-device-key: ${DEVICE_KEY}`);

      const redes = direccionesDeRed();
      console.log('\n================ ABRIR EN EL CELULAR ================');
      if (redes.length === 0) {
        console.log(' Esta laptop no está conectada a ninguna red WiFi.');
        console.log(' Conéctala al WiFi (o a HMI-ESP32) y vuelve a arrancar.');
      } else {
        console.log(' Conecta el celular a la MISMA red WiFi y abre en Chrome:');
        for (const r of redes) {
          const nota = r.ip === '192.168.4.2' ? '   <- red HMI-ESP32' : '';
          console.log(`   http://${r.ip}:${PORT}      (${r.nombre})${nota}`);
        }
      }
      console.log('=====================================================\n');
    });

    servidor.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`\nEl puerto ${PORT} ya está ocupado: probablemente hay otro servidor`);
        console.error('del HMI abierto (ver-pagina.bat o una terminal). Ciérralo y vuelve a intentar.\n');
      } else {
        console.error('\nNo se pudo arrancar el servidor:', err.message, '\n');
      }
      process.exit(1);
    });
  })
  .catch((err) => {
    console.error('\nNo me pude conectar a MySQL:', err.message);
    console.error('Revisa que MySQL esté encendido y vuelve a correr');
    console.error('crear-base-de-datos.bat si cambiaste la contraseña.\n');
    process.exit(1);
  });
