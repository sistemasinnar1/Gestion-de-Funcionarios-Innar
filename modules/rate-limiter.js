const db = require('../utils/db-mysql');
const logger = require('../utils/logger');

const MAX_INTENTOS = 5;
const TIEMPO_BLOQUEO_MIN = 5;

function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0].trim()
    || req.socket?.remoteAddress
    || 'unknown';
}

async function isBlocked(ip) {
  try {
    const attempts = await db.queryOne(
      `SELECT intentos_fallidos,
              bloqueado_hasta,
              (bloqueado_hasta IS NOT NULL AND bloqueado_hasta > NOW()) AS aun_bloqueado
       FROM login_attempts
       WHERE ip_address = ?`,
      [ip]
    );
    if (!attempts) return false;
    if (attempts.intentos_fallidos < MAX_INTENTOS) return false;
    if (attempts.aun_bloqueado) return true;

    await db.execute(
      'UPDATE login_attempts SET intentos_fallidos = 0, bloqueado_hasta = NULL WHERE ip_address = ?',
      [ip]
    );
    return false;
  } catch (error) {
    logger.error('[RATE LIMIT] Error verificando bloqueo', { error: error.message });
    return false;
  }
}

async function recordFailedAttempt(ip, usuario) {
  try {
    const attempts = await db.queryOne(
      'SELECT id, intentos_fallidos, usuario FROM login_attempts WHERE ip_address = ?',
      [ip]
    );

    if (!attempts) {
      await db.execute(
        'INSERT INTO login_attempts (ip_address, usuario, intentos_fallidos, ultimo_intento) VALUES (?, ?, 1, NOW())',
        [ip, usuario || null]
      );
      return;
    }

    const nuevosIntentos = attempts.intentos_fallidos + 1;
    if (nuevosIntentos >= MAX_INTENTOS) {
      await db.execute(
        `UPDATE login_attempts
         SET intentos_fallidos = ?,
             bloqueado_hasta = DATE_ADD(NOW(), INTERVAL ? MINUTE),
             usuario = ?,
             ultimo_intento = NOW()
         WHERE ip_address = ?`,
        [nuevosIntentos, TIEMPO_BLOQUEO_MIN, usuario || attempts.usuario, ip]
      );
    } else {
      await db.execute(
        `UPDATE login_attempts
         SET intentos_fallidos = ?,
             bloqueado_hasta = NULL,
             usuario = ?,
             ultimo_intento = NOW()
         WHERE ip_address = ?`,
        [nuevosIntentos, usuario || attempts.usuario, ip]
      );
    }
  } catch (error) {
    logger.error('[RATE LIMIT] Error registrando intento fallido', { error: error.message });
  }
}

async function resetAttempts(ip) {
  try {
    await db.execute('DELETE FROM login_attempts WHERE ip_address = ?', [ip]);
  } catch (error) {
    logger.error('[RATE LIMIT] Error reseteando intentos', { error: error.message });
  }
}

async function getBlockInfo(ip) {
  try {
    const attempts = await db.queryOne(
      `SELECT intentos_fallidos,
              bloqueado_hasta,
              GREATEST(1, TIMESTAMPDIFF(MINUTE, NOW(), bloqueado_hasta)) AS minutos_restantes
       FROM login_attempts
       WHERE ip_address = ?`,
      [ip]
    );
    if (!attempts) return null;
    return {
      intentos: attempts.intentos_fallidos,
      bloqueado_hasta: attempts.bloqueado_hasta,
      minutos_restantes: Number(attempts.minutos_restantes) || 1
    };
  } catch (error) {
    logger.error('[RATE LIMIT] Error obteniendo info de bloqueo', { error: error.message });
    return null;
  }
}

module.exports = {
  getClientIP,
  isBlocked,
  recordFailedAttempt,
  resetAttempts,
  getBlockInfo,
  MAX_INTENTOS,
  TIEMPO_BLOQUEO_MIN
};
