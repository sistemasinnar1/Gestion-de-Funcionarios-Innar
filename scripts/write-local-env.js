const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const envPath = path.join(root, '.env');
if (fs.existsSync(envPath)) process.exit(0);

const secret = crypto.randomBytes(48).toString('hex');
const contents = [
  'DB_HOST=localhost',
  'DB_PORT=3306',
  'DB_USER=root',
  'DB_PASSWORD=',
  'DB_NAME=innar_gestion',
  '',
  'PORT=3001',
  'NODE_ENV=development',
  '',
  `SESSION_SECRET=${secret}`,
  '',
  'FRONTEND_URL=http://localhost:3001',
  'SESSION_COOKIE_SECURE=false',
  'SESSION_COOKIE_SAMESITE=lax',
  '',
  'CSP_ENABLED=true',
  'CSP_REPORT_ONLY=true',
  '',
  'API_RATE_LIMIT_MAX=500',
  'LOGIN_RATE_LIMIT_MAX=40',
  ''
].join('\n');

fs.writeFileSync(envPath, contents, { encoding: 'utf8', mode: 0o600 });
