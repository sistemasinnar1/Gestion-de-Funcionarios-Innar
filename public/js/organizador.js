(function () {
  let catalogo = null;
  let tareas = [];
  let agenda = [];
  let archivo = [];
  let orgTab = 'pendientes';
  let calMes = new Date();
  let diaSel = '';
  let completarRequiere = false;
  let archivoSeleccion = false;
  const archivoMarcadas = new Set();
  let arrastreId = '';

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
        ${done ? `<span class="org-pill">Hecha ${h.completada_en ? formatFechaHora(h.completada_en) : ''}</span>` : ''}
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
      ? `<p>Marcada como completada el ${t.completada_en ? formatFechaHora(t.completada_en) : '—'} ${t.completada_por_nombre ? `· ${escapeHtml(t.completada_por_nombre)}` : ''}${t.justificacion ? `<br>${escapeHtml(t.justificacion)}` : '<br>Sin justificación escrita.'}</p>`
      : `<p>${escapeHtml(t.detalle || t.cuadrante_label)}</p>`;
    return `<article class="org-task" data-id="${t.id}" ${archivo ? '' : 'draggable="true"'}>
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

  const ARCHIVO_HINT = 'Tareas ya cerradas. Aunque no pidan justificación, queda la fecha y hora en que se marcaron como completadas, y la prueba si se adjuntó.';

  function syncArchivoEliminarUi() {
    $('btnOrgArchivoEliminar')?.classList.toggle('hidden', archivoSeleccion);
    $('btnOrgArchivoEliminarOk')?.classList.toggle('hidden', !archivoSeleccion);
    $('btnOrgArchivoEliminarCancelar')?.classList.toggle('hidden', !archivoSeleccion);
    const hint = $('orgArchivoHint');
    if (hint) {
      hint.textContent = archivoSeleccion
        ? 'Marca una o varias tareas y pulsa Eliminar seleccionadas.'
        : ARCHIVO_HINT;
    }
  }

  function salirSeleccionArchivo() {
    archivoSeleccion = false;
    archivoMarcadas.clear();
    syncArchivoEliminarUi();
  }

  async function cargarArchivo() {
    try {
      const res = await apiFetch('/api/organizador/tareas?estado=completada');
      const data = await res.json();
      archivo = Array.isArray(data) ? data : [];
      const vigentes = new Set(archivo.map((t) => String(t.id)));
      archivoMarcadas.forEach((id) => {
        if (!vigentes.has(id)) archivoMarcadas.delete(id);
      });
      const el = $('orgArchivoLista');
      if (!el) return;
      el.innerHTML = archivo.length
        ? archivo.map((t) => `
            <div class="org-archivo-card${archivoSeleccion ? ' is-selecting' : ''}">
              ${archivoSeleccion ? `<label class="org-archivo-check"><input type="checkbox" data-org-archivo-check="${t.id}" ${archivoMarcadas.has(String(t.id)) ? 'checked' : ''} aria-label="Seleccionar tarea"/></label>` : ''}
              ${htmlTarea(t, { archivo: true })}
            </div>`).join('')
        : '<p class="hv-empty-table">Aún no hay tareas archivadas.</p>';
      if (!archivo.length && archivoSeleccion) salirSeleccionArchivo();
    } catch (_) { /* ignore */ }
  }

  function formatFechaHora(value) {
    if (!value) return '';
    const raw = String(value).replace('T', ' ').trim();
    const [fecha, hora] = raw.split(' ');
    const dia = formatFecha(fecha);
    const hhmm = (hora || '').slice(0, 5);
    return hhmm ? `${dia} ${hhmm}` : dia;
  }

  function isoDe(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function addMesesIso(iso, meses, anchorDay) {
    const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
    if (!y || !m || !d) return null;
    const day = anchorDay || d;
    const target = new Date(y, m - 1 + meses, 1);
    const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
    target.setDate(Math.min(day, last));
    return isoDe(target);
  }

  function mesesPeriodo(periodicidad) {
    if (periodicidad === 'mensual') return 1;
    if (periodicidad === 'trimestral') return 3;
    if (periodicidad === 'anual') return 12;
    if (periodicidad === 'cada_5_anios') return 60;
    if (periodicidad === 'cada_7_anios') return 84;
    if (periodicidad === 'cada_10_anios') return 120;
    return 0;
  }

  function addPeriodoIso(iso, periodicidad, ancla) {
    const raw = String(iso || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
    if (periodicidad === 'semanal') {
      const [y, m, d] = raw.split('-').map(Number);
      const dt = new Date(y, m - 1, d);
      dt.setDate(dt.getDate() + 7);
      return isoDe(dt);
    }
    const meses = mesesPeriodo(periodicidad);
    if (!meses) return raw;
    const anchorDay = Number(String(ancla || raw).slice(8, 10)) || Number(raw.slice(8, 10));
    return addMesesIso(raw, meses, anchorDay);
  }

  function ocurrenciasEntre(iso, periodicidad, desde, hasta) {
    const ancla = String(iso || '').slice(0, 10);
    const start = String(desde || '').slice(0, 10);
    const end = String(hasta || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ancla) || start > end) return [];
    if (!periodicidad || periodicidad === 'ninguna') {
      return ancla >= start && ancla <= end ? [ancla] : [];
    }
    let cursor = ancla;
    let guard = 0;
    while (cursor < start && guard < 2000) {
      const next = addPeriodoIso(cursor, periodicidad, ancla);
      if (!next || next <= cursor) return [];
      cursor = next;
      guard += 1;
    }
    const out = [];
    while (cursor && cursor <= end && guard < 2600) {
      if (cursor >= start) out.push(cursor);
      const next = addPeriodoIso(cursor, periodicidad, ancla);
      if (!next || next <= cursor) break;
      cursor = next;
      guard += 1;
    }
    return out;
  }

  function estadoDe(iso, alerta) {
    const hoy = isoDe(new Date());
    if (!iso) return 'sin_fecha';
    if (iso < hoy) return 'vencido';
    const a = new Date(`${hoy}T00:00:00`);
    const b = new Date(`${iso}T00:00:00`);
    const days = Math.round((b.getTime() - a.getTime()) / 86400000);
    return days <= (Number(alerta) || 0) ? 'por_vencer' : 'vigente';
  }

  function filasDelMes() {
    const y = calMes.getFullYear();
    const m = calMes.getMonth();
    const desde = isoDe(new Date(y, m, 1));
    const hasta = isoDe(new Date(y, m + 1, 0));
    const rows = [];
    agenda.forEach((ev) => {
      const fechas = ocurrenciasEntre(ev.fecha_base || ev.fecha, ev.periodicidad || 'ninguna', desde, hasta);
      fechas.forEach((fecha) => {
        rows.push({
          ...ev,
          fecha,
          fecha_estado: estadoDe(fecha, ev.alerta_dias)
        });
      });
    });
    rows.sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)));
    return rows;
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
    filasDelMes().forEach((ev) => {
      const f = String(ev.fecha || '').slice(0, 10);
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

  function fechaEv(e) {
    return String(e.fecha || '').slice(0, 10);
  }

  function pintarAgendaLista() {
    const el = $('orgAgendaLista');
    if (!el) return;
    const tipo = $('orgFiltroAgendaTipo')?.value || '';
    const pasaTipo = (e) => !tipo || e.tipo === tipo;
    const mes = filasDelMes().filter(pasaTipo);
    const pendientes = agenda
      .filter((e) => e.clave === 'preaviso' && pasaTipo(e))
      .map((e) => ({ ...e, fecha_estado: estadoDe(e.fecha, e.alerta_dias), fijo: true }))
      .filter((e) => e.fecha_estado === 'por_vencer' || e.fecha_estado === 'vencido');
    let rows;
    if (diaSel) {
      const vistos = new Set();
      const unico = (e) => {
        const clave = `${e.id}|${fechaEv(e)}`;
        if (vistos.has(clave)) return false;
        vistos.add(clave);
        return true;
      };
      const delDia = [...mes, ...pendientes].filter((e) => fechaEv(e) === diaSel && unico(e));
      const atrasadas = agenda
        .filter((e) => e.fuente === 'tarea' && pasaTipo(e) && fechaEv(e) && fechaEv(e) < diaSel)
        .map((e) => ({ ...e, fecha_estado: estadoDe(e.fecha, e.alerta_dias) }));
      const anteriores = [...mes, ...pendientes, ...atrasadas]
        .filter((e) => fechaEv(e) < diaSel && unico(e));
      anteriores.sort((a, b) => fechaEv(b).localeCompare(fechaEv(a))
        || String(a.titulo || '').localeCompare(String(b.titulo || ''), 'es'));
      rows = [...delDia, ...anteriores];
    } else {
      const idsMes = new Set(mes.map((e) => String(e.id)));
      rows = [...pendientes.filter((e) => !idsMes.has(String(e.id))), ...mes];
    }
    if (!rows.length) {
      el.innerHTML = '<p class="hv-empty-table">No hay eventos en este mes.</p>';
      return;
    }
    el.innerHTML = rows.map((e) => {
      const obs = (e.observaciones || []).slice(0, 3).map((o) =>
        `<div class="org-obs">${escapeHtml(formatFechaHora(o.creado_en))} · ${escapeHtml(o.texto)}${o.creado_por_nombre ? ` — ${escapeHtml(o.creado_por_nombre)}` : ''}${o.tiene_prueba ? ` · <button type="button" data-org-obs-prueba="${o.id}">Ver prueba</button>` : ''}</div>`
      ).join('');
      const banco = e.fuente === 'banco';
      const esTarea = e.fuente === 'tarea';
      return `<article class="org-agenda-card">
        <h5>${escapeHtml(e.titulo)}</h5>
        <div class="org-task-meta">
          <span class="org-pill">${escapeHtml(e.tipo_label || '')}</span>
          <span class="org-pill ${e.fecha_estado === 'vencido' ? 'is-late' : (e.fecha_estado === 'por_vencer' ? 'is-soon' : '')}">${formatFecha(e.fecha)}</span>
          ${e.periodicidad && e.periodicidad !== 'ninguna' ? `<span class="org-pill">${escapeHtml(e.periodicidad_label)}</span>` : ''}
          ${Number(e.requiere_prueba) === 1 ? '<span class="org-pill">Pide prueba</span>' : ''}
          ${e.fijo ? '<span class="org-pill is-soon">Sigue pendiente</span>' : ''}
          ${banco ? '<span class="org-pill is-banco">Banco HV</span>' : ''}
          ${esTarea ? '<span class="org-pill is-banco">Tarea</span>' : ''}
          ${e.ubicacion ? `<span class="org-pill">${escapeHtml(e.ubicacion)}</span>` : ''}
        </div>
        <p>${escapeHtml(e.detalle || '')}</p>
        ${obs}
        ${banco || esTarea ? '' : `<div class="org-task-actions">
          <button type="button" data-org-obs="${e.id}">Observación</button>
          <button type="button" data-org-hecho="${e.id}" data-prueba="${Number(e.requiere_prueba) === 1 ? 1 : 0}" data-titulo="${escapeHtml(e.titulo)}">Marcar realizado</button>
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

    $('orgMatriz')?.addEventListener('dragstart', (e) => {
      const card = e.target.closest('.org-task');
      if (!card || e.target.closest('button, a, input, label')) {
        e.preventDefault();
        return;
      }
      arrastreId = card.getAttribute('data-id') || '';
      card.classList.add('is-dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', arrastreId);
    });
    $('orgMatriz')?.addEventListener('dragend', (e) => {
      arrastreId = '';
      e.target.closest?.('.org-task')?.classList.remove('is-dragging');
      document.querySelectorAll('.org-col.is-drop').forEach((col) => col.classList.remove('is-drop'));
    });
    function marcarColumna(e) {
      const col = e.target.closest('.org-col');
      if (!col || !arrastreId) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      document.querySelectorAll('.org-col.is-drop').forEach((item) => item.classList.remove('is-drop'));
      col.classList.add('is-drop');
    }
    $('orgMatriz')?.addEventListener('dragenter', marcarColumna);
    $('orgMatriz')?.addEventListener('dragover', marcarColumna);
    $('orgMatriz')?.addEventListener('drop', async (e) => {
      const col = e.target.closest('.org-col');
      if (!col) return;
      e.preventDefault();
      col.classList.remove('is-drop');
      const id = e.dataTransfer.getData('text/plain') || arrastreId;
      arrastreId = '';
      const q = col.getAttribute('data-q');
      const niveles = {
        hacer: [4, 4],
        planear: [1, 4],
        atender: [4, 1],
        cuando: [1, 1]
      };
      const par = niveles[q];
      if (!id || !par) return;
      const actual = buscarTarea(id);
      if (actual && actual.cuadrante === q) return;
      try {
        const res = await apiFetch(`/api/organizador/tareas/${id}`, {
          method: 'PATCH',
          body: JSON.stringify({ urgencia: par[0], importancia: par[1] })
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          setError('orgError', data.error || 'No se pudo mover la tarea');
          return;
        }
        setError('orgError', '');
      } catch (_) {
        setError('orgError', 'Error de conexión');
        return;
      }
      cargarPendientes();
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
    $('orgArchivoLista')?.addEventListener('change', (e) => {
      const box = e.target.closest('[data-org-archivo-check]');
      if (!box) return;
      const id = box.getAttribute('data-org-archivo-check');
      if (box.checked) archivoMarcadas.add(id);
      else archivoMarcadas.delete(id);
    });
    $('btnOrgArchivoEliminar')?.addEventListener('click', () => {
      setError('orgArchivoError', '');
      if (!archivo.length) {
        setError('orgArchivoError', 'No hay tareas archivadas para eliminar');
        return;
      }
      archivoSeleccion = true;
      syncArchivoEliminarUi();
      cargarArchivo();
    });
    $('btnOrgArchivoEliminarCancelar')?.addEventListener('click', () => {
      setError('orgArchivoError', '');
      salirSeleccionArchivo();
      cargarArchivo();
    });
    $('btnOrgArchivoEliminarOk')?.addEventListener('click', async () => {
      const ids = [...archivoMarcadas];
      if (!ids.length) {
        setError('orgArchivoError', 'Selecciona al menos una tarea');
        return;
      }
      const texto = ids.length === 1
        ? '¿Eliminar esta tarea de la trazabilidad?'
        : `¿Eliminar estas ${ids.length} tareas de la trazabilidad?`;
      if (!confirm(texto)) return;
      setError('orgArchivoError', '');
      try {
        for (const id of ids) {
          const res = await apiFetch(`/api/organizador/tareas/${id}`, { method: 'DELETE' });
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            setError('orgArchivoError', data.error || 'No se pudo eliminar la tarea');
            break;
          }
          archivoMarcadas.delete(id);
        }
      } catch (_) {
        setError('orgArchivoError', 'Error de conexión');
      }
      if (!archivoMarcadas.size) salirSeleccionArchivo();
      cargarArchivo();
      pintarHomeOrg();
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

    function syncTipoAgenda() {
      const tipo = $('orgAgendaTipo')?.value || '';
      const alerta = catalogo?.tipos_agenda_alerta?.[tipo];
      if (alerta != null && $('orgAgendaAlerta')) $('orgAgendaAlerta').value = String(alerta);
      const pide = /mantenimiento|ascensor|equipo|insumo|extintor/.test(tipo);
      if (!$('orgAgendaId')?.value && $('orgAgendaPrueba')) $('orgAgendaPrueba').checked = pide;
    }

    $('btnOrgEventoNuevo')?.addEventListener('click', () => {
      $('formOrgAgenda')?.reset();
      $('orgAgendaId').value = '';
      $('orgAgendaTituloDlg').textContent = 'Nuevo evento';
      $('orgAgendaPeriodo').value = 'mensual';
      if (diaSel && $('orgAgendaFecha')) $('orgAgendaFecha').value = diaSel;
      syncTipoAgenda();
      setError('orgAgendaFormError', '');
      $('dlgOrgAgenda').showModal();
    });
    $('orgAgendaTipo')?.addEventListener('change', syncTipoAgenda);
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
        alerta_dias: $('orgAgendaAlerta').value,
        requiere_prueba: $('orgAgendaPrueba')?.checked ? 1 : 0
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
        diaSel = '';
        pintarCalendario();
        pintarAgendaLista();
        return;
      }
      if (e.target.id === 'orgCalNext') {
        calMes = new Date(calMes.getFullYear(), calMes.getMonth() + 1, 1);
        diaSel = '';
        pintarCalendario();
        pintarAgendaLista();
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
      const pruebaObs = e.target.closest('[data-org-obs-prueba]');
      if (pruebaObs) {
        window.open(`/api/organizador/agenda/obs/${pruebaObs.getAttribute('data-org-obs-prueba')}/prueba`, '_blank');
      }
      if (obs && !pruebaObs) {
        $('orgObsAgendaId').value = obs.getAttribute('data-org-obs');
        $('orgObsTexto').value = '';
        setError('orgObsError', '');
        $('dlgOrgObs').showModal();
      }
      if (hecho) {
        const pide = hecho.getAttribute('data-prueba') === '1';
        $('orgRealizarId').value = hecho.getAttribute('data-org-hecho');
        $('orgRealizarLead').textContent = hecho.getAttribute('data-titulo') || '';
        $('orgRealizarHint').textContent = pide
          ? 'Este evento exige archivo o una descripción de cómo se realizó. La próxima fecha periódica se calcula sola.'
          : 'La nota es opcional. Si es periódico, la siguiente fecha queda programada.';
        $('orgRealizarTexto').value = '';
        if ($('orgRealizarArchivo')) $('orgRealizarArchivo').value = '';
        $('orgRealizarId').dataset.prueba = pide ? '1' : '0';
        setError('orgRealizarError', '');
        $('dlgOrgRealizar').showModal();
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
        if ($('orgAgendaPrueba')) $('orgAgendaPrueba').checked = Number(ev.requiere_prueba) === 1;
        $('dlgOrgAgenda').showModal();
      }
      if (del && confirm('¿Quitar este evento del cronograma?')) {
        await apiFetch(`/api/organizador/agenda/${del.getAttribute('data-org-del-ev')}`, { method: 'DELETE' });
        cargarAgenda();
        pintarHomeOrg();
      }
    });

    $('btnOrgRealizarCerrar')?.addEventListener('click', () => $('dlgOrgRealizar')?.close());
    $('formOrgRealizar')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = $('orgRealizarId').value;
      const texto = $('orgRealizarTexto').value.trim();
      const archivoInput = $('orgRealizarArchivo')?.files?.[0];
      const pide = $('orgRealizarId').dataset.prueba === '1';
      if (pide && !texto && !archivoInput) {
        setError('orgRealizarError', 'Adjunta una prueba o describe cómo se realizó');
        return;
      }
      const fd = new FormData();
      fd.append('texto', texto || 'Marcado como realizado');
      if (archivoInput) fd.append('prueba', archivoInput);
      try {
        const res = await fetch(`/api/organizador/agenda/${id}/realizar`, {
          method: 'POST',
          headers: app().csrf?.() ? { 'x-csrf-token': app().csrf() } : {},
          credentials: 'include',
          body: fd
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError('orgRealizarError', data.error || 'No se pudo marcar');
          return;
        }
        $('dlgOrgRealizar').close();
        cargarAgenda();
        pintarHomeOrg();
      } catch (_) {
        setError('orgRealizarError', 'Error de conexión');
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
