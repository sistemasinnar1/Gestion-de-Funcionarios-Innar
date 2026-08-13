const $ = (id) => document.getElementById(id);

let currentUser = null;
let csrfToken = '';
let pendingEmail = '';

function showView(id) {
  ['view-login', 'view-home'].forEach((viewId) => {
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
  const nameEl = $('menuUserName');
  if (nameEl) nameEl.textContent = user?.nombre || user?.email || 'Usuario';
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
      showView('view-home');
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
      lead.textContent = `Ingresa tu correo institucional. Te enviaremos una contraseña de un solo uso, válida por ${data.expires_min} minutos.`;
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
  $('btnLogout')?.addEventListener('click', doLogout);
  const autenticado = await checkSession();
  if (!autenticado) await loadAccessState();
  hideSplash();
});
