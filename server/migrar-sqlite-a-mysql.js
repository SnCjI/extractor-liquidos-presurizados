// migrar-sqlite-a-mysql.js — Copia los datos de hmi_data.db (SQLite) a MySQL.
// crear-base-de-datos.bat ya lo ejecuta solo; también puedes correrlo
// a mano con:  npm run migrar
// Si lo corres varias veces no duplica nada: solo copia los registros
// cuyo id todavía no existe en MySQL.

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const mysql = require('mysql2/promise');

async function copiar(sqlite, my, tabla, columnas) {
  const filas = sqlite.prepare(`SELECT ${columnas.join(', ')} FROM ${tabla} ORDER BY id`).all();
  if (filas.length === 0) {
    console.log(`  ${tabla}: no hay datos que copiar.`);
    return;
  }
  const lote = 500;
  let copiadas = 0;
  for (let i = 0; i < filas.length; i += lote) {
    const valores = filas.slice(i, i + lote).map((f) => columnas.map((c) => f[c]));
    const [r] = await my.query(
      `INSERT IGNORE INTO ${tabla} (${columnas.join(', ')}) VALUES ?`,
      [valores]
    );
    copiadas += r.affectedRows;
  }
  console.log(`  ${tabla}: ${copiadas} nuevos de ${filas.length} registros.`);
}

async function migrar(config) {
  const sqlite = new Database(path.join(__dirname, 'hmi_data.db'), { readonly: true });
  const my = await mysql.createConnection(config);
  try {
    await copiar(sqlite, my, 'readings',
      ['id', 'ts', 'device_ts', 'device_id', 'temperature', 'pressure', 'humidity']);
    await copiar(sqlite, my, 'operator_log',
      ['id', 'ts', 'fecha', 'hora', 'operador', 'nota']);

    // Para que los registros nuevos continúen después del último id copiado.
    for (const t of ['readings', 'operator_log']) {
      const [[{ m }]] = await my.query(`SELECT COALESCE(MAX(id), 0) + 1 AS m FROM ${t}`);
      await my.query(`ALTER TABLE ${t} AUTO_INCREMENT = ${Number(m)}`);
    }
  } finally {
    await my.end();
    sqlite.close();
  }
}

module.exports = { migrar };

// Si se ejecuta directamente (npm run migrar), usa los datos de db-config.json.
if (require.main === module) {
  let guardada = {};
  try {
    guardada = JSON.parse(fs.readFileSync(path.join(__dirname, 'db-config.json'), 'utf8'));
  } catch { /* sin archivo: usa variables de entorno o valores por defecto */ }

  migrar({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || guardada.user || 'root',
    password: process.env.DB_PASSWORD ?? guardada.password ?? '',
    database: process.env.DB_NAME || 'hmi_extractor',
  })
    .then(() => console.log('Listo.'))
    .catch((err) => {
      console.error('Error en la migración:', err.message);
      process.exit(1);
    });
}
