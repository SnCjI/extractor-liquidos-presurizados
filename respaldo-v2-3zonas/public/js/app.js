// app.js — lógica del HMI del extractor de líquidos presurizados (H2O, 3 zonas)
// Lee del servidor las lecturas del ESP32 y los ajustes, actualiza el
// diagrama animado, las tarjetas y la gráfica, y manda los cambios de
// ajuste y el encendido/apagado del sistema.

const ZONAS = [1, 2, 3];
const COLOR_ZONA = { 1: '#c47a12', 2: '#169486', 3: '#8c6be0' };
const VENTANA_EN_LINEA_MS = 12000;   // sin datos por más de 12 s = "SIN DATOS"
const TZ = 'America/Mexico_City';

let refrescoMs = 1000;
let timerLatest = null;
let setpoints = null;     // último valor de /api/setpoints
let enLinea = false;

const $ = (id) => document.getElementById(id);
const fmt = (v, d = 1) => (v === null || v === undefined || Number.isNaN(Number(v)) ? '--.-' : Number(v).toFixed(d));
const horaLocal = (ts) => new Date(Number(ts)).toLocaleTimeString('es-MX', { timeZone: TZ, hour12: false });

// ---------- Reloj ----------
setInterval(() => { $('clock').textContent = new Date().toLocaleTimeString('es-MX', { timeZone: TZ, hour12: false }); }, 1000);

// ---------- Nombre del operador (se recuerda solo en este dispositivo) ----------
function operadorGuardado(){ try { return localStorage.getItem('hmi_operador') || ''; } catch { return ''; } }
function guardarOperador(n){ try { localStorage.setItem('hmi_operador', n); } catch { /* sin almacenamiento */ } }

// ---------- Pintar el estado ----------
function estadoZona(z, row){
  const t = row ? row['t_z' + z] : null;
  const ssr = row ? row['ssr' + z] : 0;
  const sp = setpoints ? setpoints['sp_z' + z] : null;
  if (!enLinea) return { clase: '', texto: 'SIN DATOS' };
  if (t === null || t === undefined) return { clase: 'fault', texto: 'FALLA SONDA' };
  if (ssr) return { clase: 'on', texto: 'CALENTANDO' };
  if (!row.sistema_on) return { clase: '', texto: 'APAGADO' };
  if (sp !== null && Math.abs(t - sp) <= 2) return { clase: 'ok', texto: 'EN AJUSTE' };
  return { clase: '', texto: 'EN ESPERA' };
}

function pintar(row){
  const svg = $('processSvg');
  const sistemaOn = !!(row && row.sistema_on && enLinea);
  svg.classList.toggle('sistema-on', sistemaOn);

  // Conexión
  $('connPill').classList.toggle('online', enLinea);
  $('connText').textContent = enLinea ? 'EN LÍNEA' : 'SIN DATOS';

  // Barra de control
  const spOn = setpoints && setpoints.sistema_on;
  const btn = $('powerBtn');
  btn.classList.toggle('on', !!spOn);
  btn.setAttribute('aria-pressed', spOn ? 'true' : 'false');
  $('powerTxt').textContent = spOn ? 'SISTEMA ENCENDIDO · APAGAR' : 'ENCENDER SISTEMA';
  let estado = 'Apagado';
  if (spOn && !enLinea) estado = 'Encendido en el HMI, pero el ESP32 no responde';
  else if (spOn && row && !row.sistema_on) estado = 'Encendiendo… (esperando al ESP32)';
  else if (spOn) estado = 'Encendido: controlando temperatura';
  $('sysState').textContent = estado;
  if (setpoints && setpoints.actualizado_ts) {
    $('lastSet').textContent = `${horaLocal(setpoints.actualizado_ts)} · ${setpoints.actualizado_por || ''}`;
  }

  // Alarma
  const alarma = enLinea && row && row.alarma ? row.alarma : (!enLinea && spOn ? 'No llegan datos del ESP32. Revisa que esté encendido y conectado a la red HMI-ESP32.' : '');
  $('alarmBox').hidden = !alarma;
  $('alarmTxt').textContent = alarma;

  // Zonas
  let encendidas = 0;
  for (const z of ZONAS){
    const t = row ? row['t_z' + z] : null;
    const ssr = !!(row && row['ssr' + z] && enLinea);
    if (ssr) encendidas++;
    const sp = setpoints ? setpoints['sp_z' + z] : null;
    const est = estadoZona(z, row);
    const falla = est.clase === 'fault';

    $('zona' + z).classList.toggle('on', ssr);
    $('zona' + z).classList.toggle('fault', falla);
    $('ztag' + z).classList.toggle('on', ssr);
    $('ztag' + z).classList.toggle('fault', falla);
    $('ssrBox' + z).classList.toggle('on', ssr);
    $('zt' + z).textContent = enLinea ? (t === null || t === undefined ? 'FALLA' : fmt(t) + ' °C') : '--.- °C';
    $('zsp' + z).textContent = sp === null ? '--' : fmt(sp, 0);

    $('zval' + z).textContent = enLinea ? fmt(t) : '--.-';
    $('zspv' + z).textContent = sp === null ? '--' : fmt(sp, 1);
    const st = $('zstate' + z);
    st.textContent = est.texto;
    st.className = 'zstate ' + est.clase;

    // Barra: 0 a (máximo permitido) °C, con marca en el ajuste
    const max = setpoints ? setpoints.sp_max : 120;
    const pct = (v) => Math.max(0, Math.min(100, (v / max) * 100));
    $('zbar' + z).style.width = enLinea && t !== null && t !== undefined ? pct(t) + '%' : '0%';
    $('zbarsp' + z).style.left = sp === null ? '0' : `calc(${pct(sp)}% - 1px)`;
  }

  // Tarjeta del equipo
  $('devId').textContent = row ? row.device_id : '—';
  $('lastRead').textContent = row ? horaLocal(row.ts) : '—';
  const p = row ? row.presion : null;
  $('presCard').textContent = p === null || p === undefined ? 'sin sensor' : fmt(p) + ' bar';
  $('presTxt').textContent = p === null || p === undefined ? 'sin sensor' : fmt(p) + ' bar';
  $('ssrCount').textContent = enLinea ? `${encendidas}/3 ON` : '—';
}

// ---------- Lectura periódica ----------
async function pollLatest(){
  try{
    const [rLatest, rSp] = await Promise.all([
      fetch('/api/latest', { cache: 'no-store' }),
      fetch('/api/setpoints', { cache: 'no-store' }),
    ]);
    const row = await rLatest.json();
    setpoints = await rSp.json();
    // La "edad" del dato se calcula con el reloj del servidor, así funciona
    // aunque la hora del celular esté mal.
    enLinea = !!row && (row.server_now - row.ts) < VENTANA_EN_LINEA_MS;
    pintar(row);
  }catch(e){
    enLinea = false;
    pintar(null);
  }
}

function startPolling(){
  if (timerLatest) clearInterval(timerLatest);
  pollLatest();
  timerLatest = setInterval(pollLatest, refrescoMs);
}

document.querySelectorAll('[data-ms]').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('[data-ms]').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    refrescoMs = Number(b.dataset.ms);
    startPolling();
  });
});

// ---------- Gráfica ----------
let chart = null;
function setupChart(){
  const ctx = $('historyChart').getContext('2d');
  const datasets = [];
  for (const z of ZONAS){
    datasets.push({
      label: 'Zona ' + z, data: [], borderColor: COLOR_ZONA[z], backgroundColor: COLOR_ZONA[z],
      borderWidth: 2, pointRadius: 0, pointHoverRadius: 5, tension: 0.25, spanGaps: false,
    });
  }
  for (const z of ZONAS){
    datasets.push({
      label: 'Ajuste zona ' + z, data: [], borderColor: COLOR_ZONA[z], borderWidth: 1.5,
      borderDash: [6, 5], pointRadius: 0, pointHoverRadius: 0, tension: 0, esAjuste: true,
    });
  }
  chart = new Chart(ctx, {
    type: 'line',
    data: { labels: [], datasets },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          labels: {
            color: '#cfc6bb', boxWidth: 14, boxHeight: 3, font: { size: 11 },
            filter: (item, data) => !data.datasets[item.datasetIndex].esAjuste,
          },
        },
        tooltip: {
          filter: (item) => !item.dataset.esAjuste,
          callbacks: { label: (c) => `${c.dataset.label}: ${c.parsed.y === null ? '—' : c.parsed.y.toFixed(1) + ' °C'}` },
        },
      },
      scales: {
        x: { ticks: { color: '#8f9ba1', maxTicksLimit: 6, font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.05)' } },
        y: {
          title: { display: true, text: '°C', color: '#8f9ba1', font: { size: 11 } },
          ticks: { color: '#8f9ba1', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.07)' },
        },
      },
    },
  });
}

async function pollHistory(){
  try{
    const res = await fetch('/api/history?limit=180', { cache: 'no-store' });
    const rows = (await res.json()).filter((r) => r.t_z1 !== null || r.t_z2 !== null || r.t_z3 !== null);
    chart.data.labels = rows.map((r) => horaLocal(r.ts));
    ZONAS.forEach((z, i) => {
      chart.data.datasets[i].data = rows.map((r) => r['t_z' + z]);
      const sp = setpoints ? setpoints['sp_z' + z] : null;
      chart.data.datasets[i + 3].data = rows.map(() => sp);
    });
    chart.update('none');
  }catch(e){ /* se reintenta en el siguiente ciclo */ }
}

// ---------- Ventana de ajuste / encendido ----------
const modal = $('adjModal');
let modo = null;   // { tipo: 'zona', z } o { tipo: 'power', encender }

function abrirAjuste(z){
  if (!setpoints) return;
  modo = { tipo: 'zona', z };
  $('adjTitle').textContent = `Ajuste de temperatura — Zona ${z}`;
  $('adjDesc').textContent = 'Temperatura que el ESP32 debe mantener en esta zona encendiendo y apagando su resistencia.';
  $('adjValueRow').hidden = false;
  $('adjRange').hidden = false;
  const inp = $('adjInput');
  inp.min = setpoints.sp_min; inp.max = setpoints.sp_max;
  inp.value = setpoints['sp_z' + z];
  $('adjRange').textContent = `Permitido: ${setpoints.sp_min} a ${setpoints.sp_max} °C`;
  $('adjOk').textContent = 'Aplicar ajuste';
  abrirModal();
}

function abrirPower(){
  if (!setpoints) return;
  const encender = !setpoints.sistema_on;
  modo = { tipo: 'power', encender };
  $('adjTitle').textContent = encender ? '⏻ Encender el sistema' : '⏻ Apagar el sistema';
  $('adjDesc').textContent = encender
    ? `Se activarán las resistencias para llevar las zonas a ${setpoints.sp_z1} / ${setpoints.sp_z2} / ${setpoints.sp_z3} °C. Revisa que el extractor tenga agua y que la válvula esté en la posición correcta.`
    : 'Se apagarán las 3 resistencias. Las lecturas de temperatura siguen llegando.';
  $('adjValueRow').hidden = true;
  $('adjRange').hidden = true;
  $('adjOk').textContent = encender ? 'Sí, encender' : 'Sí, apagar';
  abrirModal();
}

function abrirModal(){
  $('adjStatus').textContent = '';
  $('adjStatus').className = 'adj-status';
  $('adjOperador').value = operadorGuardado();
  modal.hidden = false;
  (modo.tipo === 'zona' ? $('adjInput') : ($('adjOperador').value ? $('adjOk') : $('adjOperador'))).focus();
}
function cerrarModal(){ modal.hidden = true; modo = null; }

document.querySelectorAll('.adj-btn').forEach((b) => b.addEventListener('click', () => abrirAjuste(Number(b.dataset.z))));
document.querySelectorAll('.step').forEach((b) => b.addEventListener('click', () => {
  const inp = $('adjInput');
  const v = (Number(inp.value) || 0) + Number(b.dataset.step);
  inp.value = Math.max(Number(inp.min), Math.min(Number(inp.max), v));
}));
modal.querySelectorAll('[data-cerrar]').forEach((b) => b.addEventListener('click', cerrarModal));
modal.addEventListener('click', (e) => { if (e.target === modal) cerrarModal(); });
$('powerBtn').addEventListener('click', abrirPower);

$('adjForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!modo) return;
  const operador = $('adjOperador').value.trim();
  const status = $('adjStatus');
  if (!operador){
    status.textContent = 'Escribe el nombre del operador.';
    status.className = 'adj-status error';
    $('adjOperador').focus();
    return;
  }
  const cuerpo = { operador };
  if (modo.tipo === 'zona'){
    const v = Number($('adjInput').value);
    if (!Number.isFinite(v) || v < setpoints.sp_min || v > setpoints.sp_max){
      status.textContent = `El valor debe estar entre ${setpoints.sp_min} y ${setpoints.sp_max} °C.`;
      status.className = 'adj-status error';
      return;
    }
    cuerpo['sp_z' + modo.z] = v;
  } else {
    cuerpo.sistema_on = modo.encender ? 1 : 0;
  }

  const ok = $('adjOk');
  ok.disabled = true;
  status.textContent = 'Enviando…';
  status.className = 'adj-status';
  try{
    const res = await fetch('/api/setpoints', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo),
    });
    const data = await res.json();
    if (!res.ok || !data.ok){
      status.textContent = 'Error: ' + (data.error || res.status);
      status.className = 'adj-status error';
      return;
    }
    guardarOperador(operador);
    setpoints = data.setpoints;
    status.textContent = data.sin_cambios ? 'Sin cambios.' : 'Guardado ✓';
    await pollLatest();
    pollHistory();
    setTimeout(cerrarModal, 600);
  }catch(err){
    status.textContent = 'No se pudo contactar al servidor.';
    status.className = 'adj-status error';
  }finally{
    ok.disabled = false;
  }
});

document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) cerrarModal(); });

// ---------- Modo kiosco ----------
$('kioskBtn').addEventListener('click', () => {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
  else document.exitFullscreen();
});

// ---------- Botón "Ver en celular": dirección + código QR ----------
(function verEnCelular(){
  const btn = $('btnCelular');
  const cel = $('celModal');
  const contenido = $('celContenido');
  if (!btn || !cel) return;

  function qrSvg(texto){
    if (typeof qrcode !== 'function') return '';
    const qr = qrcode(0, 'M');
    qr.addData(texto);
    qr.make();
    return qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
  }
  const escapar = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  async function abrir(){
    cel.hidden = false;
    contenido.textContent = 'Buscando la dirección…';
    try{
      const info = await (await fetch('/api/red', { cache: 'no-store' })).json();
      const dirs = info.direcciones || [];
      contenido.innerHTML = dirs.length === 0
        ? '<p class="cel-aviso">Esta computadora no está conectada a ninguna red WiFi. Conéctala y vuelve a intentar.</p>'
        : dirs.map((d) => `
          <div class="cel-opcion">
            <div class="cel-qr">${qrSvg(d.url)}</div>
            <div class="cel-url">${escapar(d.url)}</div>
            <div class="cel-red">${escapar(d.nombre)}${d.esRedEsp32 ? ' · red HMI-ESP32' : ''}</div>
          </div>`).join('');
    }catch(e){
      contenido.innerHTML = '<p class="cel-aviso">No se pudo obtener la dirección. Reinicia el servidor con iniciar-servidor-mysql.bat.</p>';
    }
  }
  const cerrar = () => { cel.hidden = true; };
  btn.addEventListener('click', abrir);
  $('celCerrar').addEventListener('click', cerrar);
  cel.addEventListener('click', (e) => { if (e.target === cel) cerrar(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') cerrar(); });
})();

// ---------- Arranque ----------
setupChart();
(async () => {
  await pollLatest();          // primero los ajustes, para dibujar sus líneas
  startPolling();
  pollHistory();
  setInterval(pollHistory, 5000);
})();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* sin instalación como app */ });
  });
}
