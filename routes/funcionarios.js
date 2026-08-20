const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const router = express.Router();
const db = require('../utils/db-mysql');
const { requireAuth, safeError } = require('../middleware');
const {
  TIPOS_PERSONA,
  FORMAS_VINCULACION,
  tipoPersonaValido,
  formaVinculacionValida,
  docTipoValido,
  aplicaA,
  DOC_BY_ID,
  armarChecklist,
  progresoDe,
  alertaDe,
  fechasParaAlta,
  fechaIso
} = require('../utils/documentos-catalogo');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'documentos');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_EXT = /\.(pdf|jpe?g|png)$/i;
const ALLOWED_MIME = new Set(['application/pdf', 'image/jpeg', 'image/png']);

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
      const safe = String(file.originalname || 'documento').replace(/[^\w.\-áéíóúñÁÉÍÓÚÑ ]+/g, '_');
      cb(null, `${Date.now()}-${safe.slice(-80)}`);
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = ALLOWED_MIME.has(file.mimetype) || ALLOWED_EXT.test(file.originalname || '');
    if (!ok) return cb(new Error('Solo se permiten PDF, JPG o PNG'));
    cb(null, true);
  }
});

function clean(value, max) {
  return String(value || '').trim().slice(0, max);
}

function mimeFor(name) {
  const n = String(name || '').toLowerCase();
  if (n.endsWith('.pdf')) return 'application/pdf';
  if (n.endsWith('.png')) return 'image/png';
  if (n.endsWith('.jpg') || n.endsWith('.jpeg')) return 'image/jpeg';
  return 'application/octet-stream';
}

function parseId(value) {
  const id = parseInt(value, 10);
  return id > 0 ? id : 0;
}

function camposPersona(body) {
  const nombres = clean(body?.nombres, 120);
  const apellidos = clean(body?.apellidos, 120);
  const documento = clean(body?.documento, 30);
  const cargo = clean(body?.cargo, 120) || null;
  const area = clean(body?.area, 120) || null;
  const telefono = clean(body?.telefono, 30);
  const correo = clean(body?.correo, 190).toLowerCase();
  const tipo_persona = clean(body?.tipo_persona, 32);
  const forma_vinculacion = clean(body?.forma_vinculacion, 40);
  const fecha_nacimiento = fechaIso(body?.fecha_nacimiento);

  if (!nombres || !apellidos || !documento) {
    return { error: 'Nombres, apellidos y documento son obligatorios' };
  }
  if (!telefono || !correo) {
    return { error: 'Teléfono y correo son obligatorios' };
  }
  if (!tipoPersonaValido(tipo_persona)) {
    return { error: 'Indica si la persona es asistencial o administrativa' };
  }
  if (!formaVinculacionValida(forma_vinculacion)) {
    return { error: 'Selecciona la forma de vinculación' };
  }
  if (correo && !correo.includes('@')) {
    return { error: 'El correo no es válido' };
  }

  return {
    nombres,
    apellidos,
    documento,
    cargo,
    area,
    telefono,
    correo,
    tipo_persona,
    forma_vinculacion,
    fecha_nacimiento
  };
}

function presentarFuncionario(row) {
  return {
    ...row,
    tipo_label: TIPOS_PERSONA[row.tipo_persona]?.label || row.tipo_persona,
    forma_label: FORMAS_VINCULACION[row.forma_vinculacion] || row.forma_vinculacion
  };
}

async function documentosDe(id) {
  return db.query(
    `SELECT id, tipo, archivo_nombre, archivo_path, fecha_documento, fecha_vencimiento, creado_en
     FROM documentos
     WHERE funcionario_id = ?
     ORDER BY id DESC`,
    [id]
  );
}

async function resumenPersonas(rows) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const placeholders = ids.map(() => '?').join(',');
  const docs = await db.query(
    `SELECT funcionario_id, tipo, fecha_vencimiento, id
     FROM documentos
     WHERE funcionario_id IN (${placeholders})
     ORDER BY id DESC`,
    ids
  );
  const byPerson = {};
  docs.forEach((d) => {
    if (!byPerson[d.funcionario_id]) byPerson[d.funcionario_id] = [];
    byPerson[d.funcionario_id].push(d);
  });
  return rows.map((row) => {
    const checklist = armarChecklist(row.tipo_persona, byPerson[row.id] || []);
    const progreso = progresoDe(checklist);
    return {
      ...presentarFuncionario(row),
      progreso,
      alerta: alertaDe(progreso)
    };
  });
}

router.get('/funcionarios', requireAuth, async (req, res) => {
  const q = clean(req.query.q, 80);
  try {
    const params = [];
    let where = 'WHERE f.activo = 1';
    if (q) {
      const like = `%${q}%`;
      where += ` AND (f.nombres LIKE ? OR f.apellidos LIKE ? OR f.documento LIKE ? OR f.cargo LIKE ?
        OR f.area LIKE ? OR f.correo LIKE ? OR f.telefono LIKE ?)`;
      params.push(like, like, like, like, like, like, like);
    }
    const rows = await db.query(
      `SELECT f.id, f.nombres, f.apellidos, f.documento, f.cargo, f.area,
              f.telefono, f.correo, f.fecha_nacimiento, f.tipo_persona, f.forma_vinculacion
       FROM funcionarios f
       ${where}
       ORDER BY f.apellidos, f.nombres`,
      params
    );
    res.json(await resumenPersonas(rows));
  } catch (e) {
    res.status(500).json({ error: safeError(e) });
  }
});

router.post('/funcionarios', requireAuth, async (req, res) => {
  const campos = camposPersona(req.body);
  if (campos.error) return res.status(400).json({ error: campos.error });

  try {
    const result = await db.execute(
      `INSERT INTO funcionarios
        (nombres, apellidos, documento, cargo, area, telefono, correo, fecha_nacimiento, tipo_persona, forma_vinculacion)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        campos.nombres,
        campos.apellidos,
        campos.documento,
        campos.cargo,
        campos.area,
        campos.telefono,
        campos.correo,
        campos.fecha_nacimiento,
        campos.tipo_persona,
        campos.forma_vinculacion
      ]
    );
    res.json({ ok: true, id: result.insertId });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'Ya existe un colaborador con ese documento' });
    }
    res.status(500).json({ error: safeError(e) });
  }
});

router.patch('/funcionarios/:id', requireAuth, async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Colaborador inválido' });
  const campos = camposPersona(req.body);
  if (campos.error) return res.status(400).json({ error: campos.error });

  try {
    const result = await db.execute(
      `UPDATE funcionarios
       SET nombres = ?, apellidos = ?, documento = ?, cargo = ?, area = ?,
           telefono = ?, correo = ?, fecha_nacimiento = COALESCE(?, fecha_nacimiento),
           tipo_persona = ?, forma_vinculacion = ?
       WHERE id = ? AND activo = 1`,
      [
        campos.nombres,
        campos.apellidos,
        campos.documento,
        campos.cargo,
        campos.area,
        campos.telefono,
        campos.correo,
        campos.fecha_nacimiento,
        campos.tipo_persona,
        campos.forma_vinculacion,
        id
      ]
    );
    if (!result.affectedRows) return res.status(404).json({ error: 'Colaborador no encontrado' });
    res.json({ ok: true, id });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'Ya existe un colaborador con ese documento' });
    }
    res.status(500).json({ error: safeError(e) });
  }
});

router.get('/funcionarios/:id', requireAuth, async (req, res) => {
  const id = parseId(req.params.id);
  try {
    const funcionario = await db.queryOne(
      `SELECT id, nombres, apellidos, documento, cargo, area, telefono, correo,
              fecha_nacimiento, tipo_persona, forma_vinculacion
       FROM funcionarios WHERE id = ? AND activo = 1`,
      [id]
    );
    if (!funcionario) return res.status(404).json({ error: 'Colaborador no encontrado' });
    const docs = await documentosDe(id);
    const requisitos = armarChecklist(funcionario.tipo_persona, docs);
    res.json({
      funcionario: presentarFuncionario(funcionario),
      requisitos,
      progreso: progresoDe(requisitos)
    });
  } catch (e) {
    res.status(500).json({ error: safeError(e) });
  }
});

router.post('/funcionarios/:id/documentos', requireAuth, (req, res) => {
  upload.single('archivo')(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ error: err.message || 'No se pudo subir el archivo' });
    }
    if (!req.file) return res.status(400).json({ error: 'Adjunta un PDF, JPG o PNG' });

    const id = parseId(req.params.id);
    const tipo = clean(req.body?.tipo, 64);
    if (!id) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'Colaborador inválido' });
    }
    if (!docTipoValido(tipo)) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'Tipo de documento inválido' });
    }

    try {
      const funcionario = await db.queryOne(
        'SELECT id, tipo_persona, fecha_nacimiento FROM funcionarios WHERE id = ? AND activo = 1',
        [id]
      );
      if (!funcionario) {
        fs.unlink(req.file.path, () => {});
        return res.status(404).json({ error: 'Colaborador no encontrado' });
      }
      const def = DOC_BY_ID[tipo];
      if (!aplicaA(def, funcionario.tipo_persona)) {
        fs.unlink(req.file.path, () => {});
        return res.status(400).json({ error: 'Ese documento no aplica para este tipo de persona' });
      }

      const fechas = fechasParaAlta(tipo, req.body || {});
      if (fechas.error) {
        fs.unlink(req.file.path, () => {});
        return res.status(400).json({ error: fechas.error });
      }

      if (def.pideFechaNacimiento) {
        const nacimiento = fechaIso(req.body?.fecha_nacimiento) || funcionario.fecha_nacimiento;
        if (!nacimiento) {
          fs.unlink(req.file.path, () => {});
          return res.status(400).json({ error: 'Al cargar la cédula indica la fecha de nacimiento' });
        }
        await db.execute('UPDATE funcionarios SET fecha_nacimiento = ? WHERE id = ?', [nacimiento, id]);
      }

      const rel = path.relative(path.join(__dirname, '..'), req.file.path).replace(/\\/g, '/');
      const result = await db.execute(
        `INSERT INTO documentos
          (funcionario_id, tipo, archivo_nombre, archivo_path, fecha_documento, fecha_vencimiento, subido_por)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          tipo,
          req.file.originalname,
          rel,
          fechas.fecha_documento,
          fechas.fecha_vencimiento,
          req.session.usuarioId
        ]
      );
      res.json({ ok: true, id: result.insertId, fecha_vencimiento: fechas.fecha_vencimiento });
    } catch (e) {
      fs.unlink(req.file.path, () => {});
      res.status(500).json({ error: safeError(e) });
    }
  });
});

router.get('/funcionarios/:id/documentos/:docId', requireAuth, async (req, res) => {
  const id = parseId(req.params.id);
  const docId = parseId(req.params.docId);
  try {
    const row = await db.queryOne(
      `SELECT archivo_path, archivo_nombre
       FROM documentos
       WHERE id = ? AND funcionario_id = ?`,
      [docId, id]
    );
    if (!row) return res.status(404).json({ error: 'Documento no encontrado' });
    const abs = path.join(__dirname, '..', row.archivo_path);
    if (!fs.existsSync(abs)) return res.status(404).json({ error: 'El archivo ya no está en el servidor' });
    res.setHeader('Content-Type', mimeFor(row.archivo_nombre));
    res.setHeader('Content-Disposition', `inline; filename="${row.archivo_nombre.replace(/"/g, '')}"`);
    fs.createReadStream(abs).pipe(res);
  } catch (e) {
    res.status(500).json({ error: safeError(e) });
  }
});

module.exports = router;
