const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const SHA512_HEX_REGEX = /^[a-f0-9]{128}$/i;

function isValidClientHash(value) {
  return typeof value === 'string' && SHA512_HEX_REGEX.test(value);
}

function hashClientPassword(plain) {
  return crypto.createHash('sha512').update(String(plain)).digest('hex');
}

function hashForStorage(clientHash) {
  if (!isValidClientHash(clientHash)) {
    throw new Error('Hash de contraseña con formato inválido');
  }
  return bcrypt.hashSync(clientHash, 10);
}

function compareClientHash(clientHash, storedHash) {
  if (!isValidClientHash(clientHash) || typeof storedHash !== 'string') return false;
  try {
    return bcrypt.compareSync(clientHash, storedHash);
  } catch (_) {
    return false;
  }
}

function hashTemporalParaAlmacenar(passwordPlana) {
  return hashForStorage(hashClientPassword(passwordPlana));
}

module.exports = {
  isValidClientHash,
  hashClientPassword,
  hashForStorage,
  compareClientHash,
  hashTemporalParaAlmacenar
};
