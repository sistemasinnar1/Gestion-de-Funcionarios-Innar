const $ = (id) => document.getElementById(id);

let currentUser = null;
let csrfToken = '';
let pendingEmail = '';

function showView(id) {
  ['view-login', 'view-home', 'view-hv', 'view-hv-folder'].forEach((viewId) => {
    const el = $(viewId);
    if (el) el.classList.toggle('hidden', viewId !== id);
  });
}

function hideSplash() {
  const splash = $('splashScreen');
  if (!splash) return;
  splash.classList.add('hidden-splash');
  setTimeout(() => splash.classList.add('hidden'), 500);
}

function setError(id, message) {
  const el = $(id);
  if (!el) return;
  el.textContent = message || '';
  el.classList.toggle('hidden', !message);
}

function applyUser(user) {
  currentUser = user;
  const label = user?.nombre || user?.email || 'Usuario';
  document.querySelectorAll('#menuUserName, .js-user-name').forEach((el) => {
    el.textContent = label;
  });
}

function showEmailStep() {
  $('formEmail').classList.remove('hidden');
  $('formCodigo').classList.add('hidden');
  $('devCodeBox').classList.add('hidden');
  $('devCodeValue').textContent = '';
  setError('codeError', '');
  pendingEmail = '';
}

function showCodeStep(email, localCode) {
  pendingEmail = email;
  $('formEmail').classList.add('hidden');
  $('formCodigo').classList.remove('hidden');
  $('loginCodigo').value = '';
  $('loginCodigo').focus();
  if (localCode) {
    $('devCodeValue').textContent = localCode;
    $('devCodeBox').classList.remove('hidden');
  } else {
    $('devCodeBox').classList.add('hidden');
  }
}

function formatCode(value) {
  const raw = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  if (raw.length <= 4) return raw;
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

async function apiFetch(url, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  if (csrfToken && ['POST', 'PUT', 'PATCH', 'DELETE'].includes((opts.method || 'GET').toUpperCase())) {
    headers['x-csrf-token'] = csrfToken;
  }
  return fetch(url, { ...opts, headers, credentials: 'include' });
}

async function checkSession() {
  try {
    const res = await apiFetch('/api/sesion');
    const data = await res.json();
    if (data.autenticado && data.usuario) {
      if (data.csrfToken) csrfToken = data.csrfToken;
      applyUser(data.usuario);
      aplicarRutaAutenticado();
      return true;
    }
  } catch (e) {
    console.error(e);
  }
  currentUser = null;
  showView('view-login');
  return false;
}

async function loadAccessState() {
  try {
    const res = await apiFetch('/api/acceso/estado');
    const data = await res.json();
    const hint = $('localHint');
    const lead = $('loginLead');
    if (data.expires_min && lead) {
      lead.textContent = `Escribe tu correo y te enviamos un código para ingresar. Caduca en ${data.expires_min} minutos.`;
    }
    if (data.modo_local && data.correo_local) {
      hint.textContent = `Entorno local: usa ${data.correo_local}. El código aparecerá en pantalla hasta configurar SMTP.`;
      hint.classList.remove('hidden');
      if (!$('loginEmail').value) $('loginEmail').value = data.correo_local;
    }
  } catch (_) { /* ignore */ }
}

async function solicitarCodigo(email) {
  setError('emailError', '');
  try {
    const res = await apiFetch('/api/acceso/solicitar', {
      method: 'POST',
      body: JSON.stringify({ email })
    });
    const data = await res.json();
    if (!res.ok) {
      let extra = data.error || 'No se pudo solicitar el acceso';
      if (data.detalle) extra += ` (${data.detalle})`;
      if (res.status === 429 && data.minutos_restantes) {
        extra += `. Intenta en ${data.minutos_restantes} min.`;
      }
      setError('emailError', extra);
      return false;
    }
    showCodeStep(email, data.codigo_local || '');
    return true;
  } catch (_) {
    setError('emailError', 'Error de conexión');
    return false;
  }
}

async function verificarCodigo(email, codigo) {
  setError('codeError', '');
  try {
    const res = await apiFetch('/api/acceso/verificar', {
      method: 'POST',
      body: JSON.stringify({ email, codigo })
    });
    const data = await res.json();
    if (data.ok) {
      if (data.csrfToken) csrfToken = data.csrfToken;
      applyUser(data.usuario);
      showView('view-home');
      history.pushState({ view: 'home' }, '', '#home');
      return true;
    }
    let extra = data.error || 'No se pudo validar la contraseña temporal';
    if (res.status === 429 && data.minutos_restantes) {
      extra += `. Intenta en ${data.minutos_restantes} min.`;
    }
    setError('codeError', extra);
    return false;
  } catch (_) {
    setError('codeError', 'Error de conexión');
    return false;
  }
}

async function doLogout() {
  csrfToken = '';
  try {
    await apiFetch('/api/logout', { method: 'POST' });
  } catch (_) { /* ignore */ }
  currentUser = null;
  $('formEmail')?.reset();
  $('formCodigo')?.reset();
  showEmailStep();
  showView('view-login');
  history.pushState({ view: 'login' }, '', '#login');
  loadAccessState();
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatFecha(value) {
  if (!value) return '';
  const d = String(value).slice(0, 10);
  const [y, m, day] = d.split('-');
  return day && m && y ? `${day}/${m}/${y}` : d;
}

let hvFolderId = null;
let hvEditId = null;
let hvUploadTipo = null;
let hvFolderData = null;
let hvFotoId = null;
let hvFotoTick = Date.now();
let hvBuscarTimer = null;
let hvLista = [];
let hvCargandoInactivos = false;

const ESTADO_LABEL = {
  falta: 'Falta',
  cargado: 'Cargado',
  por_vencer: 'Por vencer',
  vencido: 'Vencido'
};

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

function iniciales(nombres, apellidos) {
  const a = String(nombres || '').trim().charAt(0);
  const b = String(apellidos || '').trim().charAt(0);
  return `${a}${b}`.toUpperCase() || 'F';
}

function formatCumple(iso) {
  const d = String(iso || '').slice(0, 10);
  const [, m, day] = d.split('-');
  if (!m || !day) return '';
  return `${Number(day)} de ${MESES[Number(m) - 1] || m}`;
}

function payloadPersona() {
  const tipoSelect = $('hvTipoPersonaSelect');
  const tipo = ($('hvTipoPersona').value || tipoSelect?.value || '').trim();
  return {
    nombres: $('hvNombres').value.trim(),
    apellidos: $('hvApellidos').value.trim(),
    documento: $('hvDocumento').value.trim(),
    telefono: $('hvTelefono').value.trim(),
    correo: $('hvCorreo').value.trim(),
    forma_vinculacion: $('hvVinculacion').value,
    cargo: $('hvCargo').value.trim(),
    area: $('hvArea').value.trim(),
    tipo_persona: tipo,
    fecha_nacimiento: hvEditId ? (hvFolderData?.funcionario?.fecha_nacimiento || null) : null
  };
}

function mostrarPasoTipo() {
  $('hvNuevoPasoTipo').classList.remove('hidden');
  $('hvNuevoPasoDatos').classList.add('hidden');
}

function mostrarPasoDatos(tipo, editando) {
  $('hvNuevoPasoTipo').classList.add('hidden');
  $('hvNuevoPasoDatos').classList.remove('hidden');
  $('hvTipoPersona').value = tipo;
  if ($('hvTipoPersonaSelect')) $('hvTipoPersonaSelect').value = tipo;
  $('hvTipoEditWrap').classList.toggle('hidden', !editando);
  $('hvNuevoTitulo').textContent = editando ? 'Editar datos' : 'Nuevo colaborador';
  $('hvNuevoTipoLabel').textContent = tipo === 'asistencial'
    ? 'Asistencial — contacto con el paciente'
    : 'Administrativo — sin contacto con el paciente';
  $('btnHvNuevoAtras').classList.toggle('hidden', Boolean(editando));
}

function resetDialogoNuevo() {
  hvEditId = null;
  $('formHvNuevo').reset();
  $('hvTipoPersona').value = '';
  setError('hvNuevoError', '');
  mostrarPasoTipo();
}

function llenarFormulario(f) {
  $('hvNombres').value = f.nombres || '';
  $('hvApellidos').value = f.apellidos || '';
  $('hvDocumento').value = f.documento || '';
  $('hvTelefono').value = f.telefono || '';
  $('hvCorreo').value = f.correo || '';
  $('hvVinculacion').value = f.forma_vinculacion || '';
  $('hvCargo').value = f.cargo || '';
  $('hvArea').value = f.area || '';
  $('hvTipoPersona').value = f.tipo_persona || '';
  if ($('hvTipoPersonaSelect')) $('hvTipoPersonaSelect').value = f.tipo_persona || 'administrativo';
}

const HV_GRUPOS = [
  { label: 'Identificación', tipos: ['hoja_vida', 'cedula'] },
  { label: 'Formación', tipos: ['titulo_bachiller', 'acta_bachiller', 'titulo_profesional', 'acta_profesional', 'rethus'] },
  { label: 'Cursos y experiencia', tipos: ['cursos_generales', 'constancias_trabajo'] },
  { label: 'Afiliaciones y salud', tipos: ['examen_medico', 'afiliacion_salud', 'afiliacion_pension', 'afiliacion_arl'] },
  { label: 'Cursos de 2 años', tipos: ['curso_violencia_sexual', 'curso_soporte_vital', 'curso_duelo', 'curso_telemedicina'] },
  { label: 'Contratación', tipos: ['poliza_rc', 'rut'] }
];

const ICON_FILE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M7 3h7l5 5v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M14 3v6h6"/></svg>';
const ICON_PLUS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" d="M12 5v14M5 12h14"/></svg>';
const ICON_ALERT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V8z"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M14 3v5h5M12 11v3M12 17h.01"/></svg>';
const ICON_CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M5 12l5 5L20 7"/></svg>';
const ICON_CAMERA = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="14" r="3.5" fill="none" stroke="currentColor" stroke-width="2"/></svg>';

function fotoSrc(url) {
  return url ? `${url}${url.includes('?') ? '&' : '?'}t=${hvFotoTick}` : '';
}

function htmlFoto(f, compacto) {
  if (f.tiene_foto && f.foto_url) {
    return `<img src="${escapeHtml(fotoSrc(f.foto_url))}" alt="${escapeHtml(f.nombres || '')}"/>
      <span class="hv-card-photo-hint">${compacto ? 'Cambiar' : 'Cambiar foto'}</span>`;
  }
  return `<span class="hv-card-photo-empty">${ICON_CAMERA}<span>Subir foto</span></span>`;
}

function pintarFotoFicha(f) {
  const btn = $('hvFichaFoto');
  if (!btn || !f) return;
  btn.hidden = false;
  btn.setAttribute('data-foto', f.id);
  btn.classList.toggle('has-photo', Boolean(f.tiene_foto));
  btn.innerHTML = htmlFoto(f, true);
}

function elegirFoto(id) {
  hvFotoId = id;
  const input = $('hvFotoArchivo');
  if (!input) return;
  input.value = '';
  input.click();
}

function faltantesDe(progreso) {
  if (!progreso) return 0;
  if (Number.isFinite(progreso.faltantes)) return Number(progreso.faltantes);
  return Math.max(0, Number(progreso.requeridos || 0) - Number(progreso.cargados || 0));
}

function cumpleInfo(iso) {
  const raw = String(iso || '').slice(0, 10);
  const parts = raw.split('-');
  if (parts.length !== 3) return { esteMes: false, estaSemana: false, hoy: false, days: null, label: '' };
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  let next = new Date(now.getFullYear(), month - 1, day);
  next.setHours(0, 0, 0, 0);
  if (next < now) next = new Date(now.getFullYear() + 1, month - 1, day);
  const days = Math.round((next.getTime() - now.getTime()) / 86400000);
  return {
    hoy: days === 0,
    estaSemana: days >= 0 && days <= 7,
    esteMes: month === now.getMonth() + 1,
    days,
    label: formatCumple(raw)
  };
}

function htmlAnillo(cargados, requeridos, alerta) {
  const total = Number(requeridos || 0);
  const ok = Number(cargados || 0);
  const pct = total ? Math.max(0, Math.min(100, Math.round((ok / total) * 100))) : 0;
  const c = 2 * Math.PI * 16;
  const dash = (pct / 100) * c;
  const cls = alerta === 'vencido' || (total && ok < total) ? ' is-alert' : (alerta === 'por_vencer' ? ' is-warn' : '');
  return `<span class="hv-ring${cls}">
    <svg viewBox="0 0 40 40" aria-hidden="true">
      <circle class="hv-ring-bg" cx="20" cy="20" r="16"></circle>
      <circle class="hv-ring-fg" cx="20" cy="20" r="16" stroke-dasharray="${dash.toFixed(2)} ${c.toFixed(2)}" transform="rotate(-90 20 20)"></circle>
    </svg>
    <b>${ok}/${total}</b>
  </span>`;
}

function resumenAlertas(lista) {
  const rows = lista || [];
  return {
    incompletos: rows.filter((r) => faltantesDe(r.progreso) > 0).length,
    vencidos: rows.filter((r) => Number(r.progreso?.vencidos || 0) > 0).length,
    por_vencer: rows.filter((r) => Number(r.progreso?.por_vencer || 0) > 0).length,
    cumpleanos: rows.filter((r) => cumpleInfo(r.fecha_nacimiento).esteMes).length
  };
}

function pintarAlertas(id) {
  const el = $(id);
  if (!el) return;
  const r = resumenAlertas(hvLista);
  if (!hvLista.length) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  el.hidden = false;
  const items = [
    { filtro: 'incompletos', n: r.incompletos, label: 'fichas incompletas', cls: '' },
    { filtro: 'vencidos', n: r.vencidos, label: 'con documentos vencidos', cls: 'is-danger' },
    { filtro: 'por_vencer', n: r.por_vencer, label: 'por vencer (30 días)', cls: 'is-warn' },
    { filtro: 'cumpleanos', n: r.cumpleanos, label: 'cumpleaños este mes', cls: 'is-bday' }
  ].filter((item) => item.n > 0);
  if (!items.length) {
    el.innerHTML = `<button type="button" class="hv-alerta is-ok" data-filtro="al_dia"><strong>${hvLista.length}</strong><span>Fichas al día</span></button>`;
    return;
  }
  el.innerHTML = items.map((item) => `
    <button type="button" class="hv-alerta ${item.cls}" data-filtro="${item.filtro}">
      <strong>${item.n}</strong>
      <span>${item.label}</span>
    </button>`).join('');
}

function listaFiltrada() {
  const q = ($('hvBuscar')?.value || '').trim().toLowerCase();
  const tipo = $('hvFiltroTipo')?.value || '';
  const vin = $('hvFiltroVinculacion')?.value || '';
  const estado = $('hvFiltroEstado')?.value || '';
  return hvLista.filter((row) => {
    if (tipo && row.tipo_persona !== tipo) return false;
    if (vin && row.forma_vinculacion !== vin) return false;
    const faltan = faltantesDe(row.progreso);
    const vencidos = Number(row.progreso?.vencidos || 0);
    const porVencer = Number(row.progreso?.por_vencer || 0);
    if (estado === 'incompletos' && faltan === 0) return false;
    if (estado === 'vencidos' && vencidos === 0) return false;
    if (estado === 'por_vencer' && porVencer === 0) return false;
    if (estado === 'cumpleanos' && !cumpleInfo(row.fecha_nacimiento).esteMes) return false;
    if (estado === 'al_dia' && (faltan > 0 || vencidos > 0)) return false;
    if (q) {
      const blob = `${row.nombres} ${row.apellidos} ${row.documento} ${row.cargo || ''} ${row.area || ''} ${row.correo || ''} ${row.telefono || ''}`.toLowerCase();
      if (!blob.includes(q)) return false;
    }
    return true;
  });
}

function chipCumple(row) {
  const c = cumpleInfo(row.fecha_nacimiento);
  if (!c.label) return '';
  if (c.hoy) return '<span class="hv-chip hv-chip-bday">Hoy cumple años</span>';
  if (c.estaSemana) return `<span class="hv-chip hv-chip-bday">Cumple el ${escapeHtml(c.label)}</span>`;
  if (c.esteMes && c.days <= 40) return `<span class="hv-chip hv-chip-bday">Cumple el ${escapeHtml(c.label)}</span>`;
  if (c.esteMes) return `<span class="hv-chip">Cumplió el ${escapeHtml(c.label)}</span>`;
  return '';
}

function pintarGrid() {
  const grid = $('hvGrid');
  const vacio = $('hvVacio');
  if (!grid) return;
  const data = listaFiltrada();
  grid.innerHTML = '';
  if (!hvLista.length) {
    vacio.classList.remove('hidden');
    vacio.textContent = 'Aún no hay fichas. Crea el primer colaborador.';
    return;
  }
  if (!data.length) {
    vacio.classList.remove('hidden');
    vacio.textContent = 'Ninguna ficha coincide con el filtro.';
    return;
  }
  vacio.classList.add('hidden');
  data.forEach((row) => {
    const p = row.progreso || { cargados: 0, requeridos: 0, vencidos: 0 };
    const faltan = faltantesDe(p);
    const vencidos = Number(p.vencidos || 0);
    const alerta = row.alerta;
    const card = document.createElement('article');
    card.className = 'hv-card';
    card.dataset.id = row.id;
    const badge = vencidos > 0
      ? `<span class="hv-folder-badge" title="Hay documentos por renovar">${ICON_ALERT}<b>${vencidos}</b></span>`
      : faltan > 0
        ? `<span class="hv-folder-badge" title="Faltan ${faltan} archivo${faltan === 1 ? '' : 's'}">${ICON_ALERT}<b>${faltan}</b></span>`
        : `<span class="hv-folder-badge is-ok" title="Requisitos al día">${ICON_CHECK}</span>`;
    const extra = vencidos > 0
      ? `<span class="hv-chip hv-chip-vencido">${vencidos} por renovar</span>`
      : '';
    const inactivo = Number(row.activo) === 0;
    card.className = inactivo ? 'hv-card is-inactivo' : 'hv-card';
    card.innerHTML = `
      <button type="button" class="hv-card-photo${row.tiene_foto ? ' has-photo' : ''}"${inactivo ? '' : ` data-foto="${row.id}"`}>
        ${htmlFoto(row, false)}
      </button>
      <div class="hv-card-body">
        ${badge}
        ${inactivo ? '<span class="hv-chip">Inactivo</span>' : ''}${chipCumple(row)}${extra}
        <span class="hv-folder-name">${escapeHtml(row.nombres)} ${escapeHtml(row.apellidos)}</span>
        <span class="hv-folder-role">${escapeHtml(row.tipo_label || '')} · ${escapeHtml(row.forma_label || 'Sin vinculación')}</span>
        ${htmlAnillo(p.cargados, p.requeridos, alerta)}
      </div>`;
    grid.appendChild(card);
  });
}

async function cargarFuncionarios() {
  setError('hvError', '');
  hvCargandoInactivos = $('hvFiltroEstado')?.value === 'inactivos';
  try {
    const res = await apiFetch('/api/funcionarios' + (hvCargandoInactivos ? '?activo=0' : ''));
    const data = await res.json();
    if (!res.ok) {
      setError('hvError', data.error || 'No se pudo cargar la lista');
      return;
    }
    hvLista = Array.isArray(data) ? data : [];
    if (!hvCargandoInactivos) {
      pintarAlertas('homeAlertas');
      pintarAlertas('hvAlertas');
    } else if ($('hvAlertas')) {
      $('hvAlertas').hidden = true;
    }
    pintarGrid();
  } catch (_) {
    setError('hvError', 'Error de conexión');
  }
}

function renderFicha(f, progreso) {
  const faltan = faltantesDe(progreso);
  const items = [
    ['Documento', f.documento],
    ['Tipo', f.tipo_label],
    ['Vinculación', f.forma_label],
    ['Teléfono', f.telefono],
    ['Correo', f.correo],
    ['Cargo', f.cargo],
    ['Área', f.area],
    ['Cumpleaños', f.fecha_nacimiento ? formatCumple(f.fecha_nacimiento) : 'Pendiente (al cargar la cédula)'],
    ['Archivos', faltan > 0 ? `Faltan ${faltan}` : `${progreso?.cargados || 0}/${progreso?.requeridos || 0} listos`]
  ];
  $('hvFicha').innerHTML = items.map(([k, v]) => `
    <div>
      <dt>${escapeHtml(k)}</dt>
      <dd>${escapeHtml(v || '—')}</dd>
    </div>`).join('');
}

function textoSlot(req) {
  if (req.estado === 'falta') {
    return req.required ? 'Pendiente por subir' : 'Opcional · aún sin archivo';
  }
  const latest = req.archivos[0];
  if (!latest) return 'Pendiente por subir';
  const bits = [latest.nombre];
  if (latest.fecha_documento) bits.push(`curso ${formatFecha(latest.fecha_documento)}`);
  if (latest.fecha_vencimiento) bits.push(`vence ${formatFecha(latest.fecha_vencimiento)}`);
  if (latest.creado_en) bits.push(`cargado ${formatFecha(latest.creado_en)}`);
  if (req.estado === 'vencido') bits.push('Hay que renovar');
  return bits.join(' · ');
}

function htmlArchivoFila(a) {
  return `<div class="hv-slot-file">
    <span>${escapeHtml(a.nombre)}${a.creado_en ? ` · ${formatFecha(a.creado_en)}` : ''}</span>
    <button type="button" data-doc="${a.id}">Ver</button>
  </div>`;
}

function renderSlot(req, readOnly) {
  const badge = !req.required && req.estado === 'falta'
    ? '<span class="hv-badge hv-badge-opcional">Opcional</span>'
    : `<span class="hv-badge hv-badge-${req.estado}">${ESTADO_LABEL[req.estado] || req.estado}</span>`;
  const latest = req.archivos[0];
  const files = req.multiple && req.archivos.length
    ? `<div class="hv-slot-files">${req.archivos.map(htmlArchivoFila).join('')}</div>`
    : '';
  const verUno = latest && !req.multiple ? `<button type="button" data-doc="${latest.id}">Ver</button>` : '';
  const subir = readOnly
    ? ''
    : `<button type="button" class="hv-slot-upload" data-subir="${escapeHtml(req.tipo)}">${req.estado === 'falta' || req.estado === 'vencido' ? 'Subir archivo' : (req.multiple ? 'Agregar' : 'Reemplazar')}</button>`;
  return `
    <article class="hv-slot is-${req.estado}" data-tipo="${escapeHtml(req.tipo)}">
      <div class="hv-slot-icon">${req.estado === 'falta' ? ICON_PLUS : ICON_FILE}</div>
      <div class="hv-slot-top">
        <h5>${escapeHtml(req.label)}</h5>
        ${badge}
      </div>
      <p>${escapeHtml(textoSlot(req))}</p>
      ${readOnly ? '' : '<p class="hv-slot-hint">Arrastra un archivo aquí</p>'}
      ${files}
      <div class="hv-slot-actions">
        ${verUno}${subir}
      </div>
    </article>`;
}

function renderRequisitos(requisitos, progreso, readOnly) {
  const docs = $('hvDocs');
  docs.innerHTML = '';
  HV_GRUPOS.forEach((grupo) => {
    const items = requisitos.filter((req) => grupo.tipos.includes(req.tipo));
    if (!items.length) return;
    const wrap = document.createElement('section');
    wrap.className = 'hv-slot-group';
    wrap.innerHTML = `<h4>${escapeHtml(grupo.label)}</h4><div class="hv-slot-grid">${items.map((req) => renderSlot(req, readOnly)).join('')}</div>`;
    docs.appendChild(wrap);
  });

  const chip = $('hvMissingChip');
  const sub = $('hvSlotsSub');
  const faltan = faltantesDe(progreso);
  const vencidos = Number(progreso?.vencidos || 0);
  if (chip) {
    chip.hidden = false;
    if (readOnly) {
      chip.className = 'hv-missing-chip';
      chip.innerHTML = `${ICON_ALERT}<span>Ficha inactiva · los archivos se conservan</span>`;
    } else if (vencidos > 0) {
      chip.className = 'hv-missing-chip';
      chip.innerHTML = `${ICON_ALERT}<span>${vencidos} por renovar · no cuentan como listos</span>`;
    } else if (faltan > 0) {
      chip.className = 'hv-missing-chip';
      chip.innerHTML = `${ICON_ALERT}<span>Faltan ${faltan} archivo${faltan === 1 ? '' : 's'}</span>`;
    } else {
      chip.className = 'hv-missing-chip is-ok';
      chip.innerHTML = `${ICON_CHECK}<span>Todos los exigibles están vigentes</span>`;
    }
  }
  if (sub) {
    sub.textContent = readOnly
      ? 'Esta carpeta está inactiva. Puedes imprimirla o reactivarla.'
      : 'Cada documento tiene su espacio. Arrastra un archivo al slot o usa Subir.';
  }
}

async function abrirCarpeta(id) {
  hvFolderId = id;
  setError('hvFolderError', '');
  try {
    const res = await apiFetch(`/api/funcionarios/${id}`);
    const data = await res.json();
    if (!res.ok) {
      setError('hvError', data.error || 'No se pudo abrir la carpeta');
      return;
    }
    hvFolderData = data;
    const f = data.funcionario;
    const activo = Number(f.activo) !== 0;
    $('hvFolderTitulo').textContent = `${f.nombres} ${f.apellidos}`;
    $('hvFolderSub').textContent = `${f.tipo_label || 'Banco de hojas de vida'}${activo ? '' : ' · Inactivo'}`;
    pintarFotoFicha(f);
    if ($('hvFichaFoto')) {
      if (activo) $('hvFichaFoto').setAttribute('data-foto', f.id);
      else $('hvFichaFoto').removeAttribute('data-foto');
    }
    if ($('btnHvEditar')) $('btnHvEditar').hidden = !activo;
    if ($('btnHvInactivar')) $('btnHvInactivar').textContent = activo ? 'Inactivar' : 'Reactivar';
    renderFicha(f, data.progreso);
    renderRequisitos(data.requisitos || [], data.progreso, !activo);
    showView('view-hv-folder');
    if (location.hash !== `#hv/${id}`) {
      history.pushState({ view: 'hv-folder', id }, '', `#hv/${id}`);
    }
    applyUser(currentUser);
  } catch (_) {
    setError('hvError', 'Error de conexión');
  }
}

function abrirHv() {
  showView('view-hv');
  if (location.hash !== '#hv') {
    history.pushState({ view: 'hv' }, '', '#hv');
  }
  cargarFuncionarios();
}

function aplicarRutaAutenticado() {
  const hash = location.hash || '';
  const folder = hash.match(/^#hv\/(\d+)/);
  if (folder) {
    abrirCarpeta(folder[1]);
    cargarFuncionarios();
    return;
  }
  if (hash === '#hv') {
    abrirHv();
    return;
  }
  showView('view-home');
  cargarFuncionarios();
}

function asignarArchivo(input, file) {
  if (!input || !file) return false;
  try {
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    return true;
  } catch (_) {
    return false;
  }
}

function abrirDialogoSubida(tipo, file) {
  const req = (hvFolderData?.requisitos || []).find((r) => r.tipo === tipo);
  if (!req || !hvFolderId) return;
  hvUploadTipo = tipo;
  $('hvPdfTitulo').textContent = req.label;
  $('hvPdfNombre').textContent = req.multiple
    ? 'Puedes agregar varios certificados. Cada uno se conserva.'
    : 'Si ya hay un archivo, este lo reemplaza y el anterior se elimina.';
  $('hvPdfArchivo').value = '';
  if (file) asignarArchivo($('hvPdfArchivo'), file);
  $('hvPdfNacimiento').value = hvFolderData.funcionario.fecha_nacimiento || '';
  $('hvPdfFechaDoc').value = '';
  $('hvPdfVence').value = '';
  $('hvPdfExtraNac').classList.toggle('hidden', !req.pideFechaNacimiento);
  $('hvPdfExtraCurso').classList.toggle('hidden', req.pideFecha !== 'documento');
  $('hvPdfExtraPoliza').classList.toggle('hidden', req.pideFecha !== 'vencimiento');
  $('hvPdfNacimiento').required = Boolean(req.pideFechaNacimiento) && !hvFolderData.funcionario.fecha_nacimiento;
  $('hvPdfFechaDoc').required = req.pideFecha === 'documento';
  $('hvPdfVence').required = req.pideFecha === 'vencimiento';
  setError('hvPdfError', '');
  $('dlgHvPdf').showModal();
}

async function subirArchivoDirecto(tipo, file) {
  if (!hvFolderId || !file) return;
  const fd = new FormData();
  fd.append('archivo', file);
  fd.append('tipo', tipo);
  const res = await fetch(`/api/funcionarios/${hvFolderId}/documentos`, {
    method: 'POST',
    headers: csrfToken ? { 'x-csrf-token': csrfToken } : {},
    credentials: 'include',
    body: fd
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    setError('hvFolderError', data.error || 'No se pudo subir el archivo');
    return;
  }
  await abrirCarpeta(hvFolderId);
  cargarFuncionarios();
}

function recibirArchivoEnSlot(tipo, file) {
  if (!fichaActiva()) return;
  const req = (hvFolderData?.requisitos || []).find((r) => r.tipo === tipo);
  if (!req || !file) return;
  if (req.pideFecha || req.pideFechaNacimiento) {
    abrirDialogoSubida(tipo, file);
    return;
  }
  subirArchivoDirecto(tipo, file);
}

async function subirFotoArchivo(id, file) {
  if (!id || !file) return;
  const fd = new FormData();
  fd.append('foto', file);
  const res = await fetch(`/api/funcionarios/${id}/foto`, {
    method: 'POST',
    headers: csrfToken ? { 'x-csrf-token': csrfToken } : {},
    credentials: 'include',
    body: fd
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const errBox = String(hvFolderId) === String(id) ? 'hvFolderError' : 'hvError';
    setError(errBox, data.error || 'No se pudo subir la foto');
    return;
  }
  hvFotoTick = Date.now();
  if (hvFolderId && String(hvFolderId) === String(id)) await abrirCarpeta(id);
  await cargarFuncionarios();
}

function aplicarFiltroEstado(filtro) {
  if ($('hvFiltroEstado')) $('hvFiltroEstado').value = filtro || '';
  const quiereInactivos = filtro === 'inactivos';
  if (quiereInactivos !== hvCargandoInactivos) cargarFuncionarios();
  else pintarGrid();
}

function fichaActiva() {
  return Number(hvFolderData?.funcionario?.activo) !== 0;
}

function htmlFichaImpresion() {
  const f = hvFolderData?.funcionario;
  const reqs = hvFolderData?.requisitos || [];
  const p = hvFolderData?.progreso || {};
  if (!f) return '';
  const meta = [
    ['Documento', f.documento],
    ['Tipo', f.tipo_label],
    ['Vinculación', f.forma_label],
    ['Cargo', f.cargo],
    ['Área', f.area],
    ['Teléfono', f.telefono],
    ['Correo', f.correo],
    ['Cumpleaños', f.fecha_nacimiento ? formatCumple(f.fecha_nacimiento) : '—']
  ].map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v || '—')}</dd></div>`).join('');
  const rows = reqs.map((r) => {
    const latest = r.archivos[0];
    return `<tr>
      <td>${escapeHtml(r.label)}</td>
      <td>${r.required ? 'Exigible' : 'Opcional'}</td>
      <td>${escapeHtml(ESTADO_LABEL[r.estado] || r.estado)}</td>
      <td>${latest ? escapeHtml(latest.nombre) : '—'}</td>
      <td>${latest?.fecha_vencimiento ? formatFecha(latest.fecha_vencimiento) : '—'}</td>
    </tr>`;
  }).join('');
  return `
    <h1>${escapeHtml(f.nombres)} ${escapeHtml(f.apellidos)}</h1>
    <p class="lead">Ficha de requisitos para vincular · ${p.cargados || 0}/${p.requeridos || 0} vigentes · ${new Date().toLocaleDateString('es-CO')}</p>
    <div class="hv-print-meta hv-ficha">${meta}</div>
    <table>
      <thead>
        <tr><th>Requisito</th><th>Tipo</th><th>Estado</th><th>Archivo actual</th><th>Vence</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function imprimirFicha() {
  if (!hvFolderData) return;
  const sheet = $('hvPrintSheet');
  if (!sheet) return;
  sheet.hidden = false;
  sheet.innerHTML = htmlFichaImpresion();
  const done = () => {
    sheet.hidden = true;
    window.removeEventListener('afterprint', done);
  };
  window.addEventListener('afterprint', done);
  window.print();
}

function abrirDialogoEstado() {
  if (!hvFolderData?.funcionario) return;
  const activo = fichaActiva();
  $('hvInactivarTitulo').textContent = activo ? 'Inactivar colaborador' : 'Reactivar colaborador';
  $('hvInactivarTexto').textContent = activo
    ? 'La carpeta se oculta del tablero. Los archivos no se borran y se pueden consultar o reactivar después.'
    : 'La ficha vuelve al banco activo y se puede seguir cargando documentos.';
  $('btnHvInactivarOk').textContent = activo ? 'Inactivar' : 'Reactivar';
  setError('hvInactivarError', '');
  $('dlgHvInactivar').showModal();
}

function resetFiltrosHv() {
  if ($('hvFiltroTipo')) $('hvFiltroTipo').value = '';
  if ($('hvFiltroVinculacion')) $('hvFiltroVinculacion').value = '';
  if ($('hvFiltroEstado')) $('hvFiltroEstado').value = '';
  if ($('hvBuscar')) $('hvBuscar').value = '';
}

function setupHojasVida() {
  $('btnModuloHv')?.addEventListener('click', () => {
    resetFiltrosHv();
    abrirHv();
  });
  $('btnHvVolver')?.addEventListener('click', () => {
    showView('view-home');
    history.pushState({ view: 'home' }, '', '#home');
    if (hvCargandoInactivos) {
      if ($('hvFiltroEstado')) $('hvFiltroEstado').value = '';
      cargarFuncionarios();
    } else {
      pintarAlertas('homeAlertas');
    }
  });
  $('btnHvFolderVolver')?.addEventListener('click', abrirHv);
  $('hvBuscar')?.addEventListener('input', () => {
    clearTimeout(hvBuscarTimer);
    hvBuscarTimer = setTimeout(pintarGrid, 200);
  });
  ['hvFiltroTipo', 'hvFiltroVinculacion', 'hvFiltroEstado'].forEach((id) => {
    $(id)?.addEventListener('change', () => {
      if (id === 'hvFiltroEstado') {
        const quiereInactivos = $('hvFiltroEstado').value === 'inactivos';
        if (quiereInactivos !== hvCargandoInactivos) {
          cargarFuncionarios();
          return;
        }
      }
      pintarGrid();
    });
  });

  const onAlerta = (e) => {
    const btn = e.target.closest('[data-filtro]');
    if (!btn) return;
    aplicarFiltroEstado(btn.getAttribute('data-filtro'));
    if (e.currentTarget.id === 'homeAlertas') abrirHv();
    else pintarGrid();
  };
  $('homeAlertas')?.addEventListener('click', onAlerta);
  $('hvAlertas')?.addEventListener('click', onAlerta);

  $('hvGrid')?.addEventListener('click', (e) => {
    const fotoBtn = e.target.closest('[data-foto]');
    if (fotoBtn) {
      e.preventDefault();
      e.stopPropagation();
      elegirFoto(fotoBtn.getAttribute('data-foto'));
      return;
    }
    const card = e.target.closest('.hv-card');
    if (card?.dataset.id) abrirCarpeta(card.dataset.id);
  });

  const bindDrop = (el, onFiles) => {
    if (!el) return;
    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      const zone = e.target.closest('.hv-slot, .hv-card-photo, .hv-ficha-photo');
      zone?.classList.add('is-drop');
    });
    el.addEventListener('dragleave', (e) => {
      const zone = e.target.closest('.hv-slot, .hv-card-photo, .hv-ficha-photo');
      if (!e.relatedTarget || !zone?.contains(e.relatedTarget)) zone?.classList.remove('is-drop');
    });
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      document.querySelectorAll('.is-drop').forEach((n) => n.classList.remove('is-drop'));
      const files = e.dataTransfer?.files;
      if (files && files[0]) onFiles(e, files[0]);
    });
  };

  bindDrop($('hvGrid'), (e, file) => {
    const foto = e.target.closest('[data-foto]');
    if (foto) {
      e.stopPropagation();
      subirFotoArchivo(foto.getAttribute('data-foto'), file);
    }
  });
  bindDrop($('hvFichaFoto'), (_e, file) => {
    const id = $('hvFichaFoto').getAttribute('data-foto');
    if (id) subirFotoArchivo(id, file);
  });
  bindDrop($('hvDocs'), (e, file) => {
    const slot = e.target.closest('[data-tipo]');
    if (slot) recibirArchivoEnSlot(slot.getAttribute('data-tipo'), file);
  });

  $('hvFichaFoto')?.addEventListener('click', (e) => {
    const id = e.currentTarget.getAttribute('data-foto');
    if (id) elegirFoto(id);
  });

  $('hvFotoArchivo')?.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    const id = hvFotoId;
    e.target.value = '';
    if (file && id) await subirFotoArchivo(id, file);
  });

  $('hvDocs')?.addEventListener('click', (e) => {
    const ver = e.target.closest('[data-doc]');
    const subir = e.target.closest('[data-subir]');
    if (ver && hvFolderId) {
      window.open(`/api/funcionarios/${hvFolderId}/documentos/${ver.getAttribute('data-doc')}`, '_blank');
    }
    if (subir && fichaActiva()) abrirDialogoSubida(subir.getAttribute('data-subir'));
  });

  $('btnHvEditar')?.addEventListener('click', () => {
    if (!hvFolderData?.funcionario || !fichaActiva()) return;
    hvEditId = hvFolderData.funcionario.id;
    setError('hvNuevoError', '');
    llenarFormulario(hvFolderData.funcionario);
    mostrarPasoDatos(hvFolderData.funcionario.tipo_persona, true);
    $('dlgHvNuevo').showModal();
  });
  $('btnHvImprimir')?.addEventListener('click', imprimirFicha);
  $('btnHvInactivar')?.addEventListener('click', abrirDialogoEstado);
  $('btnHvInactivarCerrar')?.addEventListener('click', () => $('dlgHvInactivar').close());
  $('formHvInactivar')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!hvFolderId) return;
    const activo = fichaActiva() ? 0 : 1;
    setError('hvInactivarError', '');
    $('btnHvInactivarOk').disabled = true;
    try {
      const res = await apiFetch(`/api/funcionarios/${hvFolderId}/estado`, {
        method: 'PATCH',
        body: JSON.stringify({ activo })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError('hvInactivarError', data.error || 'No se pudo actualizar');
        return;
      }
      $('dlgHvInactivar').close();
      await abrirCarpeta(hvFolderId);
      cargarFuncionarios();
    } catch (_) {
      setError('hvInactivarError', 'Error de conexión');
    } finally {
      $('btnHvInactivarOk').disabled = false;
    }
  });

  $('btnHvNuevo')?.addEventListener('click', () => {
    resetDialogoNuevo();
    $('dlgHvNuevo').showModal();
  });
  $('btnHvNuevoCerrar')?.addEventListener('click', () => $('dlgHvNuevo').close());
  $('btnHvNuevoCerrarTipo')?.addEventListener('click', () => $('dlgHvNuevo').close());
  $('btnHvNuevoAtras')?.addEventListener('click', mostrarPasoTipo);
  $('btnHvPdfCerrar')?.addEventListener('click', () => $('dlgHvPdf').close());

  $('hvTipoPersonaSelect')?.addEventListener('change', (e) => {
    $('hvTipoPersona').value = e.target.value;
    mostrarPasoDatos(e.target.value, Boolean(hvEditId));
  });

  document.querySelectorAll('.hv-tipo-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      mostrarPasoDatos(btn.getAttribute('data-tipo'), false);
      $('hvNombres').focus();
    });
  });

  $('formHvNuevo')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    setError('hvNuevoError', '');
    $('btnHvGuardar').disabled = true;
    const body = payloadPersona();
    if (hvEditId && hvFolderData?.funcionario?.fecha_nacimiento) {
      body.fecha_nacimiento = hvFolderData.funcionario.fecha_nacimiento;
    }
    try {
      const url = hvEditId ? `/api/funcionarios/${hvEditId}` : '/api/funcionarios';
      const res = await apiFetch(url, {
        method: hvEditId ? 'PATCH' : 'POST',
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (!res.ok) {
        setError('hvNuevoError', data.error || 'No se pudo guardar');
        return;
      }
      $('dlgHvNuevo').close();
      const id = hvEditId || data.id;
      if (id) await abrirCarpeta(id);
      else await cargarFuncionarios();
    } catch (_) {
      setError('hvNuevoError', 'Error de conexión');
    } finally {
      $('btnHvGuardar').disabled = false;
    }
  });

  $('formHvPdf')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!hvFolderId || !hvUploadTipo) return;
    const archivo = $('hvPdfArchivo').files[0];
    if (!archivo) return;
    setError('hvPdfError', '');
    $('btnHvPdfGuardar').disabled = true;
    try {
      const fd = new FormData();
      fd.append('archivo', archivo);
      fd.append('tipo', hvUploadTipo);
      if ($('hvPdfNacimiento').value) fd.append('fecha_nacimiento', $('hvPdfNacimiento').value);
      if ($('hvPdfFechaDoc').value) fd.append('fecha_documento', $('hvPdfFechaDoc').value);
      if ($('hvPdfVence').value) fd.append('fecha_vencimiento', $('hvPdfVence').value);
      const res = await fetch(`/api/funcionarios/${hvFolderId}/documentos`, {
        method: 'POST',
        headers: csrfToken ? { 'x-csrf-token': csrfToken } : {},
        credentials: 'include',
        body: fd
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError('hvPdfError', data.error || 'No se pudo subir el archivo');
        return;
      }
      $('dlgHvPdf').close();
      await abrirCarpeta(hvFolderId);
      cargarFuncionarios();
    } catch (_) {
      setError('hvPdfError', 'Error de conexión');
    } finally {
      $('btnHvPdfGuardar').disabled = false;
    }
  });
}

function setupForms() {
  $('formEmail')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('loginEmail').value.trim().toLowerCase();
    if (!email) return;
    $('btnSolicitar').disabled = true;
    await solicitarCodigo(email);
    $('btnSolicitar').disabled = false;
  });

  $('loginCodigo')?.addEventListener('input', (e) => {
    e.target.value = formatCode(e.target.value);
  });

  $('formCodigo')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const codigo = $('loginCodigo').value;
    if (!pendingEmail || !codigo) return;
    $('btnVerificar').disabled = true;
    await verificarCodigo(pendingEmail, codigo);
    $('btnVerificar').disabled = false;
  });

  $('btnOtraCuenta')?.addEventListener('click', () => {
    showEmailStep();
    $('loginEmail').focus();
  });
}

function setupUpdateCheck() {
  const loaded = document.querySelector('meta[name="app-version"]')?.getAttribute('content') || '';
  const banner = $('updateBanner');

  function mostrarAviso() {
    banner?.classList.remove('hidden');
  }

  async function comprobar() {
    if (!loaded || loaded === 'dev') return;
    try {
      const res = await fetch('/api/version', { cache: 'no-store', credentials: 'include' });
      const data = await res.json();
      if (data.version && data.version !== loaded) mostrarAviso();
    } catch (_) { /* ignore */ }
  }

  $('btnActualizarApp')?.addEventListener('click', () => {
    const url = new URL(window.location.href);
    url.searchParams.set('_r', String(Date.now()));
    window.location.replace(url.toString());
  });

  comprobar();
  setInterval(comprobar, 30000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') comprobar();
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  setupForms();
  setupHojasVida();
  setupUpdateCheck();
  $('btnLogout')?.addEventListener('click', doLogout);
  document.querySelectorAll('.js-logout').forEach((btn) => btn.addEventListener('click', doLogout));
  const autenticado = await checkSession();
  if (!autenticado) await loadAccessState();
  window.addEventListener('popstate', () => {
    if (currentUser) aplicarRutaAutenticado();
  });
  hideSplash();
});
