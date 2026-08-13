function requireAuth(req, res, next) {
  if (req.session && req.session.usuarioId) return next();
  return res.status(401).json({ error: 'No autenticado' });
}

function safeError(err) {
  if (process.env.NODE_ENV !== 'production') return String(err.message || err).slice(0, 300);
  return 'Error interno';
}

module.exports = { requireAuth, safeError };
