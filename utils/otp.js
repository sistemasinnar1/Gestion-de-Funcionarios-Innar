const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LEN = 8;
const EXPIRY_MINUTES = parseInt(process.env.OTP_EXPIRY_MINUTES, 10) || 10;

function pepper() {
  return process.env.SESSION_SECRET || '';
}

function generateCode() {
  const bytes = crypto.randomBytes(CODE_LEN);
  let raw = '';
  for (let i = 0; i < CODE_LEN; i += 1) {
    raw += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return {
    raw,
    display: `${raw.slice(0, 4)}-${raw.slice(4)}`
  };
}

function normalizeCode(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function hashCode(raw) {
  return crypto.createHmac('sha256', pepper()).update(normalizeCode(raw)).digest('hex');
}

function codesMatch(input, storedHash) {
  if (!storedHash || typeof storedHash !== 'string') return false;
  const a = Buffer.from(hashCode(input), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function isValidEmail(value) {
  if (typeof value !== 'string') return false;
  const email = value.trim().toLowerCase();
  if (email.length < 6 || email.length > 190) return false;
  return /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/i.test(email);
}

module.exports = {
  generateCode,
  normalizeCode,
  hashCode,
  codesMatch,
  isValidEmail,
  EXPIRY_MINUTES,
  CODE_LEN
};
