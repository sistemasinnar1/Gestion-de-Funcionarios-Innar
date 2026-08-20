const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const router = express.Router();
const db = require('../utils/db-mysql');
const storage = require('../utils/storage');
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

storage.ensureDirs();

router.get('/health/archivos', requireAuth, (_req, res) => {
  const docs = storage.documentosDir();
  const fotos = storage.fotosDir();
  const listar = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n !== '.' && n !== '..').length : 0);
  res.json({
    cwd: process.cwd(),
    app_root: storage.ROOT,
    uploads: storage.uploadsRoot(),
    backups: storage.backupsRoot(),
    upload_dir_env: process.env.UPLOAD_DIR || null,
    backup_dir_env: process.env.BACKUP_DIR || null,
    documentos_existe: fs.existsSync(docs),
    fotos_existe: fs.existsSync(fotos),
    n_documentos: listar(docs),
    n_fotos: listar(fotos)
  });
});

const ALLOWED_EXT = /\.(pdf|jpe?g|png)$/i;
const ALLOWED_MIME = new Set(['application/pdf', 'image/jpeg', 'image/png']);
const FOTO_EXT = /\.(jpe?g|png|webp)$/i;
const FOTO_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, storage.documentosDir()),
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

const uploadFoto = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, storage.fotosDir()),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase() || '.jpg';
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
    }
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = FOTO_MIME.has(file.mimetype) || FOTO_EXT.test(file.originalname || '');
    if (!ok) return cb(new Error('La foto debe ser JPG, PNG o WEBP'));
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
  if (n.endsWith('.webp')) return 'image/webp';
  return 'application/octet-stream';
}

function parseId(value) {
  const id = parseInt(value, 10);
  return id > 0 ? id : 0;
}

async function reemplazarPrevios(funcionarioId, tipo, keepId) {
  const previos = await db.query(
    'SELECT id, archivo_path FROM documentos WHERE funcionario_id = ? AND tipo = ? AND id <> ?',
    [funcionarioId, tipo, keepId]
  );
  if (!previos.length) return;
  await db.execute(
    'DELETE FROM documentos WHERE funcionario_id = ? AND tipo = ? AND id <> ?',
    [funcionarioId, tipo, keepId]
  );
  previos.forEach((row) => storage.borrarArchivo(row.archivo_path));
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
  const tieneFoto = Boolean(row.foto_path);
  const { foto_path: _omit, ...rest } = row;
  return {
    ...rest,
    tipo_label: TIPOS_PERSONA[row.tipo_persona]?.label || row.tipo_persona,
    forma_label: FORMAS_VINCULACION[row.forma_vinculacion] || row.forma_vinculacion,
    tiene_foto: tieneFoto,
    foto_url: tieneFoto ? `/api/funcionarios/${row.id}/foto` : null
  };
}

async function documentosDe(id) {
  return db.query(
    `SELECT d.id, d.tipo, d.archivo_nombre, d.archivo_path, d.fecha_documento, d.fecha_vencimiento, d.creado_en,
            u.nombre AS subido_por_nombre
     FROM documentos d
     LEFT JOIN usuarios u ON u.id = d.subido_por
     WHERE d.funcionario_id = ?
     ORDER BY d.id DESC`,
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
    const soloInactivos = String(req.query.activo || '') === '0';
    let where = soloInactivos ? 'WHERE f.activo = 0' : 'WHERE f.activo = 1';
    if (q) {
      const like = `%${q}%`;
      where += ` AND (f.nombres LIKE ? OR f.apellidos LIKE ? OR f.documento LIKE ? OR f.cargo LIKE ?
        OR f.area LIKE ? OR f.correo LIKE ? OR f.telefono LIKE ?)`;
      params.push(like, like, like, like, like, like, like);
    }
    const rows = await db.query(
      `SELECT f.id, f.nombres, f.apellidos, f.documento, f.cargo, f.area,
              f.telefono, f.correo, f.fecha_nacimiento, f.tipo_persona, f.forma_vinculacion,
              f.foto_path, f.activo
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
       WHERE id = ?`,
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

router.patch('/funcionarios/:id/estado', requireAuth, async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Colaborador inválido' });
  const activo = Number(req.body?.activo) === 1 ? 1 : 0;
  try {
    const result = await db.execute(
      'UPDATE funcionarios SET activo = ? WHERE id = ?',
      [activo, id]
    );
    if (!result.affectedRows) return res.status(404).json({ error: 'Colaborador no encontrado' });
    res.json({ ok: true, id, activo });
  } catch (e) {
    res.status(500).json({ error: safeError(e) });
  }
});

router.delete('/funcionarios/:id', requireAuth, async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Colaborador inválido' });
  try {
    const row = await db.queryOne(
      'SELECT id, foto_path FROM funcionarios WHERE id = ?',
      [id]
    );
    if (!row) return res.status(404).json({ error: 'Colaborador no encontrado' });
    const docs = await db.query(
      'SELECT archivo_path FROM documentos WHERE funcionario_id = ?',
      [id]
    );
    docs.forEach((d) => storage.borrarArchivo(d.archivo_path));
    if (row.foto_path) storage.borrarArchivo(row.foto_path);
    await db.execute('DELETE FROM funcionarios WHERE id = ?', [id]);
    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ error: safeError(e) });
  }
});

router.post('/funcionarios/:id/foto', requireAuth, (req, res) => {
  uploadFoto.single('foto')(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ error: err.message || 'No se pudo subir la foto' });
    }
    if (!req.file) return res.status(400).json({ error: 'Adjunta una foto' });
    const id = parseId(req.params.id);
    if (!id) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'Colaborador inválido' });
    }
    try {
      const row = await db.queryOne(
        'SELECT id, foto_path FROM funcionarios WHERE id = ? AND activo = 1',
        [id]
      );
      if (!row) {
        fs.unlink(req.file.path, () => {});
        return res.status(404).json({ error: 'Colaborador no encontrado' });
      }
      const rel = storage.rutaRelativa(req.file.path);
      storage.copiarAEspejo(rel);
      await db.execute('UPDATE funcionarios SET foto_path = ? WHERE id = ?', [rel, id]);
      if (row.foto_path && row.foto_path !== rel) {
        storage.borrarArchivo(row.foto_path);
      }
      res.json({ ok: true, foto_url: `/api/funcionarios/${id}/foto` });
    } catch (e) {
      fs.unlink(req.file.path, () => {});
      res.status(500).json({ error: safeError(e) });
    }
  });
});

router.get('/funcionarios/:id/foto', requireAuth, async (req, res) => {
  const id = parseId(req.params.id);
  try {
    const row = await db.queryOne(
      'SELECT foto_path FROM funcionarios WHERE id = ?',
      [id]
    );
    if (!row?.foto_path) return res.status(404).json({ error: 'Sin foto' });
    const abs = storage.resolverLectura(row.foto_path);
    if (!abs) return res.status(404).json({ error: 'La foto ya no está en el servidor' });
    res.setHeader('Content-Type', mimeFor(row.foto_path));
    res.setHeader('Cache-Control', 'private, max-age=3600');
    fs.createReadStream(abs).pipe(res);
  } catch (e) {
    res.status(500).json({ error: safeError(e) });
  }
});

router.get('/funcionarios/:id', requireAuth, async (req, res) => {
  const id = parseId(req.params.id);
  try {
    const funcionario = await db.queryOne(
      `SELECT id, nombres, apellidos, documento, cargo, area, telefono, correo,
              fecha_nacimiento, tipo_persona, forma_vinculacion, foto_path, activo
       FROM funcionarios WHERE id = ?`,
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
        'SELECT id, tipo_persona, fecha_nacimiento, activo FROM funcionarios WHERE id = ? AND activo = 1',
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

      const rel = storage.rutaRelativa(req.file.path);
      storage.copiarAEspejo(rel);
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
      if (!def.multiple) {
        await reemplazarPrevios(id, tipo, result.insertId);
      }
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
    const abs = storage.resolverLectura(row.archivo_path);
    if (!abs) return res.status(404).json({ error: 'El archivo ya no está en el servidor' });
    res.setHeader('Content-Type', mimeFor(row.archivo_nombre));
    res.setHeader('Content-Disposition', `inline; filename="${row.archivo_nombre.replace(/"/g, '')}"`);
    fs.createReadStream(abs).pipe(res);
  } catch (e) {
    res.status(500).json({ error: safeError(e) });
  }
});

module.exports = router;
