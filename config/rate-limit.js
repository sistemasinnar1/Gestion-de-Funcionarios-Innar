const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

function applyRateLimiters(app) {
  const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: Number(process.env.API_RATE_LIMIT_MAX || 500),
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Demasiadas solicitudes, intenta de nuevo en un minuto' },
    skip: (req) => req.path === '/health' || req.path === '/version' || req.path === '/health/db',
    keyGenerator: (req, res) => {
      if (req.session?.usuarioId) return `user:${req.session.usuarioId}`;
      return ipKeyGenerator(req, res);
    }
  });
  app.use('/api/', apiLimiter);

  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: Number(process.env.LOGIN_RATE_LIMIT_MAX || 40),
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Demasiados intentos de inicio de sesión. Intenta más tarde.' },
    keyGenerator: (req, res) => ipKeyGenerator(req, res)
  });
  app.use('/api/login', authLimiter);
  app.use('/api/acceso/solicitar', authLimiter);
  app.use('/api/acceso/verificar', authLimiter);
}

module.exports = { applyRateLimiters };
