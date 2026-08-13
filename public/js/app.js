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

let hvPdfId = null;
let hvFolderId = null;
let hvBuscarTimer = null;

function iniciales(nombres, apellidos) {
  const a = String(nombres || '').trim().charAt(0);
  const b = String(apellidos || '').trim().charAt(0);
  return `${a}${b}`.toUpperCase() || 'F';
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
      const n = Number(row.hv_count || 0);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'hv-folder';
      btn.dataset.id = row.id;
      btn.innerHTML = `
        <span class="hv-folder-body">
          <span class="hv-folder-initials">${escapeHtml(iniciales(row.nombres, row.apellidos))}</span>
          <span class="hv-folder-name">${escapeHtml(row.nombres)} ${escapeHtml(row.apellidos)}</span>
          <span class="hv-folder-role">${escapeHtml(row.cargo || row.area || 'Sin cargo')}</span>
          <span class="hv-folder-count">${n} documento${n === 1 ? '' : 's'}</span>
        </span>`;
      grid.appendChild(btn);
    });
  } catch (_) {
    setError('hvError', 'Error de conexión');
  }
}

async function abrirCarpeta(id) {
  hvFolderId = id;
  hvPdfId = id;
  setError('hvFolderError', '');
  try {
    const res = await apiFetch(`/api/funcionarios/${id}`);
    const data = await res.json();
    if (!res.ok) {
      setError('hvError', data.error || 'No se pudo abrir la carpeta');
      return;
    }
    const f = data.funcionario;
    const nombre = `${f.nombres} ${f.apellidos}`;
    $('hvFolderTitulo').textContent = nombre;
    $('hvFolderSub').textContent = f.cargo || 'Hojas de vida';
    $('hvFolderMeta').textContent = [f.documento, f.cargo, f.area].filter(Boolean).join(' · ');
    const docs = $('hvDocs');
    const vacio = $('hvDocsVacio');
    docs.innerHTML = '';
    if (!data.documentos.length) {
      vacio.classList.remove('hidden');
    } else {
      vacio.classList.add('hidden');
      data.documentos.forEach((doc) => {
        const el = document.createElement('article');
        el.className = 'hv-doc';
        el.innerHTML = `
          <div class="hv-doc-icon">PDF</div>
          <div class="hv-doc-info">
            <strong>${escapeHtml(doc.tipo)} v${doc.version}</strong>
            <span>${escapeHtml(doc.nombre)} · ${formatFecha(doc.fecha)}</span>
          </div>
          <button type="button" data-doc="${doc.id}">Abrir</button>`;
        docs.appendChild(el);
      });
    }
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
    const btn = e.target.closest('[data-doc]');
    if (!btn || !hvFolderId) return;
    window.open(`/api/funcionarios/${hvFolderId}/hoja-vida/${btn.getAttribute('data-doc')}`, '_blank');
  });

  $('btnHvSubir')?.addEventListener('click', () => {
    if (!hvFolderId) return;
    hvPdfId = hvFolderId;
    $('hvPdfNombre').textContent = `PDF para ${$('hvFolderTitulo').textContent}`;
    $('hvPdfArchivo').value = '';
    setError('hvPdfError', '');
    $('dlgHvPdf').showModal();
  });

  $('btnHvNuevo')?.addEventListener('click', () => {
    $('formHvNuevo').reset();
    setError('hvNuevoError', '');
    $('dlgHvNuevo').showModal();
  });
  $('btnHvNuevoCerrar')?.addEventListener('click', () => $('dlgHvNuevo').close());
  $('btnHvPdfCerrar')?.addEventListener('click', () => $('dlgHvPdf').close());

  $('formHvNuevo')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    setError('hvNuevoError', '');
    $('btnHvGuardar').disabled = true;
    try {
      const res = await apiFetch('/api/funcionarios', {
        method: 'POST',
        body: JSON.stringify({
          nombres: $('hvNombres').value.trim(),
          apellidos: $('hvApellidos').value.trim(),
          documento: $('hvDocumento').value.trim(),
          cargo: $('hvCargo').value.trim(),
          area: $('hvArea').value.trim()
        })
      });
      const data = await res.json();
      if (!res.ok) {
        setError('hvNuevoError', data.error || 'No se pudo guardar');
        return;
      }
      const pdf = $('hvPdfNuevo').files[0];
      if (pdf && data.id) {
        const fd = new FormData();
        fd.append('archivo', pdf);
        const up = await fetch(`/api/funcionarios/${data.id}/hoja-vida`, {
          method: 'POST',
          headers: csrfToken ? { 'x-csrf-token': csrfToken } : {},
          credentials: 'include',
          body: fd
        });
        if (!up.ok) {
          const err = await up.json().catch(() => ({}));
          setError('hvNuevoError', err.error || 'El funcionario se creó, pero el PDF no se subió');
          await cargarFuncionarios();
          return;
        }
      }
      $('dlgHvNuevo').close();
      await cargarFuncionarios();
    } catch (_) {
      setError('hvNuevoError', 'Error de conexión');
    } finally {
      $('btnHvGuardar').disabled = false;
    }
  });

  $('formHvPdf')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!hvPdfId) return;
    const pdf = $('hvPdfArchivo').files[0];
    if (!pdf) return;
    setError('hvPdfError', '');
    $('btnHvPdfGuardar').disabled = true;
    try {
      const fd = new FormData();
      fd.append('archivo', pdf);
      const res = await fetch(`/api/funcionarios/${hvPdfId}/hoja-vida`, {
        method: 'POST',
        headers: csrfToken ? { 'x-csrf-token': csrfToken } : {},
        credentials: 'include',
        body: fd
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError('hvPdfError', data.error || 'No se pudo subir el PDF');
        return;
      }
      $('dlgHvPdf').close();
      await abrirCarpeta(hvPdfId);
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
