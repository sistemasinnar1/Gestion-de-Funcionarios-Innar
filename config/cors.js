const cors = require('cors');

function applyCors(app) {
  const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3001').replace(/\/$/, '');
  const allowedOrigins = [frontendUrl];
  if (process.env.NODE_ENV !== 'production') {
    allowedOrigins.push(
      /^http:\/\/localhost:\d+$/,
      /^http:\/\/127\.0\.0\.1:\d+$/
    );
  }
  app.use(cors({ origin: allowedOrigins, credentials: true }));
}

module.exports = { applyCors };
