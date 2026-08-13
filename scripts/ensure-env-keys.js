const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env');
if (!fs.existsSync(envPath)) process.exit(0);

const current = fs.readFileSync(envPath, 'utf8');
const extras = [
  ['ADMIN_EMAIL', 'admin@innar.local'],
  ['OTP_EXPIRY_MINUTES', '10'],
  ['SMTP_HOST', ''],
  ['SMTP_PORT', '465'],
  ['SMTP_SECURE', 'true'],
  ['SMTP_USER', ''],
  ['SMTP_PASS', ''],
  ['SMTP_FROM', '']
];

const lines = [];
for (const [key, value] of extras) {
  if (!new RegExp(`^${key}=`, 'm').test(current)) {
    lines.push(`${key}=${value}`);
  }
}

if (lines.length) {
  const prefix = current.endsWith('\n') ? '' : '\n';
  fs.appendFileSync(envPath, `${prefix}${lines.join('\n')}\n`);
}
