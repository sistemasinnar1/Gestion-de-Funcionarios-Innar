require('dotenv').config();

const REQUIRED_ENV = ['DB_HOST', 'DB_USER', 'DB_NAME', 'SESSION_SECRET'];
const MISSING_ENV = REQUIRED_ENV.filter((key) => !process.env[key]);
if (MISSING_ENV.length > 0) {
  console.error(`[ERROR] Faltan variables de entorno: ${MISSING_ENV.join(', ')}`);
  console.error('[ERROR] Copie .env.example a .env y configure los valores.');
  process.exit(1);
}

if (process.env.SESSION_SECRET.length < 32) {
  console.error('[ERROR] SESSION_SECRET debe tener al menos 32 caracteres.');
  process.exit(1);
}

const express = require('express');
const path = require('path');

const db = require('./utils/db-mysql');
const logger = require('./utils/logger');
const { initializeDatabase } = require('./utils/init-db');
const { applyCors } = require('./config/cors');
const { applySession } = require('./config/session');
const { applySecurity } = require('./config/security');
const { applyRateLimiters } = require('./config/rate-limit');
const authRoutes = require('./routes/auth');

const PACKAGE_VERSION = require('./package.json').version;
const APP_VERSION = process.env.APP_BUILD_VERSION || PACKAGE_VERSION;
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = parseInt(process.env.PORT, 10) || 3001;

function createApp() {
  const app = express();
  app.locals.appVersion = APP_VERSION;

  applyCors(app);
  const { sessionCookieSecure, sessionCookieSameSite } = applySession(app);
  applySecurity(app, { sessionCookieSecure, sessionCookieSameSite });
  applyRateLimiters(app);

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use(express.static(PUBLIC_DIR));

  app.get('/api/version', (_req, res) => res.json({ version: APP_VERSION }));
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, version: APP_VERSION, uptime: process.uptime() });
  });
  app.get('/api/health/db', async (_req, res) => {
    try {
      const t0 = Date.now();
      await db.query('SELECT 1 AS ping');
      res.json({ ok: true, latency_ms: Date.now() - t0 });
    } catch (e) {
      res.status(503).json({ ok: false, error: e.message });
    }
  });

  app.use('/api', authRoutes);

  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });

  app.use((err, _req, res, _next) => {
    logger.error('[SERVER] error no controlado', { message: err.message });
    res.status(500).json({ error: 'Error interno del servidor' });
  });

  return app;
}

async function start() {
  await initializeDatabase();
  await db.initPool();
  const app = createApp();
  app.listen(PORT, () => {
    logger.info(`Innar Gestión v${APP_VERSION} en http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error('[STARTUP] No se pudo iniciar:', err.message);
  process.exit(1);
});
