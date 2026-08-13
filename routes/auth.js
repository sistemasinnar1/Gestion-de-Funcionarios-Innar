const express = require('express');
const router = express.Router();
const db = require('../utils/db-mysql');
const logger = require('../utils/logger');
const rateLimiter = require('../modules/rate-limiter');
const mailer = require('../utils/mailer');
const { requireAuth, safeError } = require('../middleware');
const { generateCode, hashCode, codesMatch, isValidEmail, EXPIRY_MINUTES } = require('../utils/otp');

const GENERIC_OK = 'Si el correo está registrado, enviamos una contraseña temporal. Revisa tu bandeja y el correo no deseado.';
const MAX_CODE_ATTEMPTS = 5;
const RESEND_COOLDOWN_SEC = 60;
const MAX_CODES_PER_WINDOW = 3;

function getEnsureCsrf(req) {
  return req.app.locals.ensureCsrfForSession;
}

function isLocalAuthMode() {
  return process.env.NODE_ENV === 'development' && !mailer.isConfigured();
}

function createSession(req, res, user) {
  req.session.usuarioId = user.id;
  req.session.usuario = user.usuario;
  req.session.nombre = user.nombre;
  req.session.rol = user.rol;
  req.session.email = user.email;

  req.session.save((saveErr) => {
    if (saveErr) {
      logger.error('Error al guardar sesión', { message: saveErr.message });
      return res.status(500).json({ error: 'Error interno al iniciar sesión' });
    }
    const ensureCsrf = getEnsureCsrf(req);
    if (ensureCsrf) ensureCsrf(req, res);
    res.json({
      ok: true,
      csrfToken: req.session.csrfToken,
      usuario: {
        id: user.id,
        usuario: user.usuario,
        nombre: user.nombre,
        rol: user.rol,
        email: user.email
      }
    });
  });
}

router.post('/acceso/solicitar', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const clientIP = rateLimiter.getClientIP(req);

  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Ingresa un correo válido' });
  }

  try {
    if (await rateLimiter.isBlocked(clientIP)) {
      const blockInfo = await rateLimiter.getBlockInfo(clientIP);
      return res.status(429).json({
        error: 'Demasiados intentos. Intenta más tarde.',
        minutos_restantes: blockInfo?.minutos_restantes || 5
      });
    }

    const user = await db.queryOne(
      'SELECT id, usuario, nombre, email FROM usuarios WHERE email = ? AND activo = 1',
      [email]
    );

    const payload = { ok: true, message: GENERIC_OK, expires_min: EXPIRY_MINUTES };

    if (!user) {
      return res.json(payload);
    }

    const recent = await db.queryOne(
      `SELECT COUNT(*) AS n,
              MAX(creado_en) AS ultimo,
              (MAX(creado_en) IS NOT NULL AND MAX(creado_en) > DATE_SUB(NOW(), INTERVAL ? SECOND)) AS en_cooldown
       FROM access_codes
       WHERE usuario_id = ? AND creado_en > DATE_SUB(NOW(), INTERVAL 15 MINUTE)`,
      [RESEND_COOLDOWN_SEC, user.id]
    );

    if (Number(recent?.n) >= MAX_CODES_PER_WINDOW || recent?.en_cooldown) {
      return res.json(payload);
    }

    await db.execute(
      'UPDATE access_codes SET used_at = NOW() WHERE usuario_id = ? AND used_at IS NULL',
      [user.id]
    );

    const { raw, display } = generateCode();
    await db.execute(
      `INSERT INTO access_codes (usuario_id, codigo_hash, expires_at, ip_address)
       VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE), ?)`,
      [user.id, hashCode(raw), EXPIRY_MINUTES, clientIP]
    );

    const mail = await mailer.sendAccessCode({
      to: user.email,
      nombre: user.nombre,
      codigo: display,
      minutos: EXPIRY_MINUTES
    });

    if (isLocalAuthMode() && !mail.sent) {
      payload.modo_local = true;
      payload.codigo_local = display;
    }

    return res.json(payload);
  } catch (e) {
    logger.error('[AUTH] solicitar', { message: e.message });
    res.status(500).json({ error: safeError(e) });
  }
});

router.post('/acceso/verificar', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const codigo = String(req.body?.codigo || '');
  const clientIP = rateLimiter.getClientIP(req);

  if (!isValidEmail(email) || !codigo.trim()) {
    return res.status(400).json({ error: 'Correo y contraseña temporal requeridos' });
  }

  try {
    if (await rateLimiter.isBlocked(clientIP)) {
      const blockInfo = await rateLimiter.getBlockInfo(clientIP);
      return res.status(429).json({
        error: 'Demasiados intentos fallidos. Intenta más tarde.',
        minutos_restantes: blockInfo?.minutos_restantes || 5
      });
    }

    const user = await db.queryOne(
      'SELECT id, usuario, nombre, rol, email FROM usuarios WHERE email = ? AND activo = 1',
      [email]
    );

    if (!user) {
      await rateLimiter.recordFailedAttempt(clientIP, email);
      return res.status(401).json({ error: 'Correo o contraseña temporal incorrectos' });
    }

    const row = await db.queryOne(
      `SELECT id, codigo_hash, intentos
       FROM access_codes
       WHERE usuario_id = ? AND used_at IS NULL AND expires_at > NOW()
       ORDER BY id DESC
       LIMIT 1`,
      [user.id]
    );

    if (!row || !codesMatch(codigo, row.codigo_hash)) {
      if (row) {
        const next = row.intentos + 1;
        if (next >= MAX_CODE_ATTEMPTS) {
          await db.execute('UPDATE access_codes SET intentos = ?, used_at = NOW() WHERE id = ?', [next, row.id]);
        } else {
          await db.execute('UPDATE access_codes SET intentos = ? WHERE id = ?', [next, row.id]);
        }
      }
      await rateLimiter.recordFailedAttempt(clientIP, email);
      return res.status(401).json({ error: 'Correo o contraseña temporal incorrectos' });
    }

    await db.execute('UPDATE access_codes SET used_at = NOW() WHERE id = ?', [row.id]);
    await rateLimiter.resetAttempts(clientIP);
    await db.execute('UPDATE usuarios SET ultimo_acceso = NOW() WHERE id = ?', [user.id]).catch(() => {});
    createSession(req, res, user);
  } catch (e) {
    logger.error('[AUTH] verificar', { message: e.message });
    res.status(500).json({ error: safeError(e) });
  }
});

router.get('/acceso/estado', (_req, res) => {
  const local = isLocalAuthMode();
  res.json({
    smtp: mailer.isConfigured(),
    modo_local: local,
    correo_local: local ? (process.env.ADMIN_EMAIL || 'admin@innar.local') : null,
    expires_min: EXPIRY_MINUTES
  });
});

router.post('/logout', (req, res) => {
  res.clearCookie('csrf_token', { path: '/' });
  if (!req.session) return res.json({ ok: true });
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/sesion', async (req, res) => {
  if (!req.session?.usuarioId) {
    return res.json({ autenticado: false });
  }
  try {
    const user = await db.queryOne(
      'SELECT id, usuario, nombre, rol, email FROM usuarios WHERE id = ? AND activo = 1',
      [req.session.usuarioId]
    );
    if (!user) {
      return req.session.destroy(() => res.json({ autenticado: false }));
    }
    req.session.nombre = user.nombre;
    req.session.rol = user.rol;
    const ensureCsrf = getEnsureCsrf(req);
    if (ensureCsrf) ensureCsrf(req, res);
    res.json({ autenticado: true, csrfToken: req.session.csrfToken, usuario: user });
  } catch (e) {
    logger.error('[AUTH] sesion', { message: e.message });
    if (req.session) {
      return req.session.destroy(() => res.json({ autenticado: false }));
    }
    res.status(500).json({ error: safeError(e) });
  }
});

router.get('/mi-cuenta', requireAuth, async (req, res) => {
  try {
    const row = await db.queryOne(
      'SELECT id, usuario, nombre, rol, email, creado_en, ultimo_acceso FROM usuarios WHERE id = ?',
      [req.session.usuarioId]
    );
    if (!row) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: safeError(e) });
  }
});

module.exports = router;
