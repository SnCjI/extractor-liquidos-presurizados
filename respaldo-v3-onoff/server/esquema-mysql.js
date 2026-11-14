// esquema-mysql.js — Crea la base de datos y las tablas del HMI en MySQL.
// Lo usan server-mysql.js y crear-base-de-datos.js, así las tablas
// están definidas en un solo lugar.
//
// Extractor de líquidos presurizados (H2O) con 3 zonas de calentamiento:
// cada zona = resistencia + relevador SSR + sonda de temperatura.

const mysql = require('mysql2/promise');

const DB_NAME = process.env.DB_NAME || 'hmi_extractor';

// Columnas que se agregaron para el extractor. Si la tabla `readings` ya
// existía (versión anterior), se agregan sin borrar los datos que tenga.
const COLUMNAS_EXTRACTOR = [
  ['t_z1',       'DOUBLE NULL'],          // °C zona 1
  ['t_z2',       'DOUBLE NULL'],          // °C zona 2
  ['t_z3',       'DOUBLE NULL'],          // °C zona 3
  ['ssr1',       'TINYINT NULL'],         // 1 = resistencia 1 encendida
  ['ssr2',       'TINYINT NULL'],
  ['ssr3',       'TINYINT NULL'],
  ['presion',    'DOUBLE NULL'],          // bar (opcional, si se instala sensor)
  ['sistema_on', 'TINYINT NULL'],         // 1 = el ESP32 tiene el control activo
  ['alarma',     'VARCHAR(160) NULL'],    // texto de alarma reportado por el ESP32
];

async function crearBaseYTablas(config) {
  const conexion = await mysql.createConnection(config);
  try {
    await conexion.query(
      `CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\`
       CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
    await conexion.query(`USE \`${DB_NAME}\``);

    // Lecturas que manda el ESP32
    await conexion.query(`
      CREATE TABLE IF NOT EXISTS readings (
        id          INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        ts          BIGINT NOT NULL,        -- epoch ms en el servidor (llegada)
        device_ts   BIGINT NULL,            -- millis() del ESP32, opcional
        device_id   VARCHAR(64) NOT NULL,
        temperature DOUBLE NULL,            -- (versión anterior, se conserva)
        pressure    DOUBLE NULL,
        humidity    DOUBLE NULL,
        INDEX idx_readings_ts (ts)
      ) ENGINE=InnoDB
    `);

    // Agrega las columnas del extractor que falten (MySQL 8 no tiene
    // "ADD COLUMN IF NOT EXISTS", así que se revisa una por una).
    const [existentes] = await conexion.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'readings'`,
      [DB_NAME]
    );
    const nombres = new Set(existentes.map((c) => c.COLUMN_NAME));
    for (const [col, tipo] of COLUMNAS_EXTRACTOR) {
      if (!nombres.has(col)) {
        await conexion.query(`ALTER TABLE readings ADD COLUMN ${col} ${tipo}`);
      }
    }

    // Bitácora de operador
    await conexion.query(`
      CREATE TABLE IF NOT EXISTS operator_log (
        id        INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        ts        BIGINT NOT NULL,          -- epoch ms (momento exacto del registro)
        fecha     VARCHAR(10) NOT NULL,     -- 'YYYY-MM-DD'
        hora      VARCHAR(8)  NOT NULL,     -- 'HH:MM:SS'
        operador  VARCHAR(100) NOT NULL,    -- quién usó el sistema
        nota      TEXT NULL,                -- qué hizo / observaciones
        INDEX idx_operator_log_fecha (fecha)
      ) ENGINE=InnoDB
    `);

    // Valores de ajuste (set-points) que el operador escribe en el HMI
    // y que el ESP32 lee para controlar las resistencias. Una sola fila (id=1).
    await conexion.query(`
      CREATE TABLE IF NOT EXISTS setpoints (
        id               TINYINT UNSIGNED NOT NULL PRIMARY KEY,
        sp_z1            DOUBLE NOT NULL,   -- °C deseados zona 1
        sp_z2            DOUBLE NOT NULL,
        sp_z3            DOUBLE NOT NULL,
        sistema_on       TINYINT NOT NULL,  -- 1 = calentar, 0 = todo apagado
        actualizado_ts   BIGINT NOT NULL,
        actualizado_por  VARCHAR(100) NULL
      ) ENGINE=InnoDB
    `);
    // Valores iniciales seguros: sistema APAGADO.
    await conexion.query(
      `INSERT IGNORE INTO setpoints (id, sp_z1, sp_z2, sp_z3, sistema_on, actualizado_ts, actualizado_por)
       VALUES (1, 60, 60, 60, 0, ?, 'sistema')`,
      [Date.now()]
    );
  } finally {
    await conexion.end();
  }
}

module.exports = { DB_NAME, crearBaseYTablas };
