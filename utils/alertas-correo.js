const db = require('./db-mysql');
const logger = require('./logger');
const mailer = require('./mailer');
const { auditarArchivos } = require('./respaldo');
const {
  armarChecklist,
  ALERTA_DIAS,
  CONTRATO_ALERTA_DIAS,
  estadoFecha,
  elegirTerminacion,
  fechasTerminacionParaAlerta,
  estadoPreaviso,
  preavisoCubreVigencia,
  limitePreaviso
} = require('./documentos-catalogo');
const { eventosDesdeBanco } = require('./organizador-banco');
const { enriquecerEvento, TEMATICAS, diasAvisoFrecuencia, horasAvisoFrecuencia, avisoHoraValida, avisoUsaHoraFija } = require('./organizador-catalogo');
const { fechaIso } = require('./documentos-catalogo');

const JOB_KEY = 'alertas_digest_dia';

function formatFecha(iso) {
  const d = String(iso || '').slice(0, 10);
  const [y, m, day] = d.split('-');
  return day && m && y ? `${day}/${m}/${y}` : d;
}

function nombreDe(row) {
  return `${row.nombres || ''} ${row.apellidos || ''}`.trim();
}

function cumpleEnDias(iso) {
  const raw = String(iso || '').slice(0, 10);
  const parts = raw.split('-');
  if (parts.length !== 3) return null;
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  let next = new Date(now.getFullYear(), month - 1, day);
  next.setHours(0, 0, 0, 0);
  if (next < now) next = new Date(now.getFullYear() + 1, month - 1, day);
  return Math.round((next.getTime() - now.getTime()) / 86400000);
}

function hoyIso() {
  return fechaEnBogota();
}

async function yaEnviadoHoy() {
  const row = await db.queryOne('SELECT valor FROM jobs_estado WHERE clave = ?', [JOB_KEY]);
  return row?.valor === hoyIso();
}

async function marcarEnviadoHoy() {
  await db.execute(
    `INSERT INTO jobs_estado (clave, valor) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE valor = VALUES(valor)`,
    [JOB_KEY, hoyIso()]
  );
}

async function destinatarios() {
  const rows = await db.query(
    `SELECT email, nombre FROM usuarios
     WHERE activo = 1 AND email IS NOT NULL AND email <> ''
       AND rol IN ('superadmin', 'admin', 'talento_humano', 'calidad')`
  );
  const list = [];
  const seen = new Set();
  rows.forEach((r) => {
    const email = String(r.email || '').trim().toLowerCase();
    if (!email.includes('@') || seen.has(email)) return;
    seen.add(email);
    list.push({ email, nombre: r.nombre || 'Equipo' });
  });
  const extra = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  if (extra.includes('@') && !seen.has(extra)) {
    list.push({ email: extra, nombre: 'Administración' });
  }
  return list;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function recogerAlertasOrganizador() {
  const vacio = { tareasVencidas: [], tareasHoy: [], agenda: [] };
  try {
    const pendientes = await db.query(
      `SELECT titulo, fecha_cumplimiento, tematica
       FROM org_tareas
       WHERE estado = 'pendiente' AND padre_id IS NULL`
    );
    const hoy = hoyIso();
    const tareasVencidas = [];
    const tareasHoy = [];
    pendientes.forEach((t) => {
      const fecha = String(t.fecha_cumplimiento || '').slice(0, 10);
      const row = {
        titulo: t.titulo,
        tematica: TEMATICAS[t.tematica] || t.tematica,
        vence: formatFecha(fecha)
      };
      if (fecha && fecha < hoy) tareasVencidas.push(row);
      else if (fecha === hoy) tareasHoy.push(row);
    });
    const eventos = await db.query('SELECT * FROM org_agenda WHERE activo = 1');
    const agenda = [
      ...eventos.map((e) => enriquecerEvento(e)),
      ...(await eventosDesdeBanco())
    ].filter((e) => e.clave !== 'preaviso' && (e.fecha_estado === 'vencido' || e.fecha_estado === 'por_vencer'))
      .map((e) => ({
        titulo: e.titulo,
        tipo: e.tipo_label,
        vence: formatFecha(e.fecha),
        estado: e.fecha_estado
      }));
    return { tareasVencidas, tareasHoy, agenda };
  } catch (_) {
    return vacio;
  }
}

async function recogerAlertas() {
  const org = await recogerAlertasOrganizador();
  const personas = await db.query(
    `SELECT id, nombres, apellidos, documento, fecha_nacimiento, tipo_persona,
            forma_vinculacion, electrodiagnostico, exige_telemedicina, proximo_examen_medico
     FROM funcionarios WHERE activo = 1
     ORDER BY apellidos, nombres`
  );
  if (!personas.length) {
    return {
      vencidos: [],
      porVencer: [],
      cumpleanos: [],
      incompletos: 0,
      examen: [],
      contratos: [],
      tareasVencidas: org.tareasVencidas,
      tareasHoy: org.tareasHoy,
      agendaOrg: org.agenda,
      archivosFaltantes: await auditarArchivos()
    };
  }

  const ids = personas.map((p) => p.id);
  const placeholders = ids.map(() => '?').join(',');
  const docs = await db.query(
    `SELECT funcionario_id, tipo, fecha_vencimiento, id, archivo_nombre
     FROM documentos
     WHERE funcionario_id IN (${placeholders})
     ORDER BY id DESC`,
    ids
  );
  const contratosRows = await db.query(
    `SELECT id, funcionario_id, fecha_terminacion, fecha_firma, fecha_inicio, tipo, descripcion
     FROM contratos
     WHERE funcionario_id IN (${placeholders})`,
    ids
  );
  const polizasRows = await db.query(
    `SELECT id, funcionario_id, descripcion, fecha_vencimiento
     FROM polizas
     WHERE funcionario_id IN (${placeholders}) AND fecha_vencimiento IS NOT NULL
     ORDER BY id DESC`,
    ids
  );
  const byPerson = {};
  docs.forEach((d) => {
    if (!byPerson[d.funcionario_id]) byPerson[d.funcionario_id] = [];
    byPerson[d.funcionario_id].push(d);
  });
  const contratosBy = {};
  contratosRows.forEach((c) => {
    if (!contratosBy[c.funcionario_id]) contratosBy[c.funcionario_id] = [];
    contratosBy[c.funcionario_id].push(c);
  });
  const polizaBy = {};
  polizasRows.forEach((p) => {
    if (!polizaBy[p.funcionario_id]) polizaBy[p.funcionario_id] = p;
  });

  const vencidos = [];
  const porVencer = [];
  const cumpleanos = [];
  const examen = [];
  const contratos = [];
  let incompletos = 0;

  personas.forEach((p) => {
    const checklist = armarChecklist(p.tipo_persona, byPerson[p.id] || [], p);
    const faltan = checklist.filter((item) => item.required && item.estado !== 'cargado' && item.estado !== 'por_vencer').length;
    if (faltan > 0) incompletos += 1;
    const persona = nombreDe(p);
    checklist.forEach((item) => {
      if (!item.required) return;
      if (item.estado !== 'vencido' && item.estado !== 'por_vencer') return;
      const latest = item.archivos[0];
      const row = {
        persona,
        documento: p.documento,
        requisito: item.label,
        vence: formatFecha(latest?.fecha_vencimiento)
      };
      if (item.estado === 'vencido') vencidos.push(row);
      else porVencer.push(row);
    });
    const pol = polizaBy[p.id];
    if (pol) {
      const st = estadoFecha(pol.fecha_vencimiento, ALERTA_DIAS);
      if (st === 'vencido' || st === 'por_vencer') {
        const row = {
          persona,
          documento: p.documento,
          requisito: pol.descripcion || 'Póliza',
          vence: formatFecha(pol.fecha_vencimiento)
        };
        if (st === 'vencido') vencidos.push(row);
        else porVencer.push(row);
      }
    }
    const examRequerido = p.forma_vinculacion === 'contrato_trabajo';
    const examEstado = examRequerido
      ? estadoFecha(p.proximo_examen_medico, ALERTA_DIAS)
      : null;
    if (examEstado === 'vencido' || examEstado === 'por_vencer') {
      examen.push({
        persona,
        vence: formatFecha(p.proximo_examen_medico),
        estado: examEstado
      });
    }
    const listaContratos = contratosBy[p.id] || [];
    const ultimaFin = elegirTerminacion(fechasTerminacionParaAlerta(listaContratos));
    if (p.forma_vinculacion === 'contrato_trabajo') {
      if (ultimaFin && !preavisoCubreVigencia(listaContratos, ultimaFin)) {
        const st = estadoPreaviso(ultimaFin);
        if (st === 'vencido' || st === 'por_vencer') {
          const limite = limitePreaviso(ultimaFin);
          contratos.push({
            persona,
            requisito: st === 'vencido'
              ? 'Plazo de preaviso vencido: carga el preaviso o el otrosí'
              : 'Cargar preaviso u otrosí',
            vence: `vigencia ${formatFecha(ultimaFin)}, plazo ${formatFecha(limite)}`,
            estado: st
          });
        }
      }
    } else if (ultimaFin) {
      const st = estadoFecha(ultimaFin, CONTRATO_ALERTA_DIAS);
      if (st === 'vencido' || st === 'por_vencer') {
        const ultimo = listaContratos
          .filter((c) => c.tipo !== 'preaviso' && String(c.fecha_terminacion || '').slice(0, 10) === ultimaFin)
          .sort((a, b) => Number(b.id || 0) - Number(a.id || 0))[0];
        contratos.push({
          persona,
          requisito: ultimo?.tipo === 'otrosi' ? 'Otrosí (última prórroga)' : 'Contrato (última vigencia)',
          vence: formatFecha(ultimaFin),
          estado: st
        });
      }
    }
    const days = cumpleEnDias(p.fecha_nacimiento);
    if (days != null && days >= 0 && days <= 7) {
      cumpleanos.push({
        persona,
        cuando: days === 0 ? 'hoy' : (days === 1 ? 'mañana' : `en ${days} días`)
      });
    }
  });

  return {
    vencidos,
    porVencer,
    cumpleanos,
    incompletos,
    examen,
    contratos,
    tareasVencidas: org.tareasVencidas,
    tareasHoy: org.tareasHoy,
    agendaOrg: org.agenda,
    archivosFaltantes: await auditarArchivos()
  };
}

function listaHtml(items, linea) {
  if (!items.length) return '<p style="margin:0;color:#64748b;">Ninguno.</p>';
  return `<ul style="margin:0;padding-left:18px;line-height:1.55;">${items.map((item) => `<li>${linea(item)}</li>`).join('')}</ul>`;
}

function armarMensaje(data) {
  const nArchivos = (data.archivosFaltantes || []).length;
  const examen = data.examen || [];
  const contratos = data.contratos || [];
  const tareasVencidas = data.tareasVencidas || [];
  const tareasHoy = data.tareasHoy || [];
  const agendaOrg = data.agendaOrg || [];
  const nAlertas = data.vencidos.length + data.porVencer.length + data.cumpleanos.length
    + nArchivos + examen.length + contratos.length
    + tareasVencidas.length + tareasHoy.length + agendaOrg.length;
  const subject = nArchivos
    ? `INNAR Gestión — ${nArchivos} archivo(s) faltan en disco`
    : (nAlertas
      ? `INNAR Gestión — ${data.vencidos.length} vencidos, ${data.porVencer.length} por vencer`
      : 'INNAR Gestión — resumen de fichas');

  const text = [
    'Resumen diario del banco de hojas de vida',
    '',
    `Documentos vencidos (${data.vencidos.length}):`,
    ...data.vencidos.map((r) => `- ${r.persona}: ${r.requisito} (venció ${r.vence})`),
    '',
    `Por vencer en ${ALERTA_DIAS} días (${data.porVencer.length}):`,
    ...data.porVencer.map((r) => `- ${r.persona}: ${r.requisito} (vence ${r.vence})`),
    '',
    `Examen médico periódico (${examen.length}):`,
    ...examen.map((r) => `- ${r.persona}: ${r.estado} (${r.vence})`),
    '',
    `Preaviso u otrosí (${contratos.length}; en contrato laboral avisa desde 60 días y el plazo es un poco antes de los 30):`,
    ...contratos.map((r) => `- ${r.persona}: ${r.requisito} ${r.estado} (${r.vence})`),
    '',
    `Tareas vencidas (${tareasVencidas.length}):`,
    ...tareasVencidas.map((r) => `- ${r.titulo} [${r.tematica}] (${r.vence})`),
    '',
    `Tareas para hoy (${tareasHoy.length}):`,
    ...tareasHoy.map((r) => `- ${r.titulo} [${r.tematica}]`),
    '',
    `Agenda de calidad (${agendaOrg.length}):`,
    ...agendaOrg.map((r) => `- ${r.titulo} — ${r.tipo} ${r.estado} (${r.vence})`),
    '',
    `Cumpleaños esta semana (${data.cumpleanos.length}):`,
    ...data.cumpleanos.map((r) => `- ${r.persona} (${r.cuando})`),
    '',
    `Fichas incompletas: ${data.incompletos}`,
    '',
    `Archivos faltantes en disco (${nArchivos}):`,
    ...(nArchivos ? data.archivosFaltantes.map((r) => `- ${r.tipo} ${r.nombre}`) : ['- Ninguno']),
    '',
    'Instituto Neurociencias de Nariño IPS S.A.S'
  ].join('\n');

  const html = `<!doctype html>
<html lang="es">
<body style="margin:0;padding:0;background:#eef2f1;font-family:Segoe UI,Roboto,sans-serif;color:#1f2937;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#eef2f1;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e2e8e7;">
        <tr>
          <td style="background:#2d4a47;color:#fff;padding:22px 28px;">
            <div style="font-size:13px;letter-spacing:.12em;text-transform:uppercase;opacity:.8;">Gestión Administrativa</div>
            <div style="font-size:20px;font-weight:700;margin-top:4px;">Alertas del banco</div>
          </td>
        </tr>
        <tr>
          <td style="padding:28px;">
            <p style="margin:0 0 18px;color:#64748b;line-height:1.5;">
              Resumen diario. Incluye documentos, examen periódico y, en contrato laboral, el pedido de preaviso u otrosí desde 60 días antes.
            </p>
            <p style="margin:0 0 8px;font-weight:800;color:#9f1239;">Vencidos (${data.vencidos.length})</p>
            ${listaHtml(data.vencidos, (r) => `<strong>${escapeHtml(r.persona)}</strong> — ${escapeHtml(r.requisito)} (venció ${escapeHtml(r.vence)})`)}
            <p style="margin:18px 0 8px;font-weight:800;color:#b45309;">Por vencer (${data.porVencer.length})</p>
            ${listaHtml(data.porVencer, (r) => `<strong>${escapeHtml(r.persona)}</strong> — ${escapeHtml(r.requisito)} (vence ${escapeHtml(r.vence)})`)}
            <p style="margin:18px 0 8px;font-weight:800;color:#0f766e;">Examen médico periódico (${examen.length})</p>
            ${listaHtml(examen, (r) => `<strong>${escapeHtml(r.persona)}</strong> — ${escapeHtml(r.estado)} (${escapeHtml(r.vence)})`)}
            <p style="margin:18px 0 8px;font-weight:800;color:#1d4ed8;">Preaviso u otrosí (${contratos.length})</p>
            ${listaHtml(contratos, (r) => `<strong>${escapeHtml(r.persona)}</strong> — ${escapeHtml(r.requisito)} ${escapeHtml(r.estado)} (${escapeHtml(r.vence)})`)}
            <p style="margin:18px 0 8px;font-weight:800;color:#9f1239;">Tareas vencidas (${tareasVencidas.length})</p>
            ${listaHtml(tareasVencidas, (r) => `<strong>${escapeHtml(r.titulo)}</strong> — ${escapeHtml(r.tematica)} (${escapeHtml(r.vence)})`)}
            <p style="margin:18px 0 8px;font-weight:800;color:#b45309;">Tareas para hoy (${tareasHoy.length})</p>
            ${listaHtml(tareasHoy, (r) => `<strong>${escapeHtml(r.titulo)}</strong> — ${escapeHtml(r.tematica)}`)}
            <p style="margin:18px 0 8px;font-weight:800;color:#0f766e;">Agenda de calidad (${agendaOrg.length})</p>
            ${listaHtml(agendaOrg, (r) => `<strong>${escapeHtml(r.titulo)}</strong> — ${escapeHtml(r.tipo)} ${escapeHtml(r.estado)} (${escapeHtml(r.vence)})`)}
            <p style="margin:18px 0 8px;font-weight:800;color:#5b21b6;">Cumpleaños esta semana (${data.cumpleanos.length})</p>
            ${listaHtml(data.cumpleanos, (r) => `<strong>${escapeHtml(r.persona)}</strong> — ${escapeHtml(r.cuando)}`)}
            <p style="margin:18px 0 8px;font-weight:800;color:#9f1239;">Archivos faltantes en disco (${nArchivos})</p>
            ${listaHtml(data.archivosFaltantes || [], (r) => `${escapeHtml(r.tipo)} — ${escapeHtml(r.nombre)}`)}
            <p style="margin:18px 0 0;color:#64748b;">Fichas incompletas: <strong>${data.incompletos}</strong></p>
          </td>
        </tr>
        <tr>
          <td style="padding:14px 28px;background:#f8faf9;color:#64748b;font-size:12px;">
            Instituto Neurociencias de Nariño IPS S.A.S
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return { subject, text, html, nAlertas };
}

async function enviarDigestAlertas({ forzar = false } = {}) {
  if (!mailer.isConfigured()) {
    return { ok: false, reason: 'smtp_no_configurado' };
  }
  try {
    if (!forzar && await yaEnviadoHoy()) {
      return { ok: true, skipped: true, reason: 'ya_enviado_hoy' };
    }
    const data = await recogerAlertas();
    if (!data.vencidos.length && !data.porVencer.length && !data.cumpleanos.length
      && !(data.archivosFaltantes || []).length
      && !(data.examen || []).length
      && !(data.contratos || []).length
      && !(data.tareasVencidas || []).length
      && !(data.tareasHoy || []).length
      && !(data.agendaOrg || []).length) {
      await marcarEnviadoHoy();
      return { ok: true, skipped: true, reason: 'sin_alertas' };
    }
    const destinos = await destinatarios();
    if (!destinos.length) {
      return { ok: false, reason: 'sin_destinatarios' };
    }
    const msg = armarMensaje(data);
    let enviados = 0;
    for (const dest of destinos) {
      const result = await mailer.sendMail({
        to: dest.email,
        subject: msg.subject,
        text: msg.text,
        html: msg.html
      });
      if (result.sent) enviados += 1;
    }
    if (enviados > 0) await marcarEnviadoHoy();
    logger.info('[ALERTAS] Digest enviado', {
      enviados,
      vencidos: data.vencidos.length,
      porVencer: data.porVencer.length
    });
    return { ok: enviados > 0, enviados };
  } catch (err) {
    logger.error('[ALERTAS] No se pudo enviar el digest', { message: err.message });
    return { ok: false, error: err.message };
  }
}

function horaEnBogota(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Bogota',
    hour: 'numeric',
    hour12: false
  }).formatToParts(date);
  return Number(parts.find((p) => p.type === 'hour')?.value);
}

function fechaEnBogota(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

function parseFechaHora(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  const raw = String(value).trim();
  if (!raw) return null;
  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? null : d;
}

function tareaDebeAvisar(t, { forzar = false, ahora = new Date(), hoy = fechaEnBogota(), horaDefault = 12 } = {}) {
  const freq = t.aviso_frecuencia && t.aviso_frecuencia !== 'ninguno'
    ? t.aviso_frecuencia
    : (Number(t.recordar_tarde) === 1 ? 'diario' : 'ninguno');
  if (freq === 'ninguno') return false;

  const ultimo = parseFechaHora(t.ultimo_aviso_en);
  const horas = horasAvisoFrecuencia(freq);
  if (horas) {
    if (forzar || !ultimo) return true;
    return ((ahora.getTime() - ultimo.getTime()) / 3600000) >= horas;
  }

  if (freq === 'hora_fija' || avisoUsaHoraFija(freq)) {
    const h = avisoHoraValida(t.aviso_hora);
    const horaObjetivo = h != null ? h : (freq === 'hora_fija' ? null : horaDefault);
    if (horaObjetivo == null) return false;
    if (!forzar && horaEnBogota(ahora) !== horaObjetivo) return false;
    if (freq === 'hora_fija' || freq === 'diario') {
      if (!forzar && ultimo && fechaEnBogota(ultimo) === hoy) return false;
      return true;
    }
    const cada = diasAvisoFrecuencia(freq);
    if (!cada) return false;
    if (!ultimo) return true;
    const ultimoDia = fechaEnBogota(ultimo);
    const [y1, m1, d1] = ultimoDia.split('-').map(Number);
    const [y2, m2, d2] = hoy.split('-').map(Number);
    const a = Date.UTC(y1, m1 - 1, d1);
    const b = Date.UTC(y2, m2 - 1, d2);
    const dias = Math.round((b - a) / 86400000);
    return dias >= cada;
  }

  return false;
}

async function enviarRecordatorioTarde({ forzar = false } = {}) {
  if (!mailer.isConfigured()) return { ok: false, reason: 'smtp_no_configurado' };
  const horaDefault = Number(process.env.ORG_HORA_TARDE || 12);
  const ahora = new Date();
  const hoy = fechaEnBogota(ahora);
  try {
    const tareas = await db.query(
      `SELECT id, titulo, tematica, fecha_cumplimiento, aviso_frecuencia, aviso_hora,
              recordar_tarde, ultimo_aviso_en
       FROM org_tareas
       WHERE estado = 'pendiente' AND padre_id IS NULL
         AND (
           aviso_frecuencia IN (
             'cada_2_horas', 'cada_4_horas', 'cada_8_horas', 'hora_fija',
             'diario', 'cada_2_dias', 'semanal'
           )
           OR recordar_tarde = 1
         )
       ORDER BY urgencia DESC, importancia DESC`
    );

    const pendientesAviso = tareas.filter((t) =>
      tareaDebeAvisar(t, { forzar, ahora, hoy, horaDefault })
    );

    if (!pendientesAviso.length) {
      return { ok: true, skipped: true, reason: 'sin_tareas' };
    }

    const destinos = await destinatarios();
    if (!destinos.length) return { ok: false, reason: 'sin_destinatarios' };

    const text = [
      'Recordatorio de tareas — INNAR Gestión',
      '',
      'Estas tareas siguen pendientes y tienen aviso periódico activado:',
      ...pendientesAviso.map((t) => {
        const freq = t.aviso_frecuencia && t.aviso_frecuencia !== 'ninguno'
          ? t.aviso_frecuencia
          : 'diario';
        const fecha = t.fecha_cumplimiento ? ` (fecha ${formatFecha(t.fecha_cumplimiento)})` : '';
        const hora = freq === 'hora_fija' && avisoHoraValida(t.aviso_hora) != null
          ? ` · ${String(avisoHoraValida(t.aviso_hora)).padStart(2, '0')}:00`
          : '';
        return `- ${t.titulo}${fecha} · aviso ${freq}${hora}`;
      })
    ].join('\n');

    const html = `<!doctype html>
<html lang="es"><body style="font-family:Segoe UI,Roboto,sans-serif;color:#1f2937;">
  <p>Estas tareas siguen pendientes y tienen <strong>aviso periódico</strong> activado:</p>
  <ul>${pendientesAviso.map((t) => {
    const fecha = t.fecha_cumplimiento ? ` · fecha ${escapeHtml(formatFecha(t.fecha_cumplimiento))}` : '';
    return `<li><strong>${escapeHtml(t.titulo)}</strong>${fecha}</li>`;
  }).join('')}</ul>
  <p style="color:#64748b;font-size:13px;">Instituto Neurociencias de Nariño IPS S.A.S</p>
</body></html>`;

    let enviados = 0;
    for (const dest of destinos) {
      const result = await mailer.sendMail({
        to: dest.email,
        subject: `INNAR Gestión — ${pendientesAviso.length} tarea(s) con aviso periódico`,
        text,
        html
      });
      if (result.sent) enviados += 1;
    }
    if (enviados > 0) {
      const ids = pendientesAviso.map((t) => t.id);
      const ph = ids.map(() => '?').join(',');
      const stamp = ahora.toISOString().slice(0, 19).replace('T', ' ');
      await db.execute(
        `UPDATE org_tareas SET ultimo_aviso_en = ? WHERE id IN (${ph})`,
        [stamp, ...ids]
      );
    }
    return { ok: enviados > 0, enviados, tareas: pendientesAviso.length };
  } catch (err) {
    logger.error('[ALERTAS] Recordatorio de tareas falló', { message: err.message });
    return { ok: false, error: err.message };
  }
}

function iniciarAlertasCorreo() {
  const delay = Number(process.env.ALERTAS_DELAY_MS || 45000);
  const every = Number(process.env.ALERTAS_INTERVAL_MS || 6 * 60 * 60 * 1000);
  setTimeout(() => {
    enviarDigestAlertas().catch(() => {});
    enviarRecordatorioTarde().catch(() => {});
  }, delay);
  setInterval(() => {
    enviarDigestAlertas().catch(() => {});
  }, every);
  setInterval(() => {
    enviarRecordatorioTarde().catch(() => {});
  }, 15 * 60 * 1000);
}

module.exports = { enviarDigestAlertas, iniciarAlertasCorreo, recogerAlertas, enviarRecordatorioTarde };
