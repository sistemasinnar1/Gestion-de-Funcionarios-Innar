const session = require('express-session');
const MySQLStoreFactory = require('express-mysql-session');

const INACTIVITY_MS = 60 * 60 * 1000;

function buildSessionStore() {
  const wantsMemory = (process.env.SESSION_STORE || '').toLowerCase() === 'memory';
  if (wantsMemory || !process.env.DB_HOST) return undefined;

  try {
    const MySQLStore = MySQLStoreFactory(session);
    const store = new MySQLStore({
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT, 10) || 3306,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME,
      createDatabaseTable: true,
      schema: {
        tableName: 'app_sessions',
        columnNames: {
          session_id: 'session_id',
          expires: 'expires',
          data: 'data'
        }
      },
      clearExpired: true,
      checkExpirationInterval: 15 * 60 * 1000,
      expiration: 8 * 60 * 60 * 1000
    });
    store.on('error', (err) => {
      console.error('[SESSION-STORE]', err && err.message);
    });
    return store;
  } catch (e) {
    console.warn('[SESSION-STORE] fallback a MemoryStore:', e.message);
    return undefined;
  }
}

function applySession(app) {
  const sessionCookieSecure = process.env.SESSION_COOKIE_SECURE !== undefined
    ? process.env.SESSION_COOKIE_SECURE === 'true'
    : process.env.NODE_ENV === 'production';
  const sessionCookieSameSite = process.env.SESSION_COOKIE_SAMESITE || 'lax';
  const store = buildSessionStore();

  app.set('trust proxy', 1);
  app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    proxy: true,
    rolling: true,
    ...(store ? { store } : {}),
    cookie: {
      secure: sessionCookieSecure,
      httpOnly: true,
      sameSite: sessionCookieSameSite,
      maxAge: 8 * 60 * 60 * 1000
    }
  }));

  app.use((req, res, next) => {
    if (!req.session) return next();
    const now = Date.now();
    if (req.session.lastActivity && (now - req.session.lastActivity) > INACTIVITY_MS) {
      return req.session.destroy(() => next());
    }
    req.session.lastActivity = now;
    next();
  });

  return { sessionCookieSecure, sessionCookieSameSite };
}

module.exports = { applySession, INACTIVITY_MS };
