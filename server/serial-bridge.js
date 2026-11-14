// serial-bridge.js
// ---------------------------------------------------------
// Puente Serial (USB) <-> HTTP.
//
// El ESP32, conectado por cable USB a esta laptop/PC, imprime
// una línea de texto JSON por cada lectura (Serial.println(...)).
// Este script:
//   1) Escucha ese puerto serial.
//   2) Junta los bytes hasta formar una línea completa.
//   3) Intenta interpretarla como JSON.
//   4) Si es válida, la reenvía por HTTP POST a este mismo
//      servidor (server.js), al endpoint /api/data — el MISMO
//      endpoint que ya usa el modo WiFi, así que no hay que
//      tocar server.js ni la base de datos para nada.
//
// Es decir: NO reemplaza a server.js, corre EN PARALELO. Necesitas
// las dos cosas corriendo al mismo tiempo (dos terminales, o el
// modo "todo en uno" que se explica en el README):
//   Terminal 1:  npm start            (arranca server.js, puerto 3000)
//   Terminal 2:  npm run serial-bridge
//
// Instalación (una sola vez):
//   npm install
//
// Configuración: variables de entorno opcionales, o simplemente
// edita las constantes de abajo.
//   SERIAL_PORT   -> nombre del puerto (ver README para cómo
//                     encontrarlo en Windows/macOS/Linux)
//   SERIAL_BAUD   -> debe coincidir con el Serial.begin(...) del
//                     ESP32 (115200 por defecto en este proyecto)
//   SERVER_URL    -> normalmente http://localhost:3000/api/data
//   DEVICE_KEY    -> debe coincidir con DEVICE_KEY en server.js
// ---------------------------------------------------------

const { SerialPort, ReadlineParser } = require('serialport');

// ------------------- CONFIGURACIÓN -------------------

// Deja "" para que el script te muestre la lista de puertos
// disponibles y te diga cuál usar.
const SERIAL_PORT = process.env.SERIAL_PORT || '';

// Debe coincidir EXACTO con Serial.begin(115200) en el .ino
const SERIAL_BAUD = parseInt(process.env.SERIAL_BAUD, 10) || 115200;

// El bridge le habla al MISMO server.js que ya tienes corriendo
// (normalmente en la misma máquina, por eso "localhost").
const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3000/api/data';

// Debe coincidir con DEVICE_KEY en server.js
const DEVICE_KEY = process.env.DEVICE_KEY || 'cambia-esta-clave';

// device_id que se guardará en la base de datos para estas lecturas
const DEVICE_ID = process.env.DEVICE_ID || 'esp32-serial-usb';

// -------------------------------------------------------

async function listPortsAndExit() {
  const ports = await SerialPort.list();
  console.log('No configuraste SERIAL_PORT. Puertos disponibles:\n');
  if (ports.length === 0) {
    console.log('  (no se detectó ningún dispositivo USB serial — revisa el cable y el driver)');
  } else {
    ports.forEach((p) => {
      console.log(`  ${p.path}${p.manufacturer ? '  -  ' + p.manufacturer : ''}`);
    });
  }
  console.log('\nVuelve a correr así, con el puerto correcto:');
  console.log('  SERIAL_PORT=<puerto-de-la-lista> npm run serial-bridge\n');
  process.exit(1);
}

async function sendToServer(reading) {
  const body = JSON.stringify({
    device_id: reading.device_id || DEVICE_ID,
    device_ts: reading.device_ts,
    temperature: reading.temperature,
    pressure: reading.pressure,
    humidity: reading.humidity,
  });

  try {
    const res = await fetch(SERVER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-device-key': DEVICE_KEY,
      },
      body,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error(`[bridge] servidor respondió ${res.status}: ${text}`);
    } else {
      console.log(`[bridge] OK  T=${reading.temperature}  P=${reading.pressure}  H=${reading.humidity}`);
    }
  } catch (err) {
    console.error(`[bridge] no se pudo contactar al servidor (${SERVER_URL}). ¿Corriste "npm start" en otra terminal? Detalle: ${err.message}`);
  }
}

function handleLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return;

  // Ignora líneas que no sean JSON (mensajes de depuración normales
  // del ESP32, como "Buscando sensor..." etc.)
  if (!trimmed.startsWith('{')) {
    console.log(`[esp32] ${trimmed}`);
    return;
  }

  let data;
  try {
    data = JSON.parse(trimmed);
  } catch (err) {
    console.warn(`[bridge] línea no es JSON válido, se ignora: ${trimmed}`);
    return;
  }

  if (
    data.temperature === undefined &&
    data.pressure === undefined &&
    data.humidity === undefined
  ) {
    console.warn('[bridge] JSON recibido pero sin temperature/pressure/humidity, se ignora:', data);
    return;
  }

  sendToServer(data);
}

async function main() {
  if (!SERIAL_PORT) {
    await listPortsAndExit();
    return;
  }

  const port = new SerialPort({ path: SERIAL_PORT, baudRate: SERIAL_BAUD }, (err) => {
    if (err) {
      console.error(`[bridge] No se pudo abrir el puerto "${SERIAL_PORT}": ${err.message}`);
      console.error('Revisa que: 1) el ESP32 esté conectado por USB, 2) el nombre del puerto sea correcto,');
      console.error('3) no lo tengas abierto en el Monitor Serial del Arduino IDE al mismo tiempo (solo un programa puede usarlo a la vez).');
      process.exit(1);
    }
  });

  const parser = port.pipe(new ReadlineParser({ delimiter: '\n' }));

  parser.on('data', handleLine);

  port.on('open', () => {
    console.log(`[bridge] Puerto serial abierto: ${SERIAL_PORT} @ ${SERIAL_BAUD} baud`);
    console.log(`[bridge] Reenviando lecturas a: ${SERVER_URL}`);
    console.log('[bridge] Esperando datos del ESP32... (Ctrl+C para salir)\n');
  });

  port.on('close', () => {
    console.log('[bridge] Puerto serial cerrado.');
  });

  port.on('error', (err) => {
    console.error(`[bridge] Error de puerto serial: ${err.message}`);
  });
}

main();
