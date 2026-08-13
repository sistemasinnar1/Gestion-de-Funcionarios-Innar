const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const router = express.Router();
const db = require('../utils/db-mysql');
const { requireAuth, safeError } = require('../middleware');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'hojas-vida');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
      const safe = String(file.originalname || 'hoja-vida.pdf').replace(/[^\w.\-áéíóúñÁÉÍÓÚÑ ]+/g, '_');
      cb(null, `${Date.now()}-${safe.slice(-80)}`);
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = file.mimetype === 'application/pdf' || /\.pdf$/i.test(file.originalname || '');
    if (!ok) return cb(new Error('Solo se permiten archivos PDF'));
    cb(null, true);
  }
});

function clean(value, max) {
  return String(value || '').trim().slice(0, max);
}

router.get('/funcionarios', requireAuth, async (req, res) => {
  const q = clean(req.query.q, 80);
  try {
    const params = [];
    let where = 'WHERE f.activo = 1';
    if (q) {
      const like = `%${q}%`;
      where += ` AND (f.nombres LIKE ? OR f.apellidos LIKE ? OR f.documento LIKE ? OR f.cargo LIKE ? OR f.area LIKE ?)`;
      params.push(like, like, like, like, like);
    }
    const rows = await db.query(
      `SELECT f.id, f.nombres, f.apellidos, f.documento, f.cargo, f.area,
              (SELECT MAX(version) FROM hojas_vida hv WHERE hv.funcionario_id = f.id) AS hv_version,
              (SELECT creado_en FROM hojas_vida hv WHERE hv.funcionario_id = f.id ORDER BY version DESC LIMIT 1) AS hv_fecha,
              (SELECT COUNT(*) FROM hojas_vida hv WHERE hv.funcionario_id = f.id) AS hv_count
       FROM funcionarios f
       ${where}
       ORDER BY f.apellidos, f.nombres`,
      params
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: safeError(e) });
  }
});

router.post('/funcionarios', requireAuth, async (req, res) => {
  const nombres = clean(req.body?.nombres, 120);
  const apellidos = clean(req.body?.apellidos, 120);
  const documento = clean(req.body?.documento, 30);
  const cargo = clean(req.body?.cargo, 120) || null;
  const area = clean(req.body?.area, 120) || null;

  if (!nombres || !apellidos || !documento) {
    return res.status(400).json({ error: 'Nombres, apellidos y documento son obligatorios' });
  }

  try {
    const result = await db.execute(
      'INSERT INTO funcionarios (nombres, apellidos, documento, cargo, area) VALUES (?, ?, ?, ?, ?)',
      [nombres, apellidos, documento, cargo, area]
    );
    res.json({ ok: true, id: result.insertId });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'Ya existe un funcionario con ese documento' });
    }
    res.status(500).json({ error: safeError(e) });
  }
});

router.post('/funcionarios/:id/hoja-vida', requireAuth, (req, res) => {
  upload.single('archivo')(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ error: err.message || 'No se pudo subir el archivo' });
    }
    if (!req.file) return res.status(400).json({ error: 'Adjunta un PDF' });

    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Funcionario inválido' });

    try {
      const funcionario = await db.queryOne('SELECT id FROM funcionarios WHERE id = ? AND activo = 1', [id]);
      if (!funcionario) {
        fs.unlink(req.file.path, () => {});
        return res.status(404).json({ error: 'Funcionario no encontrado' });
      }
      const last = await db.queryOne(
        'SELECT MAX(version) AS version FROM hojas_vida WHERE funcionario_id = ?',
        [id]
      );
      const version = Number(last?.version || 0) + 1;
      const rel = path.relative(path.join(__dirname, '..'), req.file.path).replace(/\\/g, '/');
      await db.execute(
        `INSERT INTO hojas_vida (funcionario_id, version, archivo_nombre, archivo_path, subido_por)
         VALUES (?, ?, ?, ?, ?)`,
        [id, version, req.file.originalname, rel, req.session.usuarioId]
      );
      res.json({ ok: true, version });
    } catch (e) {
      fs.unlink(req.file.path, () => {});
      res.status(500).json({ error: safeError(e) });
    }
  });
});

router.get('/funcionarios/:id', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const funcionario = await db.queryOne(
      'SELECT id, nombres, apellidos, documento, cargo, area FROM funcionarios WHERE id = ? AND activo = 1',
      [id]
    );
    if (!funcionario) return res.status(404).json({ error: 'Funcionario no encontrado' });
    const documentos = await db.query(
      `SELECT id, version, archivo_nombre, creado_en
       FROM hojas_vida
       WHERE funcionario_id = ?
       ORDER BY version DESC`,
      [id]
    );
    res.json({
      funcionario,
      documentos: documentos.map((d) => ({
        id: d.id,
        tipo: 'Hoja de vida',
        version: d.version,
        nombre: d.archivo_nombre,
        fecha: d.creado_en
      }))
    });
  } catch (e) {
    res.status(500).json({ error: safeError(e) });
  }
});

router.get('/funcionarios/:id/hoja-vida/:docId', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const docId = parseInt(req.params.docId, 10);
  try {
    const row = await db.queryOne(
      `SELECT archivo_path, archivo_nombre
       FROM hojas_vida
       WHERE id = ? AND funcionario_id = ?`,
      [docId, id]
    );
    if (!row) return res.status(404).json({ error: 'Documento no encontrado' });
    const abs = path.join(__dirname, '..', row.archivo_path);
    if (!fs.existsSync(abs)) return res.status(404).json({ error: 'El archivo ya no está en el servidor' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${row.archivo_nombre.replace(/"/g, '')}"`);
    fs.createReadStream(abs).pipe(res);
  } catch (e) {
    res.status(500).json({ error: safeError(e) });
  }
});

router.get('/funcionarios/:id/hoja-vida', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const row = await db.queryOne(
      `SELECT archivo_path, archivo_nombre
       FROM hojas_vida
       WHERE funcionario_id = ?
       ORDER BY version DESC
       LIMIT 1`,
      [id]
    );
    if (!row) return res.status(404).json({ error: 'Este funcionario aún no tiene hoja de vida' });
    const abs = path.join(__dirname, '..', row.archivo_path);
    if (!fs.existsSync(abs)) return res.status(404).json({ error: 'El archivo ya no está en el servidor' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${row.archivo_nombre.replace(/"/g, '')}"`);
    fs.createReadStream(abs).pipe(res);
  } catch (e) {
    res.status(500).json({ error: safeError(e) });
  }
});

module.exports = router;
