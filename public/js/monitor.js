// monitor.js — lógica de la pantalla de registro de operador
// (quién usó el sistema, día, hora y una nota de qué hizo)

function escapeHtml(s){
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function hoyLocal(){
  // Mismo criterio que el servidor (America/Mexico_City por defecto),
  // solo para preseleccionar el día en el <select>.
  const d = new Date();
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(d);
}

const selDia = document.getElementById('selDia');
const logTableBody = document.getElementById('logTableBody');
const logStatus = document.getElementById('logStatus');
const inpOperador = document.getElementById('inpOperador');
const inpNota = document.getElementById('inpNota');

async function cargarDias(){
  try{
    const res = await fetch('/api/log/days', { cache: 'no-store' });
    const dias = await res.json();
    const hoy = hoyLocal();

    const opciones = new Set(dias.map(d => d.fecha));
    opciones.add(hoy); // siempre ofrece "hoy", aunque todavía no tenga registros

    const ordenadas = Array.from(opciones).sort().reverse();

    selDia.innerHTML = ordenadas.map(fecha => {
      const info = dias.find(d => d.fecha === fecha);
      const total = info ? ` (${info.total})` : ' (0)';
      return `<option value="${fecha}">${fecha}${total}</option>`;
    }).join('');

    selDia.value = hoy;
  }catch(e){
    console.error('No se pudieron cargar los días', e);
  }
}

async function cargarTabla(){
  const fecha = selDia.value || hoyLocal();
  try{
    const res = await fetch('/api/log?fecha=' + encodeURIComponent(fecha), { cache: 'no-store' });
    const rows = await res.json();

    if (!Array.isArray(rows) || rows.length === 0){
      logTableBody.innerHTML = '<tr><td colspan="3" class="log-empty">Sin registros para este día.</td></tr>';
      return;
    }

    logTableBody.innerHTML = rows.map(r => `
      <tr>
        <td class="log-hora">${escapeHtml(r.hora)}</td>
        <td class="log-operador">${escapeHtml(r.operador)}</td>
        <td>${escapeHtml(r.nota) || '<span style="color:#55656d">—</span>'}</td>
      </tr>
    `).join('');
  }catch(e){
    logTableBody.innerHTML = '<tr><td colspan="3" class="log-empty">No se pudo cargar el historial.</td></tr>';
  }
}

async function guardarRegistro(){
  const operador = inpOperador.value.trim();
  const nota = inpNota.value.trim();

  if (!operador){
    logStatus.textContent = 'Escribe el nombre del operador.';
    logStatus.className = 'log-status error';
    inpOperador.focus();
    return;
  }

  const btn = document.getElementById('btnGuardar');
  if (btn.disabled) return;   // evita guardar dos veces con un doble toque en el celular
  btn.disabled = true;

  logStatus.textContent = 'Guardando...';
  logStatus.className = 'log-status';

  try{
    const res = await fetch('/api/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operador, nota }),
    });
    const data = await res.json();

    if (!res.ok || !data.ok){
      logStatus.textContent = 'Error: ' + (data.error || res.status);
      logStatus.className = 'log-status error';
      return;
    }

    logStatus.textContent = `Registrado ${data.fecha} ${data.hora}`;
    logStatus.className = 'log-status';
    inpOperador.value = '';
    inpNota.value = '';

    await cargarDias();
    selDia.value = data.fecha;
    await cargarTabla();
  }catch(e){
    logStatus.textContent = 'No se pudo contactar al servidor. Revisa que el celular siga en la misma red WiFi.';
    logStatus.className = 'log-status error';
  }finally{
    btn.disabled = false;
  }
}

document.getElementById('btnGuardar').addEventListener('click', guardarRegistro);
document.getElementById('btnRefrescar').addEventListener('click', () => { cargarDias(); cargarTabla(); });
selDia.addEventListener('change', cargarTabla);

// Enter dentro del campo "operador" guarda directo (más rápido para uso frecuente)
inpOperador.addEventListener('keydown', (e) => {
  if (e.key === 'Enter'){ e.preventDefault(); guardarRegistro(); }
});

(async () => {
  await cargarDias();
  await cargarTabla();
})();
