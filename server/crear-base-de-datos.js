// crear-base-de-datos.js — Asistente para dejar lista la base de datos MySQL.
// Se ejecuta con doble clic en crear-base-de-datos.bat
//
// 1. Te pide el usuario y la contraseña de MySQL y prueba que funcionen.
// 2. Los guarda en db-config.json (solo en esta laptop) para no volver a pedirlos.
// 3. Crea la base de datos "hmi_extractor" y sus tablas.
// 4. Si existe hmi_data.db (la base SQLite de antes), copia esos datos a MySQL.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const mysql = require('mysql2/promise');
const { DB_NAME, crearBaseYTablas } = require('./esquema-mysql');
const { migrar } = require('./migrar-sqlite-a-mysql');

const CONFIG_PATH = path.join(__dirname, 'db-config.json');
const SQLITE_PATH = path.join(__dirname, 'hmi_data.db');

// Una sola entrada de teclado para todas las preguntas.
let rl = null;
const respuestas = [];
let esperando = null;
function preguntar(texto) {
  if (!rl) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.on('line', (linea) => {
      if (esperando) { const r = esperando; esperando = null; r(linea); }
      else respuestas.push(linea);
    });
    rl.on('close', () => { if (esperando) { const r = esperando; esperando = null; r(''); } });
  }
  process.stdout.write(texto);
  if (respuestas.length) return Promise.resolve(respuestas.shift());
  return new Promise((resolve) => { esperando = resolve; });
}

async function probarConexion(config) {
  const c = await mysql.createConnection(config);
  await c.end();
}

async function pedirCredenciales() {
  for (let intento = 1; intento <= 3; intento++) {
    const user = (await preguntar('Usuario de MySQL [root]: ')).trim() || 'root';
    const password = await preguntar(`Contraseña de MySQL para "${user}": `);
    const config = { host: 'localhost', port: 3306, user, password };
    try {
      await probarConexion(config);
      return config;
    } catch (err) {
      if (err.code === 'ECONNREFUSED') {
        throw new Error(
          'MySQL no está encendido.\n' +
          '  Abre "Servicios" de Windows (tecla Windows → escribe Servicios),\n' +
          '  busca MySQL80 (o MySQL), clic derecho → Iniciar, y vuelve a abrir este archivo.'
        );
      }
      if (err.code === 'ER_ACCESS_DENIED_ERROR') {
        console.log('  ✗ Usuario o contraseña incorrectos. Intenta de nuevo.\n');
        continue;
      }
      throw err;
    }
  }
  throw new Error('Demasiados intentos con contraseña incorrecta.');
}

(async () => {
  console.log('==============================================');
  console.log('  Crear la base de datos MySQL del HMI');
  console.log('==============================================\n');

  // 1-2. Credenciales (reusa las guardadas si todavía sirven)
  let config = null;
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const g = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      const c = { host: 'localhost', port: 3306, user: g.user, password: g.password };
      await probarConexion(c);
      config = c;
      console.log(`✓ Usando el usuario guardado "${g.user}".`);
    } catch { /* las guardadas ya no sirven, se vuelven a pedir */ }
  }
  if (!config) {
    config = await pedirCredenciales();
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ user: config.user, password: config.password }, null, 2));
    console.log('✓ Conexión correcta. Datos guardados en db-config.json');
  }

  // 3. Base de datos y tablas
  await crearBaseYTablas(config);
  console.log(`✓ Base de datos "${DB_NAME}" y tablas readings / operator_log listas.`);

  // 4. Datos de SQLite
  if (fs.existsSync(SQLITE_PATH)) {
    console.log('\nCopiando tus datos anteriores (hmi_data.db) a MySQL...');
    await migrar({ ...config, database: DB_NAME });
  }

  // Resumen
  const c = await mysql.createConnection({ ...config, database: DB_NAME });
  const [[r]] = await c.query('SELECT COUNT(*) AS n FROM readings');
  const [[o]] = await c.query('SELECT COUNT(*) AS n FROM operator_log');
  await c.end();
  console.log('\n----------------------------------------------');
  console.log(`  Lecturas guardadas:          ${r.n}`);
  console.log(`  Registros de operador:       ${o.n}`);
  console.log('----------------------------------------------');
  console.log('\n¡Listo! Ahora abre iniciar-servidor-mysql.bat para usar el sistema.\n');
})().catch((err) => {
  console.error('\n✗ ' + err.message + '\n');
  process.exitCode = 1;
}).finally(() => { if (rl) rl.close(); });
