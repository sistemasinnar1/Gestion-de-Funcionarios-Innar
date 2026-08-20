const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const WATCHED = [
  'package.json',
  'server.js',
  'public/index.html',
  'public/css/style.css',
  'public/js/app.js',
  'routes/funcionarios.js',
  'routes/auth.js',
  'utils/documentos-catalogo.js',
  'utils/alertas-correo.js',
  'utils/mailer.js',
  'utils/storage.js',
  'utils/respaldo.js'
];

function getBuildId() {
  const stamp = WATCHED.map((rel) => {
    try {
      const stat = fs.statSync(path.join(ROOT, rel));
      return `${rel}:${stat.mtimeMs}`;
    } catch (_) {
      return `${rel}:0`;
    }
  }).join('|');
  return crypto.createHash('sha1').update(stamp).digest('hex').slice(0, 12);
}

module.exports = { getBuildId };
