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
let hvBuscarTimer = null;

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

function faltantesDe(progreso) {
  if (!progreso) return 0;
  if (Number.isFinite(progreso.faltantes)) return Number(progreso.faltantes);
  return Math.max(0, Number(progreso.requeridos || 0) - Number(progreso.cargados || 0));
}

async function cargarFuncionarios() {
  setError('hvError', '');
  const q = ($('hvBuscar')?.value || '').trim();
  const url = q ? `/api/funcionarios?q=${encodeURIComponent(q)}` : '/api/funcionarios';
  try {
    const res = await apiFetch(url);
    const data = await res.json();
    if (!res.ok) {
      setError('hvError', data.error || 'No se pudo cargar la lista');
      return;
    }
    const grid = $('hvGrid');
    const vacio = $('hvVacio');
    grid.innerHTML = '';
    if (!data.length) {
      vacio.classList.remove('hidden');
      return;
    }
    vacio.classList.add('hidden');
    data.forEach((row) => {
      const p = row.progreso || { cargados: 0, requeridos: 0 };
      const faltan = faltantesDe(p);
      const alerta = row.alerta;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'hv-folder';
      btn.dataset.id = row.id;
      const badge = faltan > 0
        ? `<span class="hv-folder-badge" title="Faltan ${faltan} archivo${faltan === 1 ? '' : 's'}">${ICON_ALERT}<b>${faltan}</b></span>`
        : `<span class="hv-folder-badge is-ok" title="Requisitos al día">${ICON_CHECK}</span>`;
      const avance = faltan > 0
        ? `Faltan ${faltan} archivo${faltan === 1 ? '' : 's'}`
        : `${p.cargados}/${p.requeridos} al día`;
      btn.innerHTML = `
        <span class="hv-folder-body">
          ${badge}
          <span class="hv-folder-initials">${escapeHtml(iniciales(row.nombres, row.apellidos))}</span>
          <span class="hv-folder-name">${escapeHtml(row.nombres)} ${escapeHtml(row.apellidos)}</span>
          <span class="hv-folder-role">${escapeHtml(row.tipo_label || '')} · ${escapeHtml(row.forma_label || 'Sin vinculación')}</span>
          <span class="hv-folder-count${alerta || faltan ? ' is-alert' : ''}">${escapeHtml(avance)}</span>
        </span>`;
      grid.appendChild(btn);
    });
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
  return bits.join(' · ');
}

function renderSlot(req) {
  const badge = !req.required && req.estado === 'falta'
    ? '<span class="hv-badge hv-badge-opcional">Opcional</span>'
    : `<span class="hv-badge hv-badge-${req.estado}">${ESTADO_LABEL[req.estado] || req.estado}</span>`;
  const latest = req.archivos[0];
  const files = req.archivos.length > 1
    ? `<div class="hv-slot-files">${req.archivos.map((a) => `
        <div class="hv-slot-file">
          <span>${escapeHtml(a.nombre)}</span>
          <button type="button" data-doc="${a.id}">Ver</button>
        </div>`).join('')}</div>`
    : '';
  return `
    <article class="hv-slot is-${req.estado}">
      <div class="hv-slot-icon">${req.estado === 'falta' ? ICON_PLUS : ICON_FILE}</div>
      <div class="hv-slot-top">
        <h5>${escapeHtml(req.label)}</h5>
        ${badge}
      </div>
      <p>${escapeHtml(textoSlot(req))}</p>
      ${files}
      <div class="hv-slot-actions">
        ${latest && req.archivos.length === 1 ? `<button type="button" data-doc="${latest.id}">Ver</button>` : ''}
        <button type="button" class="hv-slot-upload" data-subir="${escapeHtml(req.tipo)}">${req.estado === 'falta' ? 'Subir archivo' : (req.multiple ? 'Agregar' : 'Reemplazar')}</button>
      </div>
    </article>`;
}

function renderRequisitos(requisitos, progreso) {
  const docs = $('hvDocs');
  docs.innerHTML = '';
  HV_GRUPOS.forEach((grupo) => {
    const items = requisitos.filter((req) => grupo.tipos.includes(req.tipo));
    if (!items.length) return;
    const wrap = document.createElement('section');
    wrap.className = 'hv-slot-group';
    wrap.innerHTML = `<h4>${escapeHtml(grupo.label)}</h4><div class="hv-slot-grid">${items.map(renderSlot).join('')}</div>`;
    docs.appendChild(wrap);
  });

  const chip = $('hvMissingChip');
  const sub = $('hvSlotsSub');
  const faltan = faltantesDe(progreso);
  if (chip) {
    chip.hidden = false;
    if (faltan > 0) {
      chip.className = 'hv-missing-chip';
      chip.innerHTML = `${ICON_ALERT}<span>Faltan ${faltan} archivo${faltan === 1 ? '' : 's'}</span>`;
    } else {
      chip.className = 'hv-missing-chip is-ok';
      chip.innerHTML = `${ICON_CHECK}<span>Todos los exigibles están cargados</span>`;
    }
  }
  if (sub) {
    sub.textContent = 'Cada documento tiene su espacio, esté o no cargado.';
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
    $('hvFolderTitulo').textContent = `${f.nombres} ${f.apellidos}`;
    $('hvFolderSub').textContent = f.tipo_label || 'Banco de hojas de vida';
    renderFicha(f, data.progreso);
    renderRequisitos(data.requisitos || [], data.progreso);
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
    return;
  }
  if (hash === '#hv') {
    abrirHv();
    return;
  }
  showView('view-home');
}

function abrirDialogoSubida(tipo) {
  const req = (hvFolderData?.requisitos || []).find((r) => r.tipo === tipo);
  if (!req || !hvFolderId) return;
  hvUploadTipo = tipo;
  $('hvPdfTitulo').textContent = req.label;
  $('hvPdfNombre').textContent = req.multiple ? 'Puedes cargar varios archivos en este requisito.' : 'Si ya hay un archivo, este queda como la versión actual.';
  $('hvPdfArchivo').value = '';
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

function setupHojasVida() {
  $('btnModuloHv')?.addEventListener('click', abrirHv);
  $('btnHvVolver')?.addEventListener('click', () => {
    showView('view-home');
    history.pushState({ view: 'home' }, '', '#home');
  });
  $('btnHvFolderVolver')?.addEventListener('click', abrirHv);
  $('hvBuscar')?.addEventListener('input', () => {
    clearTimeout(hvBuscarTimer);
    hvBuscarTimer = setTimeout(cargarFuncionarios, 250);
  });

  $('hvGrid')?.addEventListener('click', (e) => {
    const card = e.target.closest('.hv-folder');
    if (card?.dataset.id) abrirCarpeta(card.dataset.id);
  });

  $('hvDocs')?.addEventListener('click', (e) => {
    const ver = e.target.closest('[data-doc]');
    const subir = e.target.closest('[data-subir]');
    if (ver && hvFolderId) {
      window.open(`/api/funcionarios/${hvFolderId}/documentos/${ver.getAttribute('data-doc')}`, '_blank');
    }
    if (subir) abrirDialogoSubida(subir.getAttribute('data-subir'));
  });

  $('btnHvEditar')?.addEventListener('click', () => {
    if (!hvFolderData?.funcionario) return;
    hvEditId = hvFolderData.funcionario.id;
    setError('hvNuevoError', '');
    llenarFormulario(hvFolderData.funcionario);
    mostrarPasoDatos(hvFolderData.funcionario.tipo_persona, true);
    $('dlgHvNuevo').showModal();
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

document.addEventListener('DOMContentLoaded', async () => {
  setupForms();
  setupHojasVida();
  $('btnLogout')?.addEventListener('click', doLogout);
  document.querySelectorAll('.js-logout').forEach((btn) => btn.addEventListener('click', doLogout));
  const autenticado = await checkSession();
  if (!autenticado) await loadAccessState();
  window.addEventListener('popstate', () => {
    if (currentUser) aplicarRutaAutenticado();
  });
  hideSplash();
});
