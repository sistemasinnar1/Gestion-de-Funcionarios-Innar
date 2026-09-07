const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const { spawnSync } = require('child_process');
const db = require('./db-mysql');
const logger = require('./logger');
const mailer = require('./mailer');
const storage = require('./storage');

const JOB_KEY = 'respaldo_mes';

function hoyIso() {
  const n = new Date();
  const m = String(n.getMonth() + 1).padStart(2, '0');
  const d = String(n.getDate()).padStart(2, '0');
  return `${n.getFullYear()}-${m}-${d}`;
}

function mesIso(date = new Date()) {
  const m = String(date.getMonth() + 1).padStart(2, '0');
  return `${date.getFullYear()}-${m}`;
}

function keepMonths() {
  const n = parseInt(process.env.BACKUP_KEEP_MONTHS, 10);
  return Number.isFinite(n) && n > 0 ? n : 12;
}

function mensualRoot() {
  return path.join(storage.backupsRoot(), 'mensual');
}

function recienteDir() {
  return path.join(storage.backupsRoot(), 'reciente');
}

function mirrorRoot() {
  const raw = String(process.env.BACKUP_MIRROR_DIR || '').trim();
  return raw ? path.resolve(raw) : '';
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

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(1024 * 1024);
  try {
    let n = 0;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function verificarDumpSql(filePath) {
  if (!fs.existsSync(filePath)) return { ok: false, error: 'No se generó mysql.sql' };
  const stat = fs.statSync(filePath);
  if (stat.size < 400) return { ok: false, error: 'El volcado de MySQL está vacío' };
  const fd = fs.openSync(filePath, 'r');
  try {
    const head = Buffer.alloc(Math.min(4096, stat.size));
    fs.readSync(fd, head, 0, head.length, 0);
    const texto = head.toString('utf8');
    if (!/CREATE TABLE/i.test(texto) && !/INSERT INTO/i.test(texto)) {
      return { ok: false, error: 'El volcado no parece un SQL de MySQL' };
    }
  } finally {
    fs.closeSync(fd);
  }
  return { ok: true, bytes: stat.size };
}

function volcarMysql(destFile) {
  const bin = findMysqldump();
  const args = [
    `-h${process.env.DB_HOST || 'localhost'}`,
    `-P${process.env.DB_PORT || 3306}`,
    `-u${process.env.DB_USER || 'root'}`,
    '--single-transaction',
    '--routines',
    '--triggers',
    '--default-character-set=utf8mb4',
    process.env.DB_NAME || 'innar_gestion'
  ];
  if (process.env.DB_PASSWORD) args.splice(3, 0, `-p${process.env.DB_PASSWORD}`);

  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  const outFd = fs.openSync(destFile, 'w');
  try {
    const out = spawnSync(bin, args, {
      encoding: 'utf8',
      stdio: ['ignore', outFd, 'pipe'],
      maxBuffer: 8 * 1024 * 1024
    });
    if (out.error || out.status !== 0) {
      return { ok: false, error: String(out.error?.message || out.stderr || 'mysqldump falló').slice(0, 220) };
    }
  } finally {
    fs.closeSync(outFd);
  }
  return verificarDumpSql(destFile);
}

async function gzipFile(src, dest) {
  await pipeline(
    fs.createReadStream(src),
    zlib.createGzip({ level: 9 }),
    fs.createWriteStream(dest)
  );
}

function contarArbol(dir) {
  let archivos = 0;
  let bytes = 0;
  if (!fs.existsSync(dir)) return { archivos, bytes };
  const walk = (current) => {
    fs.readdirSync(current, { withFileTypes: true }).forEach((entry) => {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        return;
      }
      if (!entry.isFile()) return;
      archivos += 1;
      try {
        bytes += fs.statSync(full).size;
      } catch (_) { /* ignore */ }
    });
  };
  walk(dir);
  return { archivos, bytes };
}

function copiarUploads(destUploads) {
  if (fs.existsSync(destUploads)) fs.rmSync(destUploads, { recursive: true, force: true });
  fs.cpSync(storage.uploadsRoot(), destUploads, { recursive: true, force: true });
  return contarArbol(destUploads);
}

function podarMensuales() {
  const root = mensualRoot();
  if (!fs.existsSync(root)) return 0;
  const dirs = fs.readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d{4}-\d{2}$/.test(d.name))
    .map((d) => d.name)
    .sort();
  const extra = dirs.length - keepMonths();
  if (extra <= 0) return 0;
  dirs.slice(0, extra).forEach((name) => {
    fs.rmSync(path.join(root, name), { recursive: true, force: true });
  });
  return extra;
}

function podarDiariosAntiguos() {
  const root = storage.backupsRoot();
  if (!fs.existsSync(root)) return 0;
  let n = 0;
  fs.readdirSync(root, { withFileTypes: true }).forEach((d) => {
    if (!d.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(d.name)) return;
    fs.rmSync(path.join(root, d.name), { recursive: true, force: true });
    n += 1;
  });
  return n;
}

function copiarAEspejoExterno(origen, mes) {
  const destRoot = mirrorRoot();
  if (!destRoot) return { ok: true, skipped: true };
  const dest = path.join(destRoot, mes);
  fs.mkdirSync(destRoot, { recursive: true });
  if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(origen, dest, { recursive: true, force: true });
  return { ok: true, dest };
}

async function auditarArchivos() {
  const faltan = [];
  const tablas = [
    ['documentos', 'archivo_path', 'archivo_nombre', 'documento'],
    ['cursos_certificados', 'archivo_path', 'archivo_nombre', 'curso'],
    ['documentos_adicionales', 'archivo_path', 'archivo_nombre', 'adicional'],
    ['contratos', 'archivo_path', 'archivo_nombre', 'contrato']
  ];
  try {
    for (const [tabla, colPath, colNombre, tipo] of tablas) {
      try {
        const rows = await db.query(`SELECT id, ${colPath} AS archivo_path, ${colNombre} AS archivo_nombre FROM ${tabla}`);
        rows.forEach((row) => {
          if (!row.archivo_path) return;
          if (!storage.existeArchivo(row.archivo_path)) {
            faltan.push({ tipo, id: row.id, nombre: row.archivo_nombre });
          }
        });
      } catch (_) {
        /* tabla aún no existe en instalaciones viejas */
      }
    }
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

async function yaHechoEsteMes(mes) {
  const row = await db.queryOne('SELECT valor FROM jobs_estado WHERE clave = ?', [JOB_KEY]);
  return row?.valor === mes;
}

async function marcarHechoMes(mes) {
  await db.execute(
    `INSERT INTO jobs_estado (clave, valor) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE valor = VALUES(valor)`,
    [JOB_KEY, mes]
  );
}

async function destinatariosRespaldo() {
  const rows = await db.query(
    `SELECT email FROM usuarios
     WHERE activo = 1 AND email IS NOT NULL AND email <> ''
       AND rol IN ('superadmin', 'admin')`
  );
  const seen = new Set();
  const list = [];
  rows.forEach((r) => {
    const email = String(r.email || '').trim().toLowerCase();
    if (!email.includes('@') || seen.has(email)) return;
    seen.add(email);
    list.push(email);
  });
  const extra = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  if (extra.includes('@') && !seen.has(extra)) list.push(extra);
  return list;
}

async function avisarRespaldo(manifest) {
  if (!mailer.isConfigured()) return;
  const destinos = await destinatariosRespaldo();
  if (!destinos.length) return;
  const ok = Boolean(manifest.ok);
  if (!ok) {
    const row = await db.queryOne('SELECT valor FROM jobs_estado WHERE clave = ?', ['respaldo_aviso_fallo']);
    if (row?.valor === hoyIso()) return;
    await db.execute(
      `INSERT INTO jobs_estado (clave, valor) VALUES ('respaldo_aviso_fallo', ?)
       ON DUPLICATE KEY UPDATE valor = VALUES(valor)`,
      [hoyIso()]
    );
  }
  const subject = ok
    ? `INNAR Gestión — respaldo mensual ${manifest.mes} listo`
    : `INNAR Gestión — falló el respaldo mensual ${manifest.mes}`;
  const text = [
    ok ? 'El respaldo mensual se completó.' : 'El respaldo mensual no quedó completo.',
    `Mes: ${manifest.mes}`,
    `Carpeta: ${manifest.carpeta}`,
    `MySQL: ${manifest.mysql?.ok ? 'OK' : (manifest.mysql?.error || 'falló')}`,
    `Archivos: ${manifest.uploads?.archivos ?? 0} (${Math.round((manifest.uploads?.bytes || 0) / 1024)} KB)`,
    `Registros sin archivo en disco: ${manifest.auditoria_faltantes ?? 0}`,
    manifest.espejo_externo?.dest ? `Copia extra: ${manifest.espejo_externo.dest}` : ''
  ].filter(Boolean).join('\n');
  for (const to of destinos) {
    await mailer.sendMail({ to, subject, text, html: `<pre style="font-family:Segoe UI,sans-serif">${text.replace(/</g, '&lt;')}</pre>` });
  }
}

async function hacerRespaldoCompleto({ forzar = false } = {}) {
  storage.ensureDirs();
  const mes = mesIso();
  if (!forzar && await yaHechoEsteMes(mes)) {
    return { ok: true, skipped: true, mes, dest: path.join(mensualRoot(), mes) };
  }

  const dest = path.join(mensualRoot(), mes);
  fs.mkdirSync(mensualRoot(), { recursive: true });
  if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });

  const sqlPath = path.join(dest, 'mysql.sql');
  const dump = volcarMysql(sqlPath);
  let gzip = { ok: false };
  if (dump.ok) {
    try {
      const gzPath = path.join(dest, 'mysql.sql.gz');
      await gzipFile(sqlPath, gzPath);
      gzip = {
        ok: true,
        archivo: 'mysql.sql.gz',
        bytes: fs.statSync(gzPath).size,
        sha256: sha256File(gzPath)
      };
      fs.unlinkSync(sqlPath);
    } catch (err) {
      gzip = { ok: false, error: err.message };
    }
  }

  let uploads = { archivos: 0, bytes: 0 };
  try {
    uploads = copiarUploads(path.join(dest, 'uploads'));
  } catch (err) {
    logger.error('[RESPALDO] No se pudieron copiar los archivos', { message: err.message });
  }

  const faltan = await auditarArchivos();
  const podadosMes = podarMensuales();
  const podadosDia = podarDiariosAntiguos();

  let espejo = { ok: true, skipped: true };
  try {
    espejo = copiarAEspejoExterno(dest, mes);
  } catch (err) {
    espejo = { ok: false, error: err.message };
  }

  try {
    const rec = recienteDir();
    if (fs.existsSync(rec)) fs.rmSync(rec, { recursive: true, force: true });
    fs.cpSync(dest, rec, { recursive: true, force: true });
  } catch (err) {
    logger.error('[RESPALDO] No se pudo actualizar la copia reciente', { message: err.message });
  }

  const manifest = {
    tipo: 'mensual',
    mes,
    creado_en: new Date().toISOString(),
    ok: Boolean(dump.ok),
    mysql: dump.ok
      ? { ok: true, comprimido: gzip }
      : { ok: false, error: dump.error },
    uploads,
    auditoria_faltantes: faltan.length,
    espejo_externo: espejo,
    carpeta: dest
  };
  fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify(manifest, null, 2));

  if (dump.ok) await marcarHechoMes(mes);

  logger.info('[RESPALDO] Copia mensual', {
    mes,
    dest,
    mysql: dump.ok,
    gzip: gzip.ok,
    archivos: uploads.archivos,
    faltan: faltan.length,
    podados_mensuales: podadosMes,
    podados_diarios: podadosDia
  });
  if (!dump.ok) logger.error('[RESPALDO] mysqldump no se pudo ejecutar', { error: dump.error });
  if (faltan.length) logger.error('[RESPALDO] Hay registros sin archivo en disco', { n: faltan.length });

  try {
    await avisarRespaldo(manifest);
  } catch (err) {
    logger.error('[RESPALDO] No se pudo avisar por correo', { message: err.message });
  }

  return {
    ok: dump.ok,
    skipped: false,
    mes,
    dest,
    dump: dump.ok,
    faltan: faltan.length,
    dumpError: dump.error || gzip.error || null
  };
}

function iniciarRespaldo() {
  const delay = Number(process.env.BACKUP_DELAY_MS || 25000);
  const every = Number(process.env.BACKUP_INTERVAL_MS || 12 * 60 * 60 * 1000);
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
