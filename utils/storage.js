const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function resolveDir(envKey, fallback) {
  const raw = String(process.env[envKey] || fallback).trim() || fallback;
  return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(ROOT, raw);
}

function uploadsRoot() {
  return resolveDir('UPLOAD_DIR', 'uploads');
}

function backupsRoot() {
  return resolveDir('BACKUP_DIR', 'backups');
}

function documentosDir() {
  return path.join(uploadsRoot(), 'documentos');
}

function fotosDir() {
  return path.join(uploadsRoot(), 'fotos');
}

function espejoRoot() {
  return path.join(backupsRoot(), 'espejo');
}

function ensureDirs() {
  fs.mkdirSync(documentosDir(), { recursive: true });
  fs.mkdirSync(fotosDir(), { recursive: true });
  fs.mkdirSync(path.join(espejoRoot(), 'documentos'), { recursive: true });
  fs.mkdirSync(path.join(espejoRoot(), 'fotos'), { recursive: true });
}

function dentroDe(root, abs) {
  const extra = path.relative(path.resolve(root), path.resolve(abs));
  return Boolean(extra) && !extra.startsWith('..') && !path.isAbsolute(extra);
}

function claveRelativa(stored) {
  return String(stored || '')
    .replace(/\\/g, '/')
    .replace(/^uploads\//, '')
    .replace(/^\.?\//, '');
}

function absArchivo(stored) {
  const key = claveRelativa(stored);
  if (!key) return '';
  if (path.isAbsolute(String(stored))) return path.resolve(stored);
  return path.join(uploadsRoot(), key);
}

function absEspejo(stored) {
  const key = claveRelativa(stored);
  if (!key) return '';
  return path.join(espejoRoot(), key);
}

function rutaRelativa(absPath) {
  const extra = path.relative(uploadsRoot(), absPath).replace(/\\/g, '/');
  return extra;
}

function copiarAEspejo(stored) {
  const src = absArchivo(stored);
  const dest = absEspejo(stored);
  if (!src || !dest || !fs.existsSync(src)) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function restaurarDesdeEspejo(stored) {
  const dest = absArchivo(stored);
  const src = absEspejo(stored);
  if (!dest || !src || fs.existsSync(dest) || !fs.existsSync(src)) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  return true;
}

function resolverLectura(stored) {
  const abs = absArchivo(stored);
  if (abs && fs.existsSync(abs)) return abs;
  if (restaurarDesdeEspejo(stored)) return absArchivo(stored);
  return '';
}

function borrarArchivo(stored) {
  [absArchivo(stored), absEspejo(stored)].forEach((abs) => {
    if (!abs) return;
    const permitido = dentroDe(uploadsRoot(), abs) || dentroDe(espejoRoot(), abs);
    if (!permitido) return;
    fs.unlink(abs, () => {});
  });
}

function existeArchivo(stored) {
  const abs = absArchivo(stored);
  if (abs && fs.existsSync(abs)) return true;
  const espejo = absEspejo(stored);
  return Boolean(espejo && fs.existsSync(espejo));
}

module.exports = {
  ROOT,
  uploadsRoot,
  backupsRoot,
  documentosDir,
  fotosDir,
  espejoRoot,
  ensureDirs,
  absArchivo,
  rutaRelativa,
  copiarAEspejo,
  resolverLectura,
  borrarArchivo,
  existeArchivo
};
