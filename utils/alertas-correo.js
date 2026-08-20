const db = require('./db-mysql');
const logger = require('./logger');
const mailer = require('./mailer');
const { armarChecklist, ALERTA_DIAS } = require('./documentos-catalogo');
const { auditarArchivos } = require('./respaldo');

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
  const n = new Date();
  const m = String(n.getMonth() + 1).padStart(2, '0');
  const d = String(n.getDate()).padStart(2, '0');
  return `${n.getFullYear()}-${m}-${d}`;
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
       AND rol IN ('superadmin', 'admin', 'talento_humano')`
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

async function recogerAlertas() {
  const personas = await db.query(
    `SELECT id, nombres, apellidos, documento, fecha_nacimiento, tipo_persona
     FROM funcionarios WHERE activo = 1
     ORDER BY apellidos, nombres`
  );
  if (!personas.length) {
    return {
      vencidos: [],
      porVencer: [],
      cumpleanos: [],
      incompletos: 0,
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
  const byPerson = {};
  docs.forEach((d) => {
    if (!byPerson[d.funcionario_id]) byPerson[d.funcionario_id] = [];
    byPerson[d.funcionario_id].push(d);
  });

  const vencidos = [];
  const porVencer = [];
  const cumpleanos = [];
  let incompletos = 0;

  personas.forEach((p) => {
    const checklist = armarChecklist(p.tipo_persona, byPerson[p.id] || []);
    const faltan = checklist.filter((item) => item.required && item.estado !== 'cargado' && item.estado !== 'por_vencer').length;
    if (faltan > 0) incompletos += 1;
    const persona = nombreDe(p);
    checklist.forEach((item) => {
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
    archivosFaltantes: await auditarArchivos()
  };
}

function listaHtml(items, linea) {
  if (!items.length) return '<p style="margin:0;color:#64748b;">Ninguno.</p>';
  return `<ul style="margin:0;padding-left:18px;line-height:1.55;">${items.map((item) => `<li>${linea(item)}</li>`).join('')}</ul>`;
}

function armarMensaje(data) {
  const nArchivos = (data.archivosFaltantes || []).length;
  const nAlertas = data.vencidos.length + data.porVencer.length + data.cumpleanos.length + nArchivos;
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
              Resumen diario. Los cursos vencidos no cuentan como listos. La vigencia de los cursos de 2 años se revisa a ${ALERTA_DIAS} días.
            </p>
            <p style="margin:0 0 8px;font-weight:800;color:#9f1239;">Vencidos (${data.vencidos.length})</p>
            ${listaHtml(data.vencidos, (r) => `<strong>${escapeHtml(r.persona)}</strong> — ${escapeHtml(r.requisito)} (venció ${escapeHtml(r.vence)})`)}
            <p style="margin:18px 0 8px;font-weight:800;color:#b45309;">Por vencer (${data.porVencer.length})</p>
            ${listaHtml(data.porVencer, (r) => `<strong>${escapeHtml(r.persona)}</strong> — ${escapeHtml(r.requisito)} (vence ${escapeHtml(r.vence)})`)}
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
    if (!data.vencidos.length && !data.porVencer.length && !data.cumpleanos.length && !(data.archivosFaltantes || []).length) {
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

function iniciarAlertasCorreo() {
  const delay = Number(process.env.ALERTAS_DELAY_MS || 45000);
  const every = Number(process.env.ALERTAS_INTERVAL_MS || 6 * 60 * 60 * 1000);
  setTimeout(() => {
    enviarDigestAlertas().catch(() => {});
  }, delay);
  setInterval(() => {
    enviarDigestAlertas().catch(() => {});
  }, every);
}

module.exports = { enviarDigestAlertas, iniciarAlertasCorreo, recogerAlertas };
