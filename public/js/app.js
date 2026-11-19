// app.js — HMI del extractor de líquidos presurizados (H2O, 2 zonas)
// Tres pestañas:
//   🏠 Inicio  — diagrama animado, tarjetas de zona, encendido y ajustes
//   📈 Gráfica — gráfica grande con rango de tiempo y actividad de resistencias
//   📋 Datos   — tabla tipo Excel: bitácora (quién cambió qué) y lecturas, con descarga CSV

const ZONAS = [1, 2];
const COLOR_ZONA = { 1: '#c47a12', 2: '#169486' };
const NOMBRE_ZONA = { 1: 'superior', 2: 'inferior' };
const VENTANA_EN_LINEA_MS = 12000;   // sin datos por más de 12 s = "SIN DATOS"
const TZ = 'America/Mexico_City';

let refrescoMs = 1000;
let timerLatest = null;
let setpoints = null;     // último valor de /api/setpoints
let ultimaFila = null;    // última lectura del ESP32
let enLinea = false;
let vistaActual = 'inicio';

const $ = (id) => document.getElementById(id);
const fmt = (v, d = 1) => (v === null || v === undefined || Number.isNaN(Number(v)) ? '--.-' : Number(v).toFixed(d));
const horaLocal = (ts) => new Date(Number(ts)).toLocaleTimeString('es-MX', { timeZone: TZ, hour12: false });
const hoyLocal = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const escapar = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---------- Reloj ----------
setInterval(() => { $('clock').textContent = new Date().toLocaleTimeString('es-MX', { timeZone: TZ, hour12: false }); }, 1000);

// ---------- Nombre del operador (se recuerda solo en este dispositivo) ----------
function operadorGuardado(){ try { return localStorage.getItem('hmi_operador') || ''; } catch { return ''; } }
function guardarOperador(n){ try { localStorage.setItem('hmi_operador', n); } catch { /* sin almacenamiento */ } }

/* =====================================================================
   PESTAÑAS
   ===================================================================== */
const VISTAS = ['inicio', 'grafica', 'datos'];

function mostrarVista(nombre){
  if (!VISTAS.includes(nombre)) nombre = 'inicio';
  vistaActual = nombre;
  for (const v of VISTAS){
    $('vista-' + v).hidden = v !== nombre;
    $('tab-' + v).setAttribute('aria-selected', v === nombre ? 'true' : 'false');
  }
  if (nombre === 'grafica') cargarGrafica();
  if (nombre === 'datos') cargarTabla();
}
window.addEventListener('hashchange', () => mostrarVista(location.hash.slice(1)));

/* =====================================================================
   ESTADO EN VIVO (todas las pestañas)
   ===================================================================== */
function estadoZona(z, row){
  const t = row ? row['t_z' + z] : null;
  const ssr = row ? row['ssr' + z] : 0;
  const sp = setpoints ? setpoints['sp_z' + z] : null;
  if (!enLinea) return { clase: '', texto: 'SIN DATOS' };
  if (row && row.esp32 && row.esp32['inst' + z] === 0) return { clase: '', texto: 'NO CONECTADA' };
  if (t === null || t === undefined) return { clase: 'fault', texto: 'FALLA TERMOPAR' };
  const pot = row ? row['pot' + z] : null;
  if (ssr) return { clase: 'on', texto: pot === null || pot === undefined ? 'CALENTANDO' : `CALENTANDO ${Math.round(pot)} %` };
  if (!row.sistema_on) return { clase: '', texto: 'APAGADO' };
  if (sp !== null && Math.abs(t - sp) <= 2) return { clase: 'ok', texto: 'EN AJUSTE' };
  return { clase: '', texto: 'EN ESPERA' };
}

function pintar(row){
  const sistemaOn = !!(row && row.sistema_on && enLinea);
  $('processSvg').classList.toggle('sistema-on', sistemaOn);

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
  if (setpoints && setpoints.actualizado_ts){
    $('lastSet').textContent = `${horaLocal(setpoints.actualizado_ts)} · ${setpoints.actualizado_por || ''}`;
  }

  // Alarma
  const alarma = enLinea && row && row.alarma ? row.alarma
    : (!enLinea && spOn ? 'No llegan datos del ESP32. Revisa que esté encendido y conectado a la red HMI-ESP32.' : '');
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
    const tTxt = enLinea ? (t === null || t === undefined ? 'FALLA' : fmt(t)) : '--.-';

    // Inicio: diagrama
    $('zona' + z).classList.toggle('on', ssr);
    $('zona' + z).classList.toggle('fault', falla);
    $('ztag' + z).classList.toggle('on', ssr);
    $('ztag' + z).classList.toggle('fault', falla);
    $('ssrBox' + z).classList.toggle('on', ssr);
    $('zt' + z).textContent = tTxt === 'FALLA' ? 'FALLA' : tTxt + ' °C';
    $('zsp' + z).textContent = sp === null ? '--' : fmt(sp, 0);

    // Inicio: tarjeta
    $('zval' + z).textContent = tTxt;
    $('zspv' + z).textContent = sp === null ? '--' : fmt(sp, 1);
    for (const id of ['zstate' + z, 'gst' + z]){
      $(id).textContent = est.texto;
      $(id).className = 'zstate ' + est.clase;
    }
    const max = setpoints ? setpoints.sp_max : 100;
    const pct = (v) => Math.max(0, Math.min(100, (v / max) * 100));
    $('zbar' + z).style.width = enLinea && t !== null && t !== undefined ? pct(t) + '%' : '0%';
    $('zbarsp' + z).style.left = sp === null ? '0' : `calc(${pct(sp)}% - 1px)`;
    if (setpoints && setpoints.sp_recomendado) $('zbarrec' + z).style.left = pct(setpoints.sp_recomendado) + '%';

    // Potencia que el PID le da a la resistencia (0 a 100 %)
    const pot = enLinea && row ? row['pot' + z] : null;
    const hayPot = pot !== null && pot !== undefined;
    $('zpot' + z).style.width = hayPot ? Math.max(0, Math.min(100, pot)) + '%' : '0%';
    $('zpotv' + z).textContent = hayPot ? Math.round(pot) + ' %' : '—';

    // Ganancias del PID: las guardadas y si el ESP32 ya las está usando
    if (setpoints && setpoints['kp' + z] !== undefined){
      const g = gananciasZona(z);
      $('zpid' + z).textContent = `PID kp ${numCorto(g.kp)} · ki ${numCorto(g.ki)} · kd ${numCorto(g.kd)}`;
      const eco = row && row.esp32;
      const okEl = $('zpidok' + z);
      if (!enLinea || !eco || eco['kp' + z] === undefined){
        okEl.textContent = ''; okEl.className = 'zpid-ok';
      } else if (['kp', 'ki', 'kd'].every((k) => Math.abs(eco[k + z] - g[k]) < 1e-6)){
        okEl.textContent = '✓ en el ESP32'; okEl.className = 'zpid-ok ok';
      } else {
        okEl.textContent = '⏳ enviando…'; okEl.className = 'zpid-ok pend';
      }
    }

    // Gráfica: mosaicos en vivo
    $('gz' + z).textContent = tTxt;
    $('gsp' + z).textContent = sp === null ? '--' : fmt(sp, 0);
  }

  // Tarjeta del equipo
  $('devId').textContent = row ? row.device_id : '—';
  $('lastRead').textContent = row ? horaLocal(row.ts) : '—';
  const p = row ? row.presion : null;
  $('presCard').textContent = p === null || p === undefined ? 'sin sensor' : fmt(p) + ' bar';
  $('presTxt').textContent = p === null || p === undefined ? 'sin sensor' : fmt(p) + ' bar';
  $('ssrCount').textContent = enLinea ? `${encendidas}/${ZONAS.length} ON` : '—';
}

async function pollLatest(){
  try{
    const [rLatest, rSp] = await Promise.all([
      fetch('/api/latest', { cache: 'no-store' }),
      fetch('/api/setpoints', { cache: 'no-store' }),
    ]);
    const row = await rLatest.json();
    setpoints = await rSp.json();
    ultimaFila = row;
    // La edad del dato se calcula con el reloj del servidor (el del celular puede estar mal).
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

/* =====================================================================
   PESTAÑA 2 · GRÁFICA
   ===================================================================== */
let rangoMs = 1800000;      // 30 min por defecto; 'hoy' = desde la medianoche
let grafica = null;
let datosGrafica = [];       // filas mostradas (para las franjas de resistencias)
let timerGrafica = null;

// Dibuja, al pie de la gráfica, una franja por zona donde su resistencia estuvo encendida.
const franjasResistencias = {
  id: 'franjasResistencias',
  afterDatasetsDraw(chart){
    const { ctx, chartArea, scales } = chart;
    if (!datosGrafica.length) return;
    const n = datosGrafica.length;
    ZONAS.forEach((z, k) => {
      if (!chart.isDatasetVisible(k)) return;
      const alto = 6, y = chartArea.bottom - (k + 1) * (alto + 2);
      ctx.save();
      ctx.fillStyle = COLOR_ZONA[z];
      for (let i = 0; i < n; i++){
        const pot = datosGrafica[i]['pot' + z];
        if (pot !== null && pot !== undefined){
          if (pot <= 0) continue;
          ctx.globalAlpha = 0.2 + 0.7 * Math.min(100, pot) / 100;   // más intenso = más potencia
        } else {
          if (!datosGrafica[i]['ssr' + z]) continue;
          ctx.globalAlpha = 0.85;
        }
        const x0 = scales.x.getPixelForValue(i);
        const x1 = i + 1 < n ? scales.x.getPixelForValue(i + 1) : x0 + 2;
        ctx.fillRect(x0, y, Math.max(1, x1 - x0), alto);
      }
      ctx.restore();
    });
  },
};

function crearGrafica(){
  const datasets = [];
  for (const z of ZONAS){
    datasets.push({
      label: `Zona ${z} (${NOMBRE_ZONA[z]})`, data: [], borderColor: COLOR_ZONA[z], backgroundColor: COLOR_ZONA[z],
      borderWidth: 2, pointRadius: 0, pointHoverRadius: 5, tension: 0.25, spanGaps: false,
    });
  }
  for (const z of ZONAS){
    datasets.push({
      label: `Ajuste zona ${z}`, data: [], borderColor: COLOR_ZONA[z], borderWidth: 1.5,
      borderDash: [6, 5], pointRadius: 0, pointHoverRadius: 0, tension: 0, esAjuste: true,
    });
  }
  grafica = new Chart($('bigChart').getContext('2d'), {
    type: 'line',
    data: { labels: [], datasets },
    plugins: [franjasResistencias],
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: 'index', intersect: false },
      layout: { padding: { bottom: 4 } },
      plugins: {
        legend: {
          labels: {
            color: '#cfc6bb', boxWidth: 16, boxHeight: 3, font: { size: 12 },
            filter: (item, data) => !data.datasets[item.datasetIndex].esAjuste,
          },
          onClick: () => {},   // las zonas se prenden/apagan con las casillas de arriba
        },
        tooltip: {
          filter: (item) => !item.dataset.esAjuste,
          callbacks: {
            label: (c) => {
              const z = c.datasetIndex + 1;
              const fila = datosGrafica[c.dataIndex] || {};
              const sp = fila['_sp' + z];
              return `Zona ${z}: ${c.parsed.y === null ? '—' : c.parsed.y.toFixed(1) + ' °C'}`
                + (sp !== undefined && sp !== null ? ` (ajuste ${sp} °C)` : '')
                + (fila['pot' + z] !== null && fila['pot' + z] !== undefined
                  ? ` · potencia ${Math.round(fila['pot' + z])} %`
                  : (fila['ssr' + z] ? ' · resistencia ON' : ''));
            },
          },
        },
      },
      scales: {
        x: { ticks: { color: '#8f9ba1', maxTicksLimit: 8, font: { size: 11 } }, grid: { color: 'rgba(255,255,255,0.05)' } },
        y: {
          title: { display: true, text: 'Temperatura (°C)', color: '#8f9ba1', font: { size: 11 } },
          ticks: { color: '#8f9ba1', font: { size: 11 } }, grid: { color: 'rgba(255,255,255,0.07)' },
        },
      },
    },
  });
}

async function cargarGrafica(){
  if (!grafica) crearGrafica();
  const hoy = hoyLocal();
  $('graficaCsv').href = `/api/export.csv?fecha=${hoy}`;
  const url = rangoMs === 'hoy' ? `/api/grafica?fecha=${hoy}` : `/api/grafica?rango_ms=${rangoMs}`;
  try{
    const filas = await (await fetch(url, { cache: 'no-store' })).json();
    datosGrafica = filas;   // el servidor ya los promedió
    ZONAS.forEach((z) => datosGrafica.forEach((f) => { f['_sp' + z] = setpoints ? setpoints['sp_z' + z] : null; }));

    grafica.data.labels = datosGrafica.map((r) => horaLocal(r.ts).slice(0, rangoMs === 300000 ? 8 : 5));
    ZONAS.forEach((z, i) => {
      grafica.data.datasets[i].data = datosGrafica.map((r) => (r['t_z' + z] === null ? null : +Number(r['t_z' + z]).toFixed(2)));
      const sp = setpoints ? setpoints['sp_z' + z] : null;
      grafica.data.datasets[i + ZONAS.length].data = datosGrafica.map(() => sp);
    });
    aplicarVisibilidad();
    $('chartEmpty').hidden = datosGrafica.length > 0;

    // Resumen del rango
    const resumen = ZONAS.map((z) => {
      const v = filas.map((r) => r['t_z' + z]).filter((x) => x !== null && x !== undefined);
      if (!v.length) return `Zona ${z}: sin datos`;
      const lecturas = filas.reduce((a, r) => a + (r.n || 1), 0);
      return `Zona ${z}: mín ${Math.min(...v).toFixed(1)} · máx ${Math.max(...v).toFixed(1)} °C · ${lecturas.toLocaleString('es-MX')} lecturas`;
    });
    $('gStats').innerHTML = resumen.map(escapar).join('<br>');
  }catch(e){ /* se reintenta en el siguiente ciclo */ }
}

function aplicarVisibilidad(){
  const verAjuste = $('chkAjuste').checked;
  ZONAS.forEach((z, i) => {
    const ver = document.querySelector(`[data-zona="${z}"]`).checked;
    grafica.setDatasetVisibility(i, ver);
    grafica.setDatasetVisibility(i + ZONAS.length, ver && verAjuste);
  });
  grafica.update('none');
}

document.querySelectorAll('[data-rango]').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('[data-rango]').forEach((x) => x.classList.remove('active'));
  b.classList.add('active');
  rangoMs = b.dataset.rango === 'hoy' ? 'hoy' : Number(b.dataset.rango);
  cargarGrafica();
}));
document.querySelectorAll('[data-zona], #chkAjuste').forEach((c) => c.addEventListener('change', () => grafica && aplicarVisibilidad()));

// La gráfica se actualiza sola cada 5 s mientras su pestaña está abierta.
timerGrafica = setInterval(() => { if (vistaActual === 'grafica') cargarGrafica(); }, 5000);

/* =====================================================================
   PESTAÑA 3 · DATOS (tabla tipo Excel)
   ===================================================================== */
const COLUMNAS = {
  bitacora: [
    { k: 'fecha', t: 'Fecha' },
    { k: 'hora', t: 'Hora' },
    { k: 'operador', t: 'Operador' },
    { k: 'tipo', t: 'Tipo' },
    { k: 'detalle', t: 'Qué se hizo / cambió', wrap: true },
  ],
  lecturas: [
    { k: 'fecha', t: 'Fecha' },
    { k: 'hora', t: 'Hora' },
    { k: 't_z1', t: 'T zona 1 (°C)', num: true },
    { k: 't_z2', t: 'T zona 2 (°C)', num: true },
    { k: 'pot1', t: 'Potencia R1 (%)' },
    { k: 'pot2', t: 'Potencia R2 (%)' },
    { k: 'sistema_on', t: 'Sistema' },
    { k: 'alarma', t: 'Alarma', wrap: true },
    { k: 'device_id', t: 'Dispositivo' },
  ],
};

const tabla = {
  tipo: 'bitacora',
  fecha: hoyLocal(),
  pagina: 1,
  porPagina: 50,
  orden: { k: 'hora', dir: 'desc' },
  filasBitacora: [],      // la bitácora se carga completa del día y se filtra aquí
  totalLecturas: 0,
  filasLecturas: [],
};

$('fechaDatos').value = tabla.fecha;
$('fechaDatos').max = hoyLocal();

function cabecera(){
  const cols = COLUMNAS[tabla.tipo];
  $('sheetHead').innerHTML = '<tr><th class="rownum">#</th>' + cols.map((c) => {
    const marca = tabla.orden.k === c.k ? `<span class="orden">${tabla.orden.dir === 'asc' ? '▲' : '▼'}</span>` : '';
    return `<th data-k="${c.k}" scope="col">${escapar(c.t)}${marca}</th>`;
  }).join('') + '</tr>';
  $('sheetHead').querySelectorAll('th[data-k]').forEach((th) => th.addEventListener('click', () => {
    const k = th.dataset.k;
    tabla.orden = { k, dir: tabla.orden.k === k && tabla.orden.dir === 'desc' ? 'asc' : 'desc' };
    tabla.pagina = 1;
    cargarTabla();
  }));
}

function celda(fila, c){
  const v = fila[c.k];
  if (c.k === 'tipo') return `<span class="chip ${v === 'Ajuste HMI' ? 'ajuste' : 'nota'}">${escapar(v)}</span>`;
  if (c.k === 'pot1' || c.k === 'pot2'){
    if (v === null || v === undefined){   // lecturas viejas (antes del PID): solo encendida/apagada
      return fila['ssr' + c.k.slice(3)] ? '<span class="chip on">ENCENDIDA</span>' : '<span class="chip off">apagada</span>';
    }
    return Number(v) > 0 ? `<span class="chip on">${Number(v).toFixed(1)} %</span>` : '<span class="chip off">0 %</span>';
  }
  if (c.k === 'sistema_on') return v ? '<span class="chip on">ENCENDIDO</span>' : '<span class="chip off">apagado</span>';
  if (c.k === 'alarma') return v ? `<span class="chip alarma">⚠ ${escapar(v)}</span>` : '';
  if (c.num) return v === null || v === undefined ? '—' : Number(v).toFixed(2);
  return escapar(v);
}

function dibujarFilas(filas, inicio, total){
  const cols = COLUMNAS[tabla.tipo];
  if (!filas.length){
    $('sheetBody').innerHTML = `<tr><td class="sheet-empty" colspan="${cols.length + 1}">No hay registros para este día${tabla.tipo === 'bitacora' && $('buscarDatos').value ? ' con esa búsqueda' : ''}.</td></tr>`;
  } else {
    $('sheetBody').innerHTML = filas.map((f, i) => '<tr><td class="rownum">' + (inicio + i + 1) + '</td>' +
      cols.map((c) => `<td class="${c.num ? 'num' : ''}${c.wrap ? ' wrap' : ''}">${celda(f, c)}</td>`).join('') + '</tr>').join('');
  }
  const totalPaginas = Math.max(1, Math.ceil(total / tabla.porPagina));
  $('pagInfo').textContent = `Página ${tabla.pagina} de ${totalPaginas}`;
  $('pagPrev').disabled = tabla.pagina <= 1;
  $('pagNext').disabled = tabla.pagina >= totalPaginas;
  $('tablaInfo').textContent = total
    ? `Mostrando ${inicio + 1}–${inicio + filas.length} de ${total.toLocaleString('es-MX')} ${tabla.tipo === 'bitacora' ? 'registros' : 'lecturas'}`
    : '0 registros';
}

async function cargarTabla(){
  cabecera();
  const esBitacora = tabla.tipo === 'bitacora';
  $('campoBuscar').hidden = !esBitacora;
  $('csvDia').href = esBitacora ? `/api/log/export.csv?fecha=${tabla.fecha}` : `/api/export.csv?fecha=${tabla.fecha}`;
  $('csvTodo').href = esBitacora ? '/api/log/export.csv' : '/api/export.csv';

  try{
    if (esBitacora){
      const filas = await (await fetch(`/api/log?fecha=${tabla.fecha}`, { cache: 'no-store' })).json();
      tabla.filasBitacora = filas.map((r) => {
        const esAjuste = (r.nota || '').startsWith('AJUSTE HMI');
        return {
          ts: r.ts, fecha: r.fecha, hora: r.hora, operador: r.operador,
          tipo: esAjuste ? 'Ajuste HMI' : 'Nota',
          detalle: esAjuste ? r.nota.replace(/^AJUSTE HMI — /, '') : (r.nota || '—'),
        };
      });
      const texto = $('buscarDatos').value.trim().toLowerCase();
      let filtradas = texto
        ? tabla.filasBitacora.filter((f) => `${f.operador} ${f.tipo} ${f.detalle} ${f.hora}`.toLowerCase().includes(texto))
        : tabla.filasBitacora.slice();
      const { k, dir } = tabla.orden;
      const clave = k === 'hora' || k === 'fecha' ? 'ts' : k;
      filtradas.sort((a, b) => {
        const x = a[clave] ?? '', y = b[clave] ?? '';
        const r = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'es');
        return dir === 'asc' ? r : -r;
      });
      const inicio = (tabla.pagina - 1) * tabla.porPagina;
      dibujarFilas(filtradas.slice(inicio, inicio + tabla.porPagina), inicio, filtradas.length);
    } else {
      // Lecturas: el servidor pagina (un día puede tener decenas de miles).
      const ordenServidor = tabla.orden.dir === 'asc' ? 'asc' : 'desc';
      const url = `/api/lecturas?fecha=${tabla.fecha}&pagina=${tabla.pagina}&por_pagina=${tabla.porPagina}&orden=${ordenServidor}`;
      const r = await (await fetch(url, { cache: 'no-store' })).json();
      let filas = r.filas || [];
      const { k, dir } = tabla.orden;
      if (k !== 'hora' && k !== 'fecha'){
        // dentro de la página, ordena por la columna elegida
        filas = filas.slice().sort((a, b) => {
          const x = a[k] ?? -Infinity, y = b[k] ?? -Infinity;
          const res = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'es');
          return dir === 'asc' ? res : -res;
        });
      }
      dibujarFilas(filas, (tabla.pagina - 1) * tabla.porPagina, r.total || 0);
    }
  }catch(e){
    $('sheetBody').innerHTML = '<tr><td class="sheet-empty" colspan="10">No se pudo cargar la información. ¿Está encendido el servidor?</td></tr>';
  }
}

document.querySelectorAll('[data-tabla]').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('[data-tabla]').forEach((x) => x.classList.remove('active'));
  b.classList.add('active');
  tabla.tipo = b.dataset.tabla;
  tabla.pagina = 1;
  tabla.orden = { k: 'hora', dir: 'desc' };
  cargarTabla();
}));
$('fechaDatos').addEventListener('change', () => { tabla.fecha = $('fechaDatos').value || hoyLocal(); tabla.pagina = 1; cargarTabla(); });
$('porPagina').addEventListener('change', () => { tabla.porPagina = Number($('porPagina').value); tabla.pagina = 1; cargarTabla(); });
let esperaBusqueda = null;
$('buscarDatos').addEventListener('input', () => { clearTimeout(esperaBusqueda); esperaBusqueda = setTimeout(() => { tabla.pagina = 1; cargarTabla(); }, 250); });
$('pagPrev').addEventListener('click', () => { if (tabla.pagina > 1){ tabla.pagina--; cargarTabla(); } });
$('pagNext').addEventListener('click', () => { tabla.pagina++; cargarTabla(); });

// Si la tabla muestra HOY y estás en la primera página, se actualiza sola cada 10 s.
setInterval(() => {
  if (vistaActual === 'datos' && tabla.fecha === hoyLocal() && tabla.pagina === 1) cargarTabla();
}, 10000);

/* =====================================================================
   VENTANA DE AJUSTE / ENCENDIDO
   ===================================================================== */
const modal = $('adjModal');
let modo = null;   // { tipo: 'zona', z } o { tipo: 'power', encender }

// Ganancias guardadas de una zona
function gananciasZona(z){
  return { kp: Number(setpoints['kp' + z]), ki: Number(setpoints['ki' + z]), kd: Number(setpoints['kd' + z]) };
}
// Número corto para mostrar (4, 0.005, 40.5)
function numCorto(v){
  return Number.isFinite(v) ? String(Number(v.toPrecision(4))) : '—';
}

function abrirPid(z){
  if (!setpoints || setpoints['kp' + z] === undefined) return;
  modo = { tipo: 'pid', z };
  const g = gananciasZona(z);
  $('adjTitle').textContent = `Control PID — Zona ${z} (${NOMBRE_ZONA[z]})`;
  $('adjDesc').textContent = 'Ganancias que usa el ESP32 para decidir la potencia de la resistencia. El cambio se aplica en unos 2 segundos, sin volver a subir el programa.';
  $('adjValueRow').hidden = true;
  $('adjPidRow').hidden = false;
  $('adjRange').hidden = false;
  $('pidKp').value = g.kp; $('pidKi').value = g.ki; $('pidKd').value = g.kd;
  const L = setpoints.pid_limites || { kp: [0, 100], ki: [0, 1], kd: [0, 1000] };
  $('adjRange').textContent = `Permitido: kp ${L.kp[0]}–${L.kp[1]} · ki ${L.ki[0]}–${L.ki[1]} · kd ${L.kd[0]}–${L.kd[1]}`;
  $('adjRange').className = 'adj-range';
  $('adjOk').textContent = 'Aplicar PID';
  abrirModal();
}

function abrirAjuste(z){
  if (!setpoints) return;
  modo = { tipo: 'zona', z };
  $('adjTitle').textContent = `Ajuste de temperatura — Zona ${z} (${NOMBRE_ZONA[z]})`;
  $('adjDesc').textContent = 'Temperatura que el ESP32 debe mantener en esta zona. El control PID ajusta la potencia de su resistencia (0 a 100 %) para llegar y quedarse ahí.';
  $('adjValueRow').hidden = false;
  $('adjPidRow').hidden = true;
  $('adjRange').hidden = false;
  const inp = $('adjInput');
  inp.min = setpoints.sp_min; inp.max = setpoints.sp_max;
  inp.value = setpoints['sp_z' + z];
  $('adjRange').textContent = `Permitido: ${setpoints.sp_min} a ${setpoints.sp_max} °C · máximo recomendado ${setpoints.sp_recomendado ?? 80} °C`;
  $('adjRange').className = 'adj-range';
  $('adjOk').textContent = 'Aplicar ajuste';
  abrirModal();
}

function abrirPower(){
  if (!setpoints) return;
  const encender = !setpoints.sistema_on;
  modo = { tipo: 'power', encender };
  $('adjTitle').textContent = encender ? '⏻ Encender el sistema' : '⏻ Apagar el sistema';
  $('adjDesc').textContent = encender
    ? `Se activarán las 2 resistencias para llevar la zona superior a ${setpoints.sp_z1} °C y la inferior a ${setpoints.sp_z2} °C. Revisa que el extractor tenga agua y que la válvula esté en la posición correcta.`
    : 'Se apagarán las 2 resistencias. Las lecturas de temperatura siguen llegando.';
  $('adjValueRow').hidden = true;
  $('adjPidRow').hidden = true;
  $('adjRange').hidden = true;
  $('adjOk').textContent = encender ? 'Sí, encender' : 'Sí, apagar';
  abrirModal();
}

function abrirModal(){
  $('adjStatus').textContent = '';
  $('adjStatus').className = 'adj-status';
  $('adjOperador').value = operadorGuardado();
  modal.hidden = false;
  (modo.tipo === 'zona' ? $('adjInput') : modo.tipo === 'pid' ? $('pidKp') : ($('adjOperador').value ? $('adjOk') : $('adjOperador'))).focus();
}
function cerrarModal(){ modal.hidden = true; modo = null; }

document.querySelectorAll('.adj-btn').forEach((b) => b.addEventListener('click', () => abrirAjuste(Number(b.dataset.z))));
document.querySelectorAll('.pid-btn').forEach((b) => b.addEventListener('click', () => abrirPid(Number(b.dataset.z))));
$('pidDefecto').addEventListener('click', () => {
  const d = (setpoints && setpoints.pid_defecto) || { kp: 4, ki: 0.005, kd: 40 };
  $('pidKp').value = d.kp; $('pidKi').value = d.ki; $('pidKd').value = d.kd;
});
document.querySelectorAll('.step').forEach((b) => b.addEventListener('click', () => {
  const inp = $('adjInput');
  const v = (Number(inp.value) || 0) + Number(b.dataset.step);
  inp.value = Math.max(Number(inp.min), Math.min(Number(inp.max), v));
  inp.dispatchEvent(new Event('input'));
}));
modal.querySelectorAll('[data-cerrar]').forEach((b) => b.addEventListener('click', cerrarModal));
modal.addEventListener('click', (e) => { if (e.target === modal) cerrarModal(); });
$('powerBtn').addEventListener('click', abrirPower);
// Si cambian el valor después del aviso de "arriba del recomendado", se vuelve a preguntar
$('adjInput').addEventListener('input', () => {
  if (!modo || modo.tipo !== 'zona' || !setpoints) return;
  modo.confirmado = null;
  $('adjOk').textContent = 'Aplicar ajuste';
  $('adjRange').textContent = `Permitido: ${setpoints.sp_min} a ${setpoints.sp_max} °C · máximo recomendado ${setpoints.sp_recomendado ?? 80} °C`;
  $('adjRange').className = 'adj-range';
});

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
    // Arriba del máximo recomendado: pide confirmar con un segundo clic
    const rec = setpoints.sp_recomendado ?? 80;
    if (v > rec && modo.confirmado !== v){
      modo.confirmado = v;
      $('adjRange').textContent = `⚠ ${v} °C está arriba del máximo recomendado (${rec} °C). Presiona otra vez para confirmar.`;
      $('adjRange').className = 'adj-range adj-aviso';
      $('adjOk').textContent = `Sí, aplicar ${v} °C`;
      return;
    }
    cuerpo['sp_z' + modo.z] = v;
  } else if (modo.tipo === 'pid'){
    const L = setpoints.pid_limites || { kp: [0, 100], ki: [0, 1], kd: [0, 1000] };
    for (const [k, id] of [['kp', 'pidKp'], ['ki', 'pidKi'], ['kd', 'pidKd']]){
      const v = Number($(id).value);
      if ($(id).value === '' || !Number.isFinite(v) || v < L[k][0] || v > L[k][1]){
        status.textContent = `${k} debe estar entre ${L[k][0]} y ${L[k][1]}.`;
        status.className = 'adj-status error';
        $(id).focus();
        return;
      }
      cuerpo[k + modo.z] = v;
    }
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
    if (vistaActual === 'grafica') cargarGrafica();
    if (vistaActual === 'datos') cargarTabla();
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
(async () => {
  await pollLatest();          // primero los ajustes (las gráficas dibujan sus líneas)
  startPolling();
  mostrarVista(location.hash.slice(1) || 'inicio');
})();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* sin instalación como app */ });
  });
}
