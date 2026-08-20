const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const db = require('./db-mysql');
const logger = require('./logger');
const storage = require('./storage');

const JOB_KEY = 'respaldo_dia';

function hoyIso() {
  const n = new Date();
  const m = String(n.getMonth() + 1).padStart(2, '0');
  const d = String(n.getDate()).padStart(2, '0');
  return `${n.getFullYear()}-${m}-${d}`;
}

function keepDays() {
  const n = parseInt(process.env.BACKUP_KEEP_DAYS, 10);
  return Number.isFinite(n) && n > 0 ? n : 14;
}

function findMysqldump() {
  const candidates = [
    process.env.MYSQLDUMP_PATH,
    'C:\\xampp\\mysql\\bin\\mysqldump.exe',
    '/usr/bin/mysqldump',
    '/usr/local/bin/mysqldump'
  ].filter(Boolean);
  const found = candidates.find((p) => fs.existsSync(p));
  return found || 'mysqldump';
}

function volcarMysql(destFile) {
  const bin = findMysqldump();
  const args = [
    `-h${process.env.DB_HOST || 'localhost'}`,
    `-P${process.env.DB_PORT || 3306}`,
    `-u${process.env.DB_USER || 'root'}`,
    '--single-transaction',
    '--default-character-set=utf8mb4',
    process.env.DB_NAME || 'innar_gestion'
  ];
  if (process.env.DB_PASSWORD) args.splice(3, 0, `-p${process.env.DB_PASSWORD}`);
  const out = spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 80 * 1024 * 1024 });
  if (out.error || out.status !== 0) {
    return { ok: false, error: String(out.error?.message || out.stderr || 'mysqldump falló').slice(0, 220) };
  }
  fs.writeFileSync(destFile, out.stdout);
  return { ok: true };
}

function podarRespaldos() {
  const root = storage.backupsRoot();
  if (!fs.existsSync(root)) return 0;
  const dirs = fs.readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(d.name))
    .map((d) => d.name)
    .sort();
  const extra = dirs.length - keepDays();
  if (extra <= 0) return 0;
  dirs.slice(0, extra).forEach((name) => {
    fs.rmSync(path.join(root, name), { recursive: true, force: true });
  });
  return extra;
}

async function auditarArchivos() {
  const faltan = [];
  try {
    const docs = await db.query('SELECT id, archivo_path, archivo_nombre FROM documentos');
    docs.forEach((row) => {
      if (!storage.existeArchivo(row.archivo_path)) {
        faltan.push({ tipo: 'documento', id: row.id, nombre: row.archivo_nombre });
      }
    });
    const fotos = await db.query(
      'SELECT id, foto_path FROM funcionarios WHERE foto_path IS NOT NULL AND foto_path <> \'\''
    );
    fotos.forEach((row) => {
      if (!storage.existeArchivo(row.foto_path)) {
        faltan.push({ tipo: 'foto', id: row.id, nombre: `foto ${row.id}` });
      }
    });
  } catch (err) {
    logger.error('[RESPALDO] No se pudo auditar archivos', { message: err.message });
  }
  return faltan;
}

async function yaHechoHoy() {
  const row = await db.queryOne('SELECT valor FROM jobs_estado WHERE clave = ?', [JOB_KEY]);
  return row?.valor === hoyIso();
}

async function marcarHechoHoy() {
  await db.execute(
    `INSERT INTO jobs_estado (clave, valor) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE valor = VALUES(valor)`,
    [JOB_KEY, hoyIso()]
  );
}

async function hacerRespaldoCompleto({ forzar = false } = {}) {
  storage.ensureDirs();
  const dia = hoyIso();
  const dest = path.join(storage.backupsRoot(), dia);
  if (!forzar && fs.existsSync(dest) && await yaHechoHoy()) {
    return { ok: true, skipped: true, dest };
  }

  fs.mkdirSync(dest, { recursive: true });
  const destUploads = path.join(dest, 'uploads');
  fs.cpSync(storage.uploadsRoot(), destUploads, { recursive: true, force: true });

  const dump = volcarMysql(path.join(dest, 'mysql.sql'));
  const podados = podarRespaldos();
  const faltan = await auditarArchivos();
  await marcarHechoHoy();

  logger.info('[RESPALDO] Copia diaria lista', {
    dest,
    mysql: dump.ok,
    podados,
    archivos_faltantes: faltan.length
  });
  if (!dump.ok) {
    logger.error('[RESPALDO] mysqldump no se pudo ejecutar', { error: dump.error });
  }
  if (faltan.length) {
    logger.error('[RESPALDO] Hay registros sin archivo en disco', { n: faltan.length });
  }
  return { ok: true, dest, dump: dump.ok, faltan: faltan.length, dumpError: dump.error || null };
}

function iniciarRespaldo() {
  const delay = Number(process.env.BACKUP_DELAY_MS || 20000);
  const every = Number(process.env.BACKUP_INTERVAL_MS || 24 * 60 * 60 * 1000);
  setTimeout(() => {
    hacerRespaldoCompleto().catch((err) => {
      logger.error('[RESPALDO] Falló el respaldo inicial', { message: err.message });
    });
  }, delay);
  setInterval(() => {
    hacerRespaldoCompleto().catch((err) => {
      logger.error('[RESPALDO] Falló el respaldo programado', { message: err.message });
    });
  }, every);
}

module.exports = { hacerRespaldoCompleto, iniciarRespaldo, auditarArchivos };
