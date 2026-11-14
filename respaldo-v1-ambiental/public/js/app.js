// app.js — lógica del HMI (lectura de datos, agujas, LCDs, tendencia)

const RANGES = {
  temperature: { min: 0, max: 50 },
  pressure:    { min: 900, max: 1100 },
  humidity:    { min: 0, max: 100 },
};

const GAUGE_START = 225; // bearing inicial (grados)
const GAUGE_SWEEP = 270; // barrido total (grados)

function setNeedle(id, cx, cy, value, range){
  const el = document.getElementById(id);
  if (!el) return;
  const f = Math.max(0, Math.min(1, (value - range.min) / (range.max - range.min)));
  const bearing = GAUGE_START + f * GAUGE_SWEEP;
  el.setAttribute('transform', `rotate(${bearing}, ${cx}, ${cy})`);
}

function fmt(n, digits = 1){
  if (n === null || n === undefined || Number.isNaN(n)) return '--';
  return Number(n).toFixed(digits);
}

// ---------------- Gráfica de tendencia ----------------
let chart;
function setupChart(){
  const ctx = document.getElementById('historyChart').getContext('2d');
  chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        { label: 'Temp (°C)', data: [], borderColor: '#f2a83c', backgroundColor: 'rgba(242,168,60,0.08)', yAxisID: 'yTemp', tension: 0.35, pointRadius: 0, borderWidth: 2 },
        { label: 'Presión (hPa)', data: [], borderColor: '#48e0d8', backgroundColor: 'rgba(72,224,216,0.06)', yAxisID: 'yPres', tension: 0.35, pointRadius: 0, borderWidth: 2 },
        { label: 'Humedad (%)', data: [], borderColor: '#b79bf0', backgroundColor: 'rgba(183,155,240,0.06)', yAxisID: 'yHum', tension: 0.35, pointRadius: 0, borderWidth: 2 },
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#cfe9ee', font: { family: 'IBM Plex Mono', size: 9 }, boxWidth: 10 } }
      },
      scales: {
        x: { ticks: { color: '#6f97a2', font: { size: 8 }, maxTicksLimit: 5 }, grid: { color: 'rgba(255,255,255,0.05)' } },
        yTemp: { position: 'left', ticks: { color: '#f2a83c', font: { size: 8 } }, grid: { color: 'rgba(255,255,255,0.05)' } },
        yPres: { position: 'right', ticks: { color: '#48e0d8', font: { size: 8 } }, grid: { display: false } },
        yHum:  { position: 'right', ticks: { color: '#b79bf0', font: { size: 8 } }, grid: { display: false }, display: false }
      }
    }
  });
}

// ---------------- Estado / polling ----------------
let pollMs = 1000;
let historyLimit = 150;
let pollTimer = null;

function setOnline(online){
  document.getElementById('ledRun').classList.toggle('on-green', online);
  document.getElementById('ledErr').classList.toggle('on-red', !online);
  document.getElementById('flowDot').classList.toggle('off', !online);
  document.getElementById('lcdStatus').textContent = online ? 'EN LÍNEA' : 'SIN DATOS';
  document.getElementById('wifiIcon').style.opacity = online ? '1' : '0.35';
  document.getElementById('txLed').setAttribute('fill', online ? '#35c766' : '#3a4f45');
  document.getElementById('serverLed').setAttribute('fill', online ? '#35c766' : '#7a8a92');
}

async function pollLatest(){
  try{
    const res = await fetch('/api/latest', { cache: 'no-store' });
    const row = await res.json();
    if (!row){ setOnline(false); return; }

    document.getElementById('lcdDevice').textContent = row.device_id;
    document.getElementById('lcdTime').textContent = new Date(row.ts).toLocaleTimeString();

    // Se considera "en línea" si llegó un dato en los últimos 12s,
    // independientemente de cada cuánto refresca el dashboard
    // (el ESP32 de ejemplo envía cada 5s por defecto).
    const FRESH_WINDOW_MS = 12000;
    const fresh = Date.now() - row.ts < FRESH_WINDOW_MS;
    setOnline(fresh);

    document.querySelector('#lcdTemp').childNodes[0].nodeValue = fmt(row.temperature, 1) + ' ';
    document.querySelector('#lcdPres').childNodes[0].nodeValue = fmt(row.pressure, 1) + ' ';
    document.querySelector('#lcdHum').childNodes[0].nodeValue = fmt(row.humidity, 1) + ' ';

    setNeedle('needle-temp', 170, 140, row.temperature ?? RANGES.temperature.min, RANGES.temperature);
    setNeedle('needle-pres', 255, 140, row.pressure ?? RANGES.pressure.min, RANGES.pressure);
    setNeedle('needle-hum', 340, 140, row.humidity ?? RANGES.humidity.min, RANGES.humidity);
  }catch(e){
    setOnline(false);
  }
}

async function pollHistory(){
  try{
    const res = await fetch('/api/history?limit=' + historyLimit, { cache: 'no-store' });
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) return;
    chart.data.labels = rows.map(r => new Date(r.ts).toLocaleTimeString());
    chart.data.datasets[0].data = rows.map(r => r.temperature);
    chart.data.datasets[1].data = rows.map(r => r.pressure);
    chart.data.datasets[2].data = rows.map(r => r.humidity);
    chart.update('none');
  }catch(e){ /* se reintenta en el siguiente ciclo */ }
}

function startPolling(){
  if (pollTimer) clearInterval(pollTimer);
  pollLatest(); pollHistory();
  pollTimer = setInterval(() => { pollLatest(); pollHistory(); }, pollMs);
}

document.querySelectorAll('.mode-buttons .pill-btn[data-ms]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.pill-btn[data-ms]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    pollMs = parseInt(btn.dataset.ms, 10);
    startPolling();
  });
});

document.getElementById('kioskBtn').addEventListener('click', () => {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen();
  else document.exitFullscreen();
});

setupChart();
startPolling();

// Registro del service worker (permite instalar esto como app en Android)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* si falla (p. ej. abierto como file://) simplemente no se instala */
    });
  });
}

// En celular el diagrama se recorta a la zona del proceso
// (cámara, ESP32 y servidor); en computadora se ve completo.
(function ajustarDiagramaCelular(){
  const svg = document.querySelector('.canvas svg');
  if (!svg) return;
  const mq = window.matchMedia('(max-width: 700px)');
  const aplicar = () => svg.setAttribute('viewBox', mq.matches ? '100 95 700 320' : '0 0 1000 560');
  aplicar();
  mq.addEventListener('change', aplicar);
})();

// ---------- Botón "Ver en celular": dirección + código QR ----------
(function verEnCelular(){
  const btn = document.getElementById('btnCelular');
  const modal = document.getElementById('celModal');
  const contenido = document.getElementById('celContenido');
  if (!btn || !modal) return;

  function qrSvg(texto){
    if (typeof qrcode !== 'function') return '';
    const qr = qrcode(0, 'M');          // tamaño automático, corrección media
    qr.addData(texto);
    qr.make();
    return qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
  }

  function escapar(s){
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  async function abrir(){
    modal.hidden = false;
    contenido.textContent = 'Buscando la dirección…';
    try{
      const res = await fetch('/api/red', { cache: 'no-store' });
      const info = await res.json();
      const dirs = info.direcciones || [];
      if (dirs.length === 0){
        contenido.innerHTML = '<p class="cel-aviso">Esta computadora no está conectada a ninguna red WiFi. Conéctala y vuelve a intentar.</p>';
        return;
      }
      contenido.innerHTML = dirs.map(d => `
        <div class="cel-opcion">
          <div class="cel-qr">${qrSvg(d.url)}</div>
          <div class="cel-url">${escapar(d.url)}</div>
          <div class="cel-red">${escapar(d.nombre)}${d.esRedEsp32 ? ' · red HMI-ESP32' : ''}</div>
        </div>`).join('');
    }catch(e){
      contenido.innerHTML = '<p class="cel-aviso">No se pudo obtener la dirección. Reinicia el servidor con iniciar-servidor-mysql.bat.</p>';
    }
  }

  function cerrar(){ modal.hidden = true; }

  btn.addEventListener('click', abrir);
  document.getElementById('celCerrar').addEventListener('click', cerrar);
  modal.addEventListener('click', (e) => { if (e.target === modal) cerrar(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') cerrar(); });
})();
