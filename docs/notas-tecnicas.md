# HMI — Extractor de líquidos presurizados (H₂O) · versión 4 (termopares + control PID)

> Esta sección describe la versión actual. Más abajo queda la documentación
> de la versión anterior (monitoreo ambiental con BME280), que se respaldó en
> `respaldo-v1-ambiental/`. La versión de 3 zonas quedó en `respaldo-v2-3zonas/`
> y la de control ON/OFF con sondas DS18B20 en `respaldo-v3-onoff/`.

```
Tanque H2O ─► (bomba opcional) ─► EXTRACTOR [Zona 1 superior · Zona 2 inferior] ─► Válvula ─► Colector
                                        ▲ cada zona: resistencia + SSR-40DA + termopar K (MAX6675)
ESP32 ──WiFi (red HMI-ESP32)──► server-mysql.js (laptop 192.168.4.2) ──► MySQL (hmi_extractor)
   ▲            ajustes (set-points)  ◄──┘        ▲
   └──── el ESP32 obedece los ajustes             └── HMI en navegador / celular
```

**Archivos principales**
- `esp32/prueba_max6675/` — prueba SOLO del termopar (muestra la temperatura en el Monitor Serie).
- `esp32/prueba_finalpid/` — prueba del PID con UNA resistencia, sin WiFi. Se controla desde el
  Monitor Serie (`sp 80`, `on`, `off`, `kp 4`, `ki 0.005`, `kd 40`, `pot 40`, `auto`) y se ve la curva en el
  Serial Plotter. Sirve para afinar las ganancias antes de usar el programa completo.
- `esp32/esp32_extractor/esp32_extractor.ino` — firmware completo: lee los 2 termopares
  (MAX6675: SCK GPIO 18, SO GPIO 19, CS GPIO 5 y 17, VCC a 3V3), calcula con PID la potencia
  (0 a 100 %) de cada resistencia y prende sus SSR (GPIO 25 y 26) esa fracción de cada
  ventana de 2 s. Seguridad: todo apagado al arrancar, sin servidor por 15 s, termopar
  desconectado o zona sobre 105 °C. Librería: solo ArduinoJson 7.
- `server/server-mysql.js` — servidor: guarda lecturas (temperatura y potencia), guarda los
  ajustes (0 a 100 °C; 80 °C es el máximo recomendado) y los devuelve al ESP32 en cada envío;
  todo cambio de ajuste queda en la bitácora (marcado si pasa de 80 °C).
- `server/simular-esp32.bat` — simulador del ESP32 (mismo PID) para probar el HMI sin hardware.
- `public/` — el HMI (computadora y celular) con 3 pestañas: **Inicio** (diagrama, control y
  potencia PID de cada resistencia), **Gráfica** (temperatura por rango de tiempo; la franja de
  abajo es más intensa cuanto más potencia) y **Datos** (tabla tipo Excel de la bitácora y de
  las lecturas, con búsqueda y descarga CSV).

**Afinar el PID (con prueba_finalpid.ino)**
0. Lo mejor es medir el equipo con la prueba de escalón (`pot 40`) y calcular los valores con
   `node calcular-pid.js escalon.txt` (ver README). Si quieres afinarlos a mano:
1. Empieza con `kp 4`, `ki 0.005`, `kd 40`, `sp 60`, `on` y mira el Serial Plotter.
2. Si sube muy lento y se queda abajo del ajuste → sube `ki` (0.08, 0.1).
3. Si se pasa del ajuste y oscila → baja `kp` y `ki`, o sube `kd` (15, 20).
4. Cuando quede bien, copia los valores en `KP`, `KI`, `KD` de `esp32_extractor.ino`.

**Uso diario**
1. `server\iniciar-servidor-mysql.bat` (deja la ventana abierta).
2. Sin hardware: `server\simular-esp32.bat` en otra ventana. Con hardware: enciende el ESP32.
3. Abre `http://localhost:3000` (o el botón **📱 Ver en celular**).
4. **⏻ ENCENDER SISTEMA** y usa **✎ AJUSTE** en cada zona (se pide el nombre del operador).

**Seguridad:** el control por software no sustituye una protección física.
Instala un termostato o fusible térmico en serie con cada resistencia y una
válvula de alivio si el recipiente trabaja a presión.

---

# HMI — Estación de monitoreo (ESP32 → servidor → dashboard)

Sistema completo de 3 piezas:

```
ESP32 (sensor BME280)  --HTTP POST-->  server.js (Node/Express + SQLite)  --HTTP GET-->  index.html (dashboard)
```

## 0. Cómo se conectan las piezas (modo Access Point)

El ESP32 **ya no se conecta a tu router de internet** — al revés, el
propio ESP32 crea su propia red WiFi ("HMI-ESP32") y todo lo demás se
conecta a él:

```
                         ┌─────────────────────────┐
                         │   ESP32 (192.168.4.1)    │
                         │  crea la red "HMI-ESP32" │
                         └────────────┬─────────────┘
                                      │ WiFi
              ┌───────────────────────┼───────────────────────┐
              │                       │                       │
     Laptop (192.168.4.2)      Celular Android          (otros dispositivos)
     corre server.js            abre el navegador o
     (Node + SQLite)            instala la web como app
              │
      guarda todo en
      hmi_data.db (SQLite)
```

Ventaja de este esquema: no necesitas router ni internet en el sitio
donde esté el sensor — el ESP32 es su propia red aislada. La base de
datos real sigue siendo la SQLite del `server.js`, corriendo en tu
laptop.

### Paso a paso para dejarlo funcionando

1. **Sube el firmware** (`esp32/esp32_hmi.ino`) al ESP32. Al arrancer, crea
   la red WiFi `HMI-ESP32` (contraseña `extraccion2024`, cámbiala en el
   código) con IP fija `192.168.4.1`.
2. **Conecta tu laptop** a esa red WiFi (`HMI-ESP32`) como lo harías con
   cualquier WiFi normal. Mientras estés conectado a ella, tu laptop
   pierde el internet del router (a menos que uses WiFi + datos móviles
   en paralelo, o un adaptador USB-WiFi extra).
3. **Ponle IP fija a tu laptop dentro de esa red** — si no, el ESP32 no
   sabrá a qué IP mandar los datos. Debe quedar en `192.168.4.2`:

   **Windows:** Configuración → Red e Internet → Cambiar opciones del
   adaptador → clic derecho en el WiFi → Propiedades → Protocolo de
   Internet versión 4 (TCP/IPv4) → Propiedades → "Usar la siguiente
   dirección IP":
   - Dirección IP: `192.168.4.2`
   - Máscara de subred: `255.255.255.0`
   - Puerta de enlace: `192.168.4.1`

   **macOS:** Ajustes del Sistema → Red → WiFi → Detalles → TCP/IP →
   Configurar IPv4: "Manualmente":
   - Dirección IP: `192.168.4.2`
   - Máscara de subred: `255.255.255.0`
   - Router: `192.168.4.1`

4. **Corre el servidor** en la laptop (`cd server && node server.js`).
5. **Conecta el celular Android** a la misma red `HMI-ESP32` y abre
   `http://192.168.4.2:3000` en el navegador — verás el mismo dashboard.
6. El ESP32 empezará a mandar datos apenas detecte que hay alguien
   conectado a su red (revisa el Monitor Serial del Arduino IDE para
   confirmar que dice "POST enviado, respuesta HTTP 200").

> Si prefieres que el ESP32 sí tenga internet (por ejemplo para ver el
> dashboard también fuera de esa red), la alternativa es el esquema
> anterior: ESP32 en modo estación (`WiFi.begin`) conectado a tu router
> normal, y la laptop en esa misma red. Ese modo está documentado en el
> historial de este proyecto si lo necesitas más adelante.

### App en Android

No construimos una app nativa de Android (eso sería un proyecto aparte,
con Android Studio/Kotlin) — en su lugar, el dashboard ahora es una
**PWA (Progressive Web App)**: en Chrome para Android, al abrir
`http://192.168.4.2:3000`, aparece la opción **"Agregar a pantalla de
inicio" / "Instalar app"**. Una vez instalada, abre en pantalla completa
con su propio ícono, como cualquier otra app — sin pasar por una tienda
de aplicaciones. Usa exactamente los mismos datos que la página web,
porque es la misma página.

## 0.1 Alternativa: conexión por cable USB (Serial Port)

Si no quieres depender de WiFi para nada (ni router, ni Access Point del
ESP32), hay una tercera opción: conectar el ESP32 **por el mismo cable USB**
con el que lo programas, directo a la laptop/PC donde corre `server.js`.

**Cómo funciona:**

```
[ESP32] --- cable USB --- [Laptop: serial-bridge.js] --HTTP POST--> [server.js] --SQLite--> [dashboard web]
```

1. El ESP32 (con el firmware `esp32/esp32_hmi_serial.ino`) simplemente
   imprime una línea de texto JSON por el puerto Serial cada 5 segundos,
   por ejemplo:
   ```
   {"device_id":"esp32-serial-usb","device_ts":12345,"temperature":24.71,"pressure":1013.20,"humidity":55.30}
   ```
2. En la laptop, el script `server/serial-bridge.js` está "escuchando" ese
   puerto USB, lee cada línea, la interpreta como JSON y la reenvía por
   HTTP POST al mismo endpoint `/api/data` que ya usa el modo WiFi — así
   que `server.js` y la base de datos SQLite no cambian en nada.
3. El dashboard web sigue funcionando exactamente igual, porque a fin de
   cuentas los datos llegan al mismo lugar.

### Paso a paso

**1) Sube el firmware correcto al ESP32**

Abre `esp32/esp32_hmi_serial.ino` en el Arduino IDE y súbelo normal (este
archivo NO usa WiFi, solo el sensor BME280 y `Serial.println`). Déjalo
conectado por USB después de subirlo.

> Importante: cierra el "Monitor Serial" del Arduino IDE antes del
> siguiente paso — solo un programa a la vez puede usar el puerto USB.

**2) Instala las dependencias del servidor (si no lo habías hecho)**

```bash
cd server
npm install
```

Esto instala, entre otras cosas, el paquete `serialport` que usa el bridge.

**3) Encuentra el nombre de tu puerto serial**

- **Windows**: abre el "Administrador de dispositivos" → "Puertos (COM y
  LPT)" → busca algo como `COM3`, `COM5`, etc. (el ESP32 suele aparecer
  como "Silicon Labs CP210x" o "CH340").
- **macOS**: en una terminal, corre `ls /dev/tty.*` — busca algo como
  `/dev/tty.usbserial-0001` o `/dev/tty.SLAB_USBtoUART`.
- **Linux**: corre `ls /dev/ttyUSB*` o `ls /dev/ttyACM*` — normalmente
  `/dev/ttyUSB0`.

Si no estás seguro, puedes correr el bridge sin especificar el puerto y te
mostrará la lista de puertos detectados:

```bash
cd server
npm run serial-bridge
```

**4) Corre el bridge con el puerto correcto**

```bash
# Windows (PowerShell)
$env:SERIAL_PORT="COM5"; npm run serial-bridge

# macOS / Linux
SERIAL_PORT=/dev/ttyUSB0 npm run serial-bridge
```

**5) Corre el servidor normal, en OTRA terminal**

```bash
cd server
npm start
```

Con las dos terminales corriendo (`npm start` y `npm run serial-bridge`),
abre el dashboard en `http://localhost:3000` — deberías empezar a ver datos
en cuanto el bridge imprima líneas como `[bridge] OK  T=24.71  P=1013.20  H=55.30`.

### ¿Cuál método elegir?

| Método | Requiere WiFi | El ESP32 puede estar lejos de la laptop | Complejidad |
|---|---|---|---|
| **WiFi - Access Point** (`esp32_hmi.ino`) | Sí (la crea el ESP32) | Sí, dentro del alcance del WiFi | Media |
| **WiFi - conectado a tu router** | Sí (tu router) | Sí, dentro de tu red | Media |
| **Serial / USB** (`esp32_hmi_serial.ino`) | No | No, cable USB físico | Baja (la más simple de depurar) |

El modo Serial es el más recomendable mientras estás probando o
depurando el sensor, porque puedes ver directamente en la terminal lo que
manda el ESP32 línea por línea, sin preocuparte de contraseñas WiFi ni de
IPs. El modo WiFi es mejor cuando el ESP32 necesita estar en otro lugar
físico (por ejemplo, junto al proceso que estás monitoreando) y no puede
quedar amarrado por un cable a la computadora.

## 1. Backend (`server/`)

```bash
cd server
npm install
node server.js
```

Por defecto corre en `http://localhost:3000`. El dashboard se sirve automáticamente
en esa misma URL (carpeta `public/`).

Variables de entorno opcionales:

```bash
PORT=3000 DEVICE_KEY=mi-clave-secreta node server.js
```

**Guardado de datos:** cada lectura se guarda en `server/hmi_data.db` (SQLite).
No se pierde nada al reiniciar el servidor. Puedes exportar todo el historial
en CSV desde el botón "Exportar CSV" del dashboard o visitando
`http://localhost:3000/api/export.csv`.

### Endpoints

| Método | Ruta                  | Uso                                            |
|--------|-----------------------|-------------------------------------------------|
| POST   | `/api/data`            | El ESP32 envía una lectura (requiere header `x-device-key`) |
| GET    | `/api/latest`          | Última lectura (para los gauges)                |
| GET    | `/api/history?limit=N` | Últimas N lecturas (para la gráfica)             |
| GET    | `/api/history/range?from=&to=` | Lecturas entre dos timestamps (epoch ms) |
| GET    | `/api/export.csv`      | Descarga todo el historial en CSV                |
| POST   | `/api/log`             | Crea un registro de operador (ver sección 1.1)   |
| GET    | `/api/log?fecha=YYYY-MM-DD` | Registros de operador de un día              |
| GET    | `/api/log/days`        | Lista de días con registros (y cuántos cada uno) |
| GET    | `/api/log/export.csv`  | Descarga todo el registro de operador en CSV     |

Ejemplo de body para `POST /api/data`:

```json
{
  "device_id": "esp32-planta-1",
  "device_ts": 123456,
  "temperature": 24.7,
  "pressure": 1013.2,
  "humidity": 55.3
}
```

## 1.1 Monitor — Registro de operador (`public/monitor.html`)

Pantalla aparte, pensada como un "monitor" dedicado solo a la base de datos
de uso: quién usó el sistema, qué día, a qué hora, y una nota de qué hizo.
Se abre desde el botón **"📋 Registro de operador"** en la pantalla
principal, o directo en `http://localhost:3000/monitor.html`.

**Cómo se guarda cada registro:**
- **Operador**: nombre de la persona (campo obligatorio).
- **Nota**: qué hizo / observaciones (campo libre, opcional).
- **Fecha** y **hora**: las calcula el servidor automáticamente en el
  momento de guardar (zona horaria `America/Mexico_City` por defecto,
  configurable con la variable de entorno `TIMEZONE`) — así el registro es
  confiable aunque el reloj de la laptop esté mal puesto, y no hay que
  escribirlas a mano.

Los datos quedan en una tabla nueva de la misma base de datos SQLite
(`operator_log`, dentro de `hmi_data.db`) — no es una base de datos
distinta, solo una tabla más junto a `readings`. Se crea sola la primera
vez que corres `npm start`, igual que la tabla de lecturas del ESP32.

En la pantalla del monitor puedes:
- Ver el historial de un día específico con el selector "Ver día".
- Agregar un registro nuevo (Enter en el campo "Operador" también guarda).
- Exportar todo el registro como CSV.

Ejemplo de body para `POST /api/log`:

```json
{
  "operador": "Julia",
  "nota": "Se calibró el sensor BME280 y se cambió el setpoint a 45°C"
}
```

## 2. Firmware ESP32 (`esp32/esp32_hmi.ino`)

> Este es el firmware para los dos modos WiFi (Access Point o router). Si
> vas a usar la conexión por cable USB en su lugar, usa
> `esp32/esp32_hmi_serial.ino` y sigue la sección **0.1** de arriba.

Usa un sensor **BME280** (temperatura + presión + humedad en un solo módulo,
conectado por I2C). Antes de subirlo:

1. Instala las librerías `Adafruit BME280 Library` y `Adafruit Unified Sensor`
   desde el Administrador de Librerías del Arduino IDE.
2. Edita al inicio del archivo:
   - `WIFI_SSID` / `WIFI_PASSWORD`
   - `SERVER_URL` → la IP de la máquina donde corre `server.js`, por ejemplo
     `http://192.168.1.100:3000/api/data`
   - `DEVICE_KEY` → debe ser **igual** a la del backend

Si usas otro sensor (DHT22, BMP280, etc.), solo cambia el bloque marcado como
`LECTURA DE SENSOR` dentro de `loop()`; el resto del código no cambia.

## 3. Dashboard (`public/index.html`)

Se abre solo, servido por el mismo backend. Pensado para:

- **PC**: se ve como panel de control de 3 columnas con gráfica de historial.
- **Tablet / pantalla táctil (modo kiosco)**: el layout es responsive y cambia
  a una columna en pantallas angostas. Para modo kiosco real en Chrome:

  ```bash
  chromium --kiosk http://IP_DEL_SERVIDOR:3000
  ```

Controles disponibles en el dashboard:
- Frecuencia de refresco (1 s a 10 s)
- Cantidad de puntos mostrados en la gráfica
- Exportar historial completo a CSV
- Indicador de "EN LÍNEA / SIN DATOS" según la antigüedad del último dato

## Ajustar los rangos de los gauges

En `public/index.html`, al inicio del `<script>`, el objeto `RANGES` define
los mínimos/máximos esperados de cada variable (usados solo para pintar la
barra de nivel, no filtran datos):

```js
const RANGES = {
  temperature: { min: 0, max: 50 },
  pressure:    { min: 900, max: 1100 },
  humidity:    { min: 0, max: 100 },
};
```

## Notas de seguridad para producción

- Cambia `DEVICE_KEY` por algo largo y aleatorio.
- Si el servidor va a estar expuesto a internet (no solo red local), ponlo
  detrás de HTTPS (por ejemplo con un reverse proxy Nginx + Let's Encrypt).
- Considera agregar autenticación al dashboard si va a estar accesible fuera
  de tu red local.
