const crypto = require('crypto');
const helmet = require('helmet');

const CSRF_TOKEN_COOKIE = 'csrf_token';
const CSRF_HEADER = 'x-csrf-token';

function applyHelmet(app) {
  const cspEnabled = (process.env.CSP_ENABLED || 'true').toLowerCase() === 'true';
  const cspReportOnly = (process.env.CSP_REPORT_ONLY || 'true').toLowerCase() === 'true';

  app.use(helmet({
    hsts: process.env.NODE_ENV === 'production' ? { maxAge: 31536000, includeSubDomains: true } : false,
    crossOriginEmbedderPolicy: false,
    frameguard: { action: 'sameorigin' },
    contentSecurityPolicy: cspEnabled ? {
      reportOnly: cspReportOnly,
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        frameAncestors: ["'self'"],
        objectSrc: ["'none'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'", 'data:'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        connectSrc: ["'self'"],
        ...(cspReportOnly ? { upgradeInsecureRequests: null } : {})
      }
    } : false
  }));
}

function applySecurity(app, { sessionCookieSecure, sessionCookieSameSite }) {
  applyHelmet(app);

  const cookieOpts = {
    httpOnly: false,
    secure: sessionCookieSecure,
    sameSite: sessionCookieSameSite,
    path: '/',
    maxAge: 8 * 60 * 60 * 1000
  };

  function ensureCsrfForSession(req, res) {
    if (!req.session) return;
    if (!req.session.csrfToken) {
      req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    }
    res.cookie(CSRF_TOKEN_COOKIE, req.session.csrfToken, cookieOpts);
  }

  app.use((req, res, next) => {
    const method = (req.method || 'GET').toUpperCase();
    if (method === 'GET' && (req.path || '').startsWith('/api/') && req.session?.usuarioId) {
      ensureCsrfForSession(req, res);
    }
    next();
  });

  app.use((req, res, next) => {
    const p = req.path || '';
    const method = (req.method || 'GET').toUpperCase();
    const mutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);

    if (p === '/api/login' || p === '/api/logout') return next();
    if (p === '/api/acceso/solicitar' || p === '/api/acceso/verificar') return next();
    if (p === '/api/sesion' && method === 'GET') return next();
    if (p === '/api/acceso/estado' && method === 'GET') return next();
    if (!p.startsWith('/api/')) return next();
    if (!mutating) return next();
    if (!req.session?.usuarioId) return next();

    const tokenSession = req.session?.csrfToken;
    const tokenHeader = req.get(CSRF_HEADER);
    if (!tokenSession || !tokenHeader || tokenHeader !== tokenSession) {
      return res.status(403).json({ error: 'Token CSRF inválido o faltante', code: 'CSRF_INVALID' });
    }
    next();
  });

  app.locals.ensureCsrfForSession = ensureCsrfForSession;
  return { ensureCsrfForSession };
}

module.exports = { applySecurity, CSRF_TOKEN_COOKIE, CSRF_HEADER };
