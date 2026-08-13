const nodemailer = require('nodemailer');
const logger = require('./logger');

function isConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function getTransport() {
  const port = parseInt(process.env.SMTP_PORT, 10) || 465;
  const secure = process.env.SMTP_SECURE
    ? process.env.SMTP_SECURE === 'true'
    : port === 465;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function sendAccessCode({ to, nombre, codigo, minutos }) {
  if (!isConfigured()) {
    return { sent: false, reason: 'smtp_no_configurado' };
  }

  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  const safeName = escapeHtml(nombre || 'Usuario');
  const safeCode = escapeHtml(codigo);

  try {
    await getTransport().sendMail({
      from: `"Innar Gestión" <${from}>`,
      to,
      subject: 'Tu contraseña temporal de Innar Gestión',
      text: [
        `Hola ${nombre || 'Usuario'},`,
        '',
        `Tu contraseña temporal para Innar Gestión es: ${codigo}`,
        `Caduca en ${minutos} minutos y solo se puede usar una vez.`,
        '',
        'Si no pediste este acceso, ignora este correo.',
        '',
        'Instituto Neurociencias de Nariño IPS S.A.S'
      ].join('\n'),
      html: `<!doctype html>
<html lang="es">
<body style="margin:0;padding:0;background:#eef2f1;font-family:Segoe UI,Roboto,sans-serif;color:#1f2937;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#eef2f1;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:520px;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e2e8e7;">
        <tr>
          <td style="background:#2d4a47;color:#fff;padding:22px 28px;">
            <div style="font-size:13px;letter-spacing:.12em;text-transform:uppercase;opacity:.8;">Archivo institucional</div>
            <div style="font-size:20px;font-weight:700;margin-top:4px;">Innar Gestión</div>
          </td>
        </tr>
        <tr>
          <td style="padding:28px;">
            <p style="margin:0 0 12px;font-size:16px;">Hola ${safeName},</p>
            <p style="margin:0 0 20px;color:#64748b;line-height:1.5;">
              Usa esta contraseña temporal para entrar al archivo de documentos, contratos y hojas de vida.
              Caduca en <strong>${minutos} minutos</strong> y es de un solo uso.
            </p>
            <div style="background:#f4f7f6;border:1px dashed #8AA6A1;border-radius:12px;padding:18px;text-align:center;letter-spacing:.28em;font-size:26px;font-weight:800;color:#1f3634;font-family:Consolas,monospace;">
              ${safeCode}
            </div>
            <p style="margin:20px 0 0;font-size:13px;color:#64748b;">
              Si no solicitaste este acceso, ignora este mensaje. Nadie de Innar te pedirá esta clave por teléfono.
            </p>
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
</html>`
    });
    return { sent: true };
  } catch (err) {
    logger.error('[MAIL] No se pudo enviar la contraseña temporal', { message: err.message });
    return { sent: false, reason: 'smtp_error' };
  }
}

module.exports = { isConfigured, sendAccessCode };
