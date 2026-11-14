// esquema-mysql.js — Crea la base de datos y las tablas del HMI en MySQL.
// Lo usan server-mysql.js y crear-base-de-datos.js, así las tablas
// están definidas en un solo lugar.

const mysql = require('mysql2/promise');

const DB_NAME = process.env.DB_NAME || 'hmi_extractor';

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
        temperature DOUBLE NULL,
        pressure    DOUBLE NULL,
        humidity    DOUBLE NULL,
        INDEX idx_readings_ts (ts)
      ) ENGINE=InnoDB
    `);

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
  } finally {
    await conexion.end();
  }
}

module.exports = { DB_NAME, crearBaseYTablas };
