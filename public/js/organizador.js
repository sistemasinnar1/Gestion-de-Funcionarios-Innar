(function () {
  let catalogo = null;
  let tareas = [];
  let agenda = [];
  let archivo = [];
  let orgTab = 'pendientes';
  let calMes = new Date();
  let diaSel = '';
  let completarRequiere = false;

  function app() {
    return window.innarApp || {};
  }

  const $ = (id) => (app().$ ? app().$(id) : document.getElementById(id));
  const apiFetch = (...args) => app().apiFetch(...args);
  const escapeHtml = (v) => app().escapeHtml(v);
  const formatFecha = (v) => app().formatFecha(v);
  const showView = (id) => app().showView(id);
  const setError = (id, msg) => app().setError(id, msg);

  const CUADRANTES = [
    { id: 'hacer', label: 'Hacer ahora', hint: 'Urgente e importante' },
    { id: 'planear', label: 'Planear', hint: 'Importante, no urgente' },
    { id: 'atender', label: 'Atender pronto', hint: 'Urgente, menos importante' },
    { id: 'cuando', label: 'Cuando se pueda', hint: 'Ni urgente ni esencial' }
  ];

  function fillSelect(el, map, extra) {
    if (!el || !map) return;
    const keep = extra || '';
    el.innerHTML = keep + Object.entries(map).map(([id, label]) =>
      `<option value="${escapeHtml(id)}">${escapeHtml(label)}</option>`
    ).join('');
  }

  async function cargarCatalogo() {
    if (catalogo) return catalogo;
    const res = await apiFetch('/api/organizador/catalogo');
    catalogo = await res.json();
    fillSelect($('orgFiltroTema'), catalogo.tematicas, '<option value="">Todas las temáticas</option>');
    fillSelect($('orgTareaTema'), catalogo.tematicas);
    fillSelect($('orgFiltroAgendaTipo'), catalogo.tipos_agenda, '<option value="">Todos los tipos</option>');
    fillSelect($('orgAgendaTipo'), catalogo.tipos_agenda);
    fillSelect($('orgAgendaPeriodo'), catalogo.periodicidades);
    return catalogo;
  }

  function mostrarTab(tab) {
    orgTab = tab;
    document.querySelectorAll('.org-tab').forEach((btn) => {
      btn.classList.toggle('is-on', btn.getAttribute('data-org-tab') === tab);
    });
    $('orgPanelPendientes')?.classList.toggle('hidden', tab !== 'pendientes');
    $('orgPanelAgenda')?.classList.toggle('hidden', tab !== 'agenda');
    $('orgPanelArchivo')?.classList.toggle('hidden', tab !== 'archivo');
    if (tab === 'pendientes') cargarPendientes();
    if (tab === 'agenda') cargarAgenda();
    if (tab === 'archivo') cargarArchivo();
  }

  async function pintarHomeOrg() {
    const el = $('homeOrgAlertas');
    if (!el) return;
    try {
      const res = await apiFetch('/api/organizador/resumen');
      if (!res.ok) return;
      const r = await res.json();
      const items = [
        r.vencidas ? `<button type="button" class="hv-alerta is-danger" data-org-go="pendientes"><strong>${r.vencidas}</strong><span>tareas vencidas</span></button>` : '',
        r.para_hoy ? `<button type="button" class="hv-alerta is-warn" data-org-go="pendientes"><strong>${r.para_hoy}</strong><span>tareas para hoy</span></button>` : '',
        r.pendientes ? `<button type="button" class="hv-alerta" data-org-go="pendientes"><strong>${r.pendientes}</strong><span>pendientes</span></button>` : '',
        r.agenda_alertas ? `<button type="button" class="hv-alerta is-warn" data-org-go="agenda"><strong>${r.agenda_alertas}</strong><span>agenda por vencer</span></button>` : ''
      ].filter(Boolean);
      el.hidden = !items.length;
      el.innerHTML = items.join('');
    } catch (_) {
      el.hidden = true;
    }
  }

  function pillFecha(t) {
    if (!t.fecha_cumplimiento) return '<span class="org-pill">Sin fecha</span>';
    const label = formatFecha(t.fecha_cumplimiento);
    if (t.fecha_estado === 'vencido') return `<span class="org-pill is-late">Venció ${label}</span>`;
    if (t.fecha_estado === 'por_vencer') return `<span class="org-pill is-soon">Vence ${label}</span>`;
    return `<span class="org-pill">${label}</span>`;
  }

  function htmlTarea(t, { archivo = false } = {}) {
    const hijos = (t.hijos || []).map((h) => {
      const done = h.estado === 'completada';
      return `<div class="org-sub">
        <strong>${escapeHtml(h.titulo)}</strong>
        ${done ? `<span class="org-pill">Hecha ${h.completada_en ? formatFecha(h.completada_en) : ''}</span>` : ''}
        ${done ? '' : `<div class="org-task-actions" style="margin-top:6px">
          <button type="button" data-org-completar="${h.id}" data-prueba="${h.requiere_prueba}">Completar</button>
        </div>`}
      </div>`;
    }).join('');
    const acciones = archivo
      ? `${t.prueba_path ? `<button type="button" data-org-prueba="${t.id}">Ver prueba</button>` : ''}`
      : `<button type="button" data-org-completar="${t.id}" data-prueba="${t.requiere_prueba}">Completar</button>
         <button type="button" data-org-sub="${t.id}">Subtarea</button>
         <button type="button" data-org-edit="${t.id}">Editar</button>
         <button type="button" data-org-del="${t.id}">Quitar</button>`;
    const extra = archivo
      ? `<p>Completada ${t.completada_en ? formatFecha(t.completada_en) : ''} ${t.completada_por_nombre ? `· ${escapeHtml(t.completada_por_nombre)}` : ''}${t.justificacion ? `<br>${escapeHtml(t.justificacion)}` : ''}</p>`
      : `<p>${escapeHtml(t.detalle || t.cuadrante_label)}</p>`;
    return `<article class="org-task" data-id="${t.id}">
      <h5>${escapeHtml(t.titulo)}</h5>
      ${extra}
      <div class="org-task-meta">
        <span class="org-pill">${escapeHtml(t.tematica_label || '')}</span>
        ${pillFecha(t)}
        ${Number(t.requiere_prueba) === 1 ? '<span class="org-pill">Pide prueba</span>' : ''}
        ${t.aviso_frecuencia && t.aviso_frecuencia !== 'ninguno'
          ? `<span class="org-pill">Aviso ${escapeHtml(t.aviso_frecuencia_label || t.aviso_frecuencia)}${
              AVISO_CON_HORA.has(t.aviso_frecuencia) && t.aviso_hora != null
                ? ` ${String(t.aviso_hora).padStart(2, '0')}:00`
                : ''
            }</span>`
          : ''}
      </div>
      <div class="org-task-actions">${acciones}</div>
      ${hijos}
    </article>`;
  }

  function ordenarTareas(lista) {
    const modo = $('orgFiltroOrden')?.value || 'eisenhower';
    const copy = [...lista];
    if (modo === 'fecha') {
      copy.sort((a, b) => String(a.fecha_cumplimiento || '9999').localeCompare(String(b.fecha_cumplimiento || '9999')));
    }
    return copy;
  }

  async function cargarPendientes() {
    setError('orgError', '');
    try {
      const tema = $('orgFiltroTema')?.value || '';
      const res = await apiFetch(`/api/organizador/tareas?estado=pendiente${tema ? `&tematica=${encodeURIComponent(tema)}` : ''}`);
      const data = await res.json();
      if (!res.ok) {
        setError('orgError', data.error || 'No se pudieron cargar las tareas');
        return;
      }
      tareas = Array.isArray(data) ? data : [];
      const el = $('orgMatriz');
      if (!el) return;
      const groups = { hacer: [], planear: [], atender: [], cuando: [] };
      ordenarTareas(tareas).forEach((t) => {
        (groups[t.cuadrante] || groups.cuando).push(t);
      });
      el.innerHTML = CUADRANTES.map((c) => `
        <div class="org-col" data-q="${c.id}">
          <h4>${c.label} · ${c.hint}</h4>
          ${groups[c.id].length ? groups[c.id].map((t) => htmlTarea(t)).join('') : '<p class="hv-empty-table">Nada aquí.</p>'}
        </div>`).join('');
    } catch (_) {
      setError('orgError', 'Error de conexión');
    }
  }

  async function cargarArchivo() {
    try {
      const res = await apiFetch('/api/organizador/tareas?estado=completada');
      const data = await res.json();
      archivo = Array.isArray(data) ? data : [];
      const el = $('orgArchivoLista');
      if (!el) return;
      el.innerHTML = archivo.length
        ? archivo.map((t) => `<div class="org-archivo-card">${htmlTarea(t, { archivo: true })}</div>`).join('')
        : '<p class="hv-empty-table">Aún no hay tareas archivadas.</p>';
    } catch (_) { /* ignore */ }
  }

  function isoDe(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function pintarCalendario() {
    const el = $('orgCalendario');
    if (!el) return;
    const y = calMes.getFullYear();
    const m = calMes.getMonth();
    const first = new Date(y, m, 1);
    const start = (first.getDay() + 6) % 7;
    const days = new Date(y, m + 1, 0).getDate();
    const byDay = {};
    agenda.forEach((ev) => {
      const f = String(ev.fecha || '').slice(0, 10);
      if (!f.startsWith(`${y}-${String(m + 1).padStart(2, '0')}`)) return;
      byDay[f] = (byDay[f] || 0) + 1;
    });
    const names = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
    let html = `<div class="hv-toolbar" style="grid-column:1/-1">
      <button type="button" class="btn-soft" id="orgCalPrev">←</button>
      <strong>${first.toLocaleDateString('es-CO', { month: 'long', year: 'numeric' })}</strong>
      <button type="button" class="btn-soft" id="orgCalNext">→</button>
    </div>`;
    html += names.map((n) => `<b>${n}</b>`).join('');
    for (let i = 0; i < start; i += 1) html += '<span></span>';
    for (let d = 1; d <= days; d += 1) {
      const iso = isoDe(new Date(y, m, d));
      html += `<button type="button" data-org-dia="${iso}" class="${diaSel === iso ? 'is-on' : ''}">${d}${byDay[iso] ? '<span class="org-dot"></span>' : ''}</button>`;
    }
    el.innerHTML = html;
  }

  function pintarAgendaLista() {
    const el = $('orgAgendaLista');
    if (!el) return;
    const tipo = $('orgFiltroAgendaTipo')?.value || '';
    let rows = agenda.filter((e) => !tipo || e.tipo === tipo);
    if (diaSel) rows = rows.filter((e) => String(e.fecha || '').slice(0, 10) === diaSel);
    if (!rows.length) {
      el.innerHTML = '<p class="hv-empty-table">No hay eventos en este filtro.</p>';
      return;
    }
    el.innerHTML = rows.map((e) => {
      const obs = (e.observaciones || []).slice(0, 3).map((o) =>
        `<div class="org-obs">${escapeHtml(formatFecha(o.creado_en))} · ${escapeHtml(o.texto)}${o.creado_por_nombre ? ` — ${escapeHtml(o.creado_por_nombre)}` : ''}</div>`
      ).join('');
      const banco = e.fuente === 'banco';
      const esTarea = e.fuente === 'tarea';
      return `<article class="org-agenda-card">
        <h5>${escapeHtml(e.titulo)}</h5>
        <div class="org-task-meta">
          <span class="org-pill">${escapeHtml(e.tipo_label || '')}</span>
          <span class="org-pill ${e.fecha_estado === 'vencido' ? 'is-late' : (e.fecha_estado === 'por_vencer' ? 'is-soon' : '')}">${formatFecha(e.fecha)}</span>
          ${e.periodicidad && e.periodicidad !== 'ninguna' ? `<span class="org-pill">${escapeHtml(e.periodicidad_label)}</span>` : ''}
          ${banco ? '<span class="org-pill is-banco">Banco HV</span>' : ''}
          ${esTarea ? '<span class="org-pill is-banco">Tarea</span>' : ''}
          ${e.ubicacion ? `<span class="org-pill">${escapeHtml(e.ubicacion)}</span>` : ''}
        </div>
        <p>${escapeHtml(e.detalle || '')}</p>
        ${obs}
        ${banco || esTarea ? '' : `<div class="org-task-actions">
          <button type="button" data-org-obs="${e.id}">Observación</button>
          <button type="button" data-org-hecho="${e.id}">Marcar realizado</button>
          <button type="button" data-org-edit-ev="${e.id}">Editar</button>
          <button type="button" data-org-del-ev="${e.id}">Quitar</button>
        </div>`}
      </article>`;
    }).join('');
  }

  async function cargarAgenda() {
    setError('orgAgendaError', '');
    try {
      const res = await apiFetch('/api/organizador/agenda');
      const data = await res.json();
      if (!res.ok) {
        setError('orgAgendaError', data.error || 'No se pudo cargar el cronograma');
        return;
      }
      agenda = Array.isArray(data) ? data : [];
      pintarCalendario();
      pintarAgendaLista();
    } catch (_) {
      setError('orgAgendaError', 'Error de conexión');
    }
  }

  const AVISO_CON_HORA = new Set(['hora_fija', 'diario', 'cada_2_dias', 'semanal']);

  function syncAvisoHoraUi() {
    const freq = $('orgTareaAviso')?.value || 'ninguno';
    const wrap = $('orgTareaAvisoHoraWrap');
    const padreId = $('orgTareaPadre')?.value;
    const mostrar = !padreId && AVISO_CON_HORA.has(freq);
    if (wrap) wrap.style.display = mostrar ? '' : 'none';
  }

  function abrirTareaDlg({ padreId = '', edit = null } = {}) {
    $('formOrgTarea')?.reset();
    $('orgTareaId').value = edit?.id || '';
    $('orgTareaPadre').value = padreId || '';
    $('orgTareaTituloDlg').textContent = edit ? 'Editar tarea' : (padreId ? 'Subtarea' : 'Nueva tarea');
    $('orgTareaAvisoWrap')?.classList.toggle('hidden', Boolean(padreId));
    if (edit) {
      $('orgTareaNombre').value = edit.titulo || '';
      $('orgTareaDetalle').value = edit.detalle || '';
      $('orgTareaTema').value = edit.tematica || 'otro';
      $('orgTareaUrgencia').value = String(edit.urgencia || 2);
      $('orgTareaImportancia').value = String(edit.importancia || 2);
      $('orgTareaFecha').value = String(edit.fecha_cumplimiento || '').slice(0, 10);
      $('orgTareaPrueba').checked = Number(edit.requiere_prueba) === 1;
      if ($('orgTareaAviso')) {
        $('orgTareaAviso').value = edit.aviso_frecuencia
          || (Number(edit.recordar_tarde) === 1 ? 'diario' : 'ninguno');
      }
      if ($('orgTareaAvisoHora')) {
        const hora = edit.aviso_hora != null ? Number(edit.aviso_hora) : 9;
        $('orgTareaAvisoHora').value = String(Number.isFinite(hora) ? hora : 9);
      }
    } else if ($('orgTareaAviso')) {
      $('orgTareaAviso').value = 'ninguno';
      if ($('orgTareaAvisoHora')) $('orgTareaAvisoHora').value = '9';
    }
    syncAvisoHoraUi();
    setError('orgTareaError', '');
    $('dlgOrgTarea').showModal();
  }

  function buscarTarea(id) {
    const stack = [...tareas, ...archivo];
    for (const t of stack) {
      if (String(t.id) === String(id)) return t;
      const h = (t.hijos || []).find((x) => String(x.id) === String(id));
      if (h) return h;
    }
    return null;
  }

  async function abrirOrganizador(hash) {
    showView('view-org');
    if (location.hash !== '#org' && !String(hash || '').startsWith('#org')) {
      history.pushState({ view: 'org' }, '', '#org');
    }
    await cargarCatalogo();
    const tab = String(hash || location.hash).includes('agenda') ? 'agenda'
      : (String(hash || location.hash).includes('archivo') ? 'archivo' : 'pendientes');
    mostrarTab(tab);
    pintarHomeOrg();
  }

  window.abrirOrganizador = abrirOrganizador;
  window.pintarHomeOrg = pintarHomeOrg;

  window.setupOrganizador = function setupOrganizador() {
    $('btnModuloOrg')?.addEventListener('click', () => abrirOrganizador('#org'));
    $('homeOrgAlertas')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-org-go]');
      if (!btn) return;
      abrirOrganizador(`#org/${btn.getAttribute('data-org-go')}`);
    });
    $('btnOrgVolver')?.addEventListener('click', () => {
      showView('view-home');
      history.pushState({ view: 'home' }, '', '#home');
      pintarHomeOrg();
    });
    document.querySelectorAll('.org-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tab = btn.getAttribute('data-org-tab');
        history.replaceState({ view: 'org', tab }, '', tab === 'pendientes' ? '#org' : `#org/${tab}`);
        mostrarTab(tab);
      });
    });
    $('orgFiltroTema')?.addEventListener('change', cargarPendientes);
    $('orgFiltroOrden')?.addEventListener('change', cargarPendientes);
    $('orgFiltroAgendaTipo')?.addEventListener('change', pintarAgendaLista);

    $('btnOrgTareaNueva')?.addEventListener('click', () => abrirTareaDlg());
    $('btnOrgTareaCerrar')?.addEventListener('click', () => $('dlgOrgTarea')?.close());
    $('orgTareaAviso')?.addEventListener('change', syncAvisoHoraUi);
    $('formOrgTarea')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      setError('orgTareaError', '');
      const id = $('orgTareaId').value;
      const body = {
        titulo: $('orgTareaNombre').value.trim(),
        detalle: $('orgTareaDetalle').value.trim(),
        tematica: $('orgTareaTema').value,
        urgencia: $('orgTareaUrgencia').value,
        importancia: $('orgTareaImportancia').value,
        fecha_cumplimiento: $('orgTareaFecha').value || null,
        requiere_prueba: $('orgTareaPrueba').checked ? 1 : 0,
        recordar_tarde: ($('orgTareaAviso')?.value && $('orgTareaAviso').value !== 'ninguno') ? 1 : 0,
        aviso_frecuencia: $('orgTareaAviso')?.value || 'ninguno',
        aviso_hora: AVISO_CON_HORA.has($('orgTareaAviso')?.value)
          ? Number($('orgTareaAvisoHora')?.value ?? 9)
          : null,
        padre_id: $('orgTareaPadre').value || null
      };
      try {
        const res = await apiFetch(id ? `/api/organizador/tareas/${id}` : '/api/organizador/tareas', {
          method: id ? 'PATCH' : 'POST',
          body: JSON.stringify(body)
        });
        const data = await res.json();
        if (!res.ok) {
          setError('orgTareaError', data.error || 'No se pudo guardar');
          return;
        }
        $('dlgOrgTarea').close();
        cargarPendientes();
        pintarHomeOrg();
      } catch (_) {
        setError('orgTareaError', 'Error de conexión');
      }
    });

    $('orgMatriz')?.addEventListener('click', async (e) => {
      const sub = e.target.closest('[data-org-sub]');
      const edit = e.target.closest('[data-org-edit]');
      const del = e.target.closest('[data-org-del]');
      const done = e.target.closest('[data-org-completar]');
      if (sub) abrirTareaDlg({ padreId: sub.getAttribute('data-org-sub') });
      if (edit) {
        const t = buscarTarea(edit.getAttribute('data-org-edit'));
        if (t) abrirTareaDlg({ edit: t, padreId: t.padre_id || '' });
      }
      if (del && confirm('¿Quitar esta tarea?')) {
        await apiFetch(`/api/organizador/tareas/${del.getAttribute('data-org-del')}`, { method: 'DELETE' });
        cargarPendientes();
        pintarHomeOrg();
      }
      if (done) {
        completarRequiere = done.getAttribute('data-prueba') === '1';
        $('orgCompletarId').value = done.getAttribute('data-org-completar');
        const t = buscarTarea($('orgCompletarId').value);
        $('orgCompletarLead').textContent = t?.titulo || '';
        $('orgCompletarHint').textContent = completarRequiere
          ? 'Esta tarea exige archivo o una descripción de cómo se completó.'
          : 'Opcional: deja una nota. Quedará la fecha y hora en trazabilidad.';
        $('orgCompletarTexto').value = '';
        if ($('orgCompletarArchivo')) $('orgCompletarArchivo').value = '';
        setError('orgCompletarError', '');
        $('dlgOrgCompletar').showModal();
      }
    });

    $('orgArchivoLista')?.addEventListener('click', (e) => {
      const prueba = e.target.closest('[data-org-prueba]');
      if (prueba) window.open(`/api/organizador/tareas/${prueba.getAttribute('data-org-prueba')}/prueba`, '_blank');
    });

    $('btnOrgCompletarCerrar')?.addEventListener('click', () => $('dlgOrgCompletar')?.close());
    $('formOrgCompletar')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = $('orgCompletarId').value;
      const texto = $('orgCompletarTexto').value.trim();
      const archivoInput = $('orgCompletarArchivo')?.files?.[0];
      if (completarRequiere && !texto && !archivoInput) {
        setError('orgCompletarError', 'Adjunta una prueba o describe cómo se completó');
        return;
      }
      const fd = new FormData();
      fd.append('justificacion', texto);
      if (archivoInput) fd.append('prueba', archivoInput);
      try {
        const res = await fetch(`/api/organizador/tareas/${id}/completar`, {
          method: 'POST',
          headers: app().csrf?.() ? { 'x-csrf-token': app().csrf() } : {},
          credentials: 'include',
          body: fd
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError('orgCompletarError', data.error || 'No se pudo completar');
          return;
        }
        $('dlgOrgCompletar').close();
        cargarPendientes();
        pintarHomeOrg();
      } catch (_) {
        setError('orgCompletarError', 'Error de conexión');
      }
    });

    $('btnOrgEventoNuevo')?.addEventListener('click', () => {
      $('formOrgAgenda')?.reset();
      $('orgAgendaId').value = '';
      $('orgAgendaTituloDlg').textContent = 'Nuevo evento';
      $('orgAgendaAlerta').value = '30';
      $('orgAgendaPeriodo').value = 'ninguna';
      if (diaSel && $('orgAgendaFecha')) $('orgAgendaFecha').value = diaSel;
      setError('orgAgendaFormError', '');
      $('dlgOrgAgenda').showModal();
    });
    $('btnOrgAgendaCerrar')?.addEventListener('click', () => $('dlgOrgAgenda')?.close());
    $('formOrgAgenda')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = $('orgAgendaId').value;
      const body = {
        titulo: $('orgAgendaNombre').value.trim(),
        tipo: $('orgAgendaTipo').value,
        ubicacion: $('orgAgendaUbicacion').value.trim(),
        detalle: $('orgAgendaDetalle').value.trim(),
        fecha: $('orgAgendaFecha').value,
        periodicidad: $('orgAgendaPeriodo').value,
        alerta_dias: $('orgAgendaAlerta').value
      };
      try {
        const res = await apiFetch(id ? `/api/organizador/agenda/${id}` : '/api/organizador/agenda', {
          method: id ? 'PATCH' : 'POST',
          body: JSON.stringify(body)
        });
        const data = await res.json();
        if (!res.ok) {
          setError('orgAgendaFormError', data.error || 'No se pudo guardar');
          return;
        }
        $('dlgOrgAgenda').close();
        cargarAgenda();
        pintarHomeOrg();
      } catch (_) {
        setError('orgAgendaFormError', 'Error de conexión');
      }
    });

    $('orgCalendario')?.addEventListener('click', (e) => {
      if (e.target.id === 'orgCalPrev') {
        calMes = new Date(calMes.getFullYear(), calMes.getMonth() - 1, 1);
        pintarCalendario();
        return;
      }
      if (e.target.id === 'orgCalNext') {
        calMes = new Date(calMes.getFullYear(), calMes.getMonth() + 1, 1);
        pintarCalendario();
        return;
      }
      const dia = e.target.closest('[data-org-dia]');
      if (!dia) return;
      diaSel = diaSel === dia.getAttribute('data-org-dia') ? '' : dia.getAttribute('data-org-dia');
      pintarCalendario();
      pintarAgendaLista();
    });

    $('orgAgendaLista')?.addEventListener('click', async (e) => {
      const obs = e.target.closest('[data-org-obs]');
      const hecho = e.target.closest('[data-org-hecho]');
      const edit = e.target.closest('[data-org-edit-ev]');
      const del = e.target.closest('[data-org-del-ev]');
      if (obs) {
        $('orgObsAgendaId').value = obs.getAttribute('data-org-obs');
        $('orgObsTexto').value = '';
        setError('orgObsError', '');
        $('dlgOrgObs').showModal();
      }
      if (hecho) {
        const nota = prompt('Nota de realización (opcional):', 'Realizado');
        if (nota === null) return;
        await apiFetch(`/api/organizador/agenda/${hecho.getAttribute('data-org-hecho')}/realizar`, {
          method: 'POST',
          body: JSON.stringify({ texto: nota })
        });
        cargarAgenda();
      }
      if (edit) {
        const ev = agenda.find((x) => String(x.id) === edit.getAttribute('data-org-edit-ev'));
        if (!ev || ev.fuente === 'banco') return;
        $('orgAgendaId').value = ev.id;
        $('orgAgendaTituloDlg').textContent = 'Editar evento';
        $('orgAgendaNombre').value = ev.titulo || '';
        $('orgAgendaTipo').value = ev.tipo || 'otro';
        $('orgAgendaUbicacion').value = ev.ubicacion || '';
        $('orgAgendaDetalle').value = ev.detalle || '';
        $('orgAgendaFecha').value = String(ev.fecha_base || ev.fecha || '').slice(0, 10);
        $('orgAgendaPeriodo').value = ev.periodicidad || 'ninguna';
        $('orgAgendaAlerta').value = ev.alerta_dias || 30;
        $('dlgOrgAgenda').showModal();
      }
      if (del && confirm('¿Quitar este evento del cronograma?')) {
        await apiFetch(`/api/organizador/agenda/${del.getAttribute('data-org-del-ev')}`, { method: 'DELETE' });
        cargarAgenda();
        pintarHomeOrg();
      }
    });

    $('btnOrgObsCerrar')?.addEventListener('click', () => $('dlgOrgObs')?.close());
    $('formOrgObs')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = $('orgObsAgendaId').value;
      try {
        const res = await apiFetch(`/api/organizador/agenda/${id}/observacion`, {
          method: 'POST',
          body: JSON.stringify({ texto: $('orgObsTexto').value.trim() })
        });
        const data = await res.json();
        if (!res.ok) {
          setError('orgObsError', data.error || 'No se pudo guardar');
          return;
        }
        $('dlgOrgObs').close();
        cargarAgenda();
      } catch (_) {
        setError('orgObsError', 'Error de conexión');
      }
    });
  };
})();
