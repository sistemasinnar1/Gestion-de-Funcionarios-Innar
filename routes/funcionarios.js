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
  RIESGO_ARL,
  tipoPersonaValido,
  formaVinculacionValida,
  riesgoArlValido,
  docTipoValido,
  aplicaA,
  flagsDePersona,
  DOC_BY_ID,
  armarChecklist,
  progresoDe,
  alertaDe,
  fechasParaAlta,
  fechaIso,
  proximoExamenDesde
} = require('../utils/documentos-catalogo');
const { empaquetarPdf } = require('../utils/pdf-pack');

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

function flag01(value) {
  return Number(value) === 1 ? 1 : 0;
}

function hoyIso() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function elegirTerminacion(fechas) {
  if (!fechas.length) return null;
  const hoy = hoyIso();
  const futura = fechas.find((f) => f >= hoy);
  if (futura) return futura;
  return fechas[fechas.length - 1];
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
  const telefono = clean(body?.telefono, 30);
  const correo = clean(body?.correo, 190).toLowerCase();
  const tipo_persona = clean(body?.tipo_persona, 32);
  const forma_vinculacion = clean(body?.forma_vinculacion, 40);
  const fecha_nacimiento = fechaIso(body?.fecha_nacimiento);
  const acudiente_nombre = clean(body?.acudiente_nombre, 180) || null;
  const acudiente_contacto = clean(body?.acudiente_contacto, 80) || null;
  const electrodiagnostico = flag01(body?.electrodiagnostico);
  const exige_telemedicina = flag01(body?.exige_telemedicina);

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

  let area = clean(body?.area, 120);
  if (!area) {
    area = tipo_persona === 'asistencial' ? 'Asistencial' : 'Administrativo';
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
    fecha_nacimiento,
    acudiente_nombre,
    acudiente_contacto,
    electrodiagnostico,
    exige_telemedicina
  };
}

function presentarFuncionario(row) {
  const tieneFoto = Boolean(row.foto_path);
  const { foto_path: _omit, ...rest } = row;
  const riesgoKey = row.riesgo_arl ? String(row.riesgo_arl).toUpperCase() : '';
  return {
    ...rest,
    tipo_label: TIPOS_PERSONA[row.tipo_persona]?.label || row.tipo_persona,
    forma_label: FORMAS_VINCULACION[row.forma_vinculacion] || row.forma_vinculacion,
    riesgo_arl_label: riesgoKey && RIESGO_ARL[riesgoKey] ? RIESGO_ARL[riesgoKey].label : null,
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

async function cursosDe(id) {
  return db.query(
    `SELECT c.id, c.nombre, c.horas, c.fecha_certificacion, c.archivo_nombre, c.archivo_path, c.creado_en,
            u.nombre AS subido_por_nombre
     FROM cursos_certificados c
     LEFT JOIN usuarios u ON u.id = c.subido_por
     WHERE c.funcionario_id = ?
     ORDER BY c.id DESC`,
    [id]
  );
}

async function adicionalesDe(id) {
  return db.query(
    `SELECT a.id, a.descripcion, a.archivo_nombre, a.archivo_path, a.creado_en,
            u.nombre AS subido_por_nombre
     FROM documentos_adicionales a
     LEFT JOIN usuarios u ON u.id = a.subido_por
     WHERE a.funcionario_id = ?
     ORDER BY a.id DESC`,
    [id]
  );
}

async function contratosDe(id) {
  return db.query(
    `SELECT c.id, c.tipo, c.descripcion, c.archivo_nombre, c.archivo_path,
            c.fecha_firma, c.fecha_terminacion, c.creado_en,
            u.nombre AS subido_por_nombre
     FROM contratos c
     LEFT JOIN usuarios u ON u.id = c.subido_por
     WHERE c.funcionario_id = ?
     ORDER BY c.id DESC`,
    [id]
  );
}

async function proximaTerminacionContrato(id) {
  const rows = await db.query(
    `SELECT fecha_terminacion FROM contratos
     WHERE funcionario_id = ? AND fecha_terminacion IS NOT NULL
     ORDER BY fecha_terminacion ASC`,
    [id]
  );
  return elegirTerminacion(rows.map((r) => fechaIso(r.fecha_terminacion)).filter(Boolean));
}

function mapearTerminacionesPorPersona(rows) {
  const byPerson = {};
  rows.forEach((r) => {
    const fecha = fechaIso(r.fecha_terminacion);
    if (!fecha) return;
    if (!byPerson[r.funcionario_id]) byPerson[r.funcionario_id] = [];
    byPerson[r.funcionario_id].push(fecha);
  });
  const result = {};
  Object.keys(byPerson).forEach((fid) => {
    result[fid] = elegirTerminacion(byPerson[fid]);
  });
  return result;
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
  const contratos = await db.query(
    `SELECT funcionario_id, fecha_terminacion
     FROM contratos
     WHERE funcionario_id IN (${placeholders}) AND fecha_terminacion IS NOT NULL
     ORDER BY fecha_terminacion ASC`,
    ids
  );
  const byPerson = {};
  docs.forEach((d) => {
    if (!byPerson[d.funcionario_id]) byPerson[d.funcionario_id] = [];
    byPerson[d.funcionario_id].push(d);
  });
  const terminaciones = mapearTerminacionesPorPersona(contratos);
  return rows.map((row) => {
    const checklist = armarChecklist(row.tipo_persona, byPerson[row.id] || [], row);
    const proxima_terminacion_contrato = terminaciones[row.id] || null;
    const progreso = progresoDe(checklist, {
      proximo_examen_medico: row.proximo_examen_medico || null,
      proxima_terminacion_contrato
    });
    return {
      ...presentarFuncionario(row),
      progreso,
      alerta: alertaDe(progreso)
    };
  });
}

async function servirArchivoRes(res, row, notFoundMsg) {
  if (!row?.archivo_path) return res.status(404).json({ error: notFoundMsg || 'Archivo no encontrado' });
  const abs = storage.resolverLectura(row.archivo_path);
  if (!abs) return res.status(404).json({ error: 'El archivo ya no está en el servidor' });
  const nombre = row.archivo_nombre || path.basename(row.archivo_path);
  res.setHeader('Content-Type', mimeFor(nombre));
  res.setHeader('Content-Disposition', `inline; filename="${String(nombre).replace(/"/g, '')}"`);
  fs.createReadStream(abs).pipe(res);
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
              f.foto_path, f.activo, f.acudiente_nombre, f.acudiente_contacto,
              f.riesgo_arl, f.proximo_examen_medico, f.electrodiagnostico, f.exige_telemedicina
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
        (nombres, apellidos, documento, cargo, area, telefono, correo, fecha_nacimiento,
         tipo_persona, forma_vinculacion, acudiente_nombre, acudiente_contacto,
         electrodiagnostico, exige_telemedicina)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        campos.acudiente_nombre,
        campos.acudiente_contacto,
        campos.electrodiagnostico,
        campos.exige_telemedicina
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
           tipo_persona = ?, forma_vinculacion = ?,
           acudiente_nombre = ?, acudiente_contacto = ?,
           electrodiagnostico = ?, exige_telemedicina = ?
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
        campos.acudiente_nombre,
        campos.acudiente_contacto,
        campos.electrodiagnostico,
        campos.exige_telemedicina,
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
    const cursos = await db.query(
      'SELECT archivo_path FROM cursos_certificados WHERE funcionario_id = ?',
      [id]
    );
    const extras = await db.query(
      'SELECT archivo_path FROM documentos_adicionales WHERE funcionario_id = ?',
      [id]
    );
    const contratos = await db.query(
      'SELECT archivo_path FROM contratos WHERE funcionario_id = ?',
      [id]
    );
    docs.forEach((d) => storage.borrarArchivo(d.archivo_path));
    cursos.forEach((d) => storage.borrarArchivo(d.archivo_path));
    extras.forEach((d) => storage.borrarArchivo(d.archivo_path));
    contratos.forEach((d) => storage.borrarArchivo(d.archivo_path));
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
              fecha_nacimiento, tipo_persona, forma_vinculacion, foto_path, activo,
              acudiente_nombre, acudiente_contacto, riesgo_arl, proximo_examen_medico,
              electrodiagnostico, exige_telemedicina
       FROM funcionarios WHERE id = ?`,
      [id]
    );
    if (!funcionario) return res.status(404).json({ error: 'Colaborador no encontrado' });
    const docs = await documentosDe(id);
    const cursos = await cursosDe(id);
    const adicionales = await adicionalesDe(id);
    const contratos = await contratosDe(id);
    const requisitos = armarChecklist(funcionario.tipo_persona, docs, funcionario);
    const proxima_terminacion_contrato = elegirTerminacion(
      contratos.map((c) => fechaIso(c.fecha_terminacion)).filter(Boolean).sort()
    );
    res.json({
      funcionario: presentarFuncionario(funcionario),
      cursos,
      adicionales,
      contratos,
      requisitos,
      progreso: progresoDe(requisitos, {
        proximo_examen_medico: funcionario.proximo_examen_medico || null,
        proxima_terminacion_contrato
      }),
      riesgos_arl: RIESGO_ARL
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
        `SELECT id, tipo_persona, fecha_nacimiento, activo,
                electrodiagnostico, exige_telemedicina, riesgo_arl, proximo_examen_medico
         FROM funcionarios WHERE id = ? AND activo = 1`,
        [id]
      );
      if (!funcionario) {
        fs.unlink(req.file.path, () => {});
        return res.status(404).json({ error: 'Colaborador no encontrado' });
      }
      const def = DOC_BY_ID[tipo];
      if (!aplicaA(def, funcionario.tipo_persona, flagsDePersona(funcionario))) {
        fs.unlink(req.file.path, () => {});
        return res.status(400).json({ error: 'Ese documento no aplica para este tipo de persona' });
      }

      const fechas = fechasParaAlta(tipo, req.body || {});
      if (fechas.error) {
        fs.unlink(req.file.path, () => {});
        return res.status(400).json({ error: fechas.error });
      }

      let riesgoArl = funcionario.riesgo_arl || null;
      if (tipo === 'afiliacion_arl') {
        const riesgoIn = String(req.body?.riesgo_arl || '').trim().toUpperCase();
        if (!riesgoArlValido(riesgoIn)) {
          fs.unlink(req.file.path, () => {});
          return res.status(400).json({ error: 'Indica la clase de riesgo ARL (I a V)' });
        }
        riesgoArl = riesgoIn;
        const examen = await db.queryOne(
          `SELECT fecha_documento FROM documentos
           WHERE funcionario_id = ? AND tipo = 'examen_medico' AND fecha_documento IS NOT NULL
           ORDER BY id DESC LIMIT 1`,
          [id]
        );
        const proximo = examen?.fecha_documento
          ? proximoExamenDesde(examen.fecha_documento, riesgoArl)
          : null;
        if (proximo) {
          await db.execute(
            'UPDATE funcionarios SET riesgo_arl = ?, proximo_examen_medico = ? WHERE id = ?',
            [riesgoArl, proximo, id]
          );
        } else {
          await db.execute(
            'UPDATE funcionarios SET riesgo_arl = ? WHERE id = ?',
            [riesgoArl, id]
          );
        }
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

      if (tipo === 'examen_medico' && fechas.fecha_documento) {
        const proximo = proximoExamenDesde(fechas.fecha_documento, riesgoArl);
        if (proximo) {
          await db.execute(
            'UPDATE funcionarios SET proximo_examen_medico = ? WHERE id = ?',
            [proximo, id]
          );
        }
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
    await servirArchivoRes(res, row, 'Documento no encontrado');
  } catch (e) {
    res.status(500).json({ error: safeError(e) });
  }
});

router.post('/funcionarios/:id/cursos', requireAuth, (req, res) => {
  upload.single('archivo')(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ error: err.message || 'No se pudo subir el archivo' });
    }
    if (!req.file) return res.status(400).json({ error: 'Adjunta un PDF, JPG o PNG' });

    const id = parseId(req.params.id);
    const nombre = clean(req.body?.nombre, 200);
    const horasRaw = String(req.body?.horas ?? '').trim();
    const horas = horasRaw === '' ? null : Number(horasRaw);
    const fecha_certificacion = fechaIso(req.body?.fecha_certificacion);

    if (!id) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'Colaborador inválido' });
    }
    if (!nombre) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'Indica el nombre del curso' });
    }
    if (horas != null && (Number.isNaN(horas) || horas < 0)) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'Las horas no son válidas' });
    }

    try {
      const funcionario = await db.queryOne(
        'SELECT id FROM funcionarios WHERE id = ? AND activo = 1',
        [id]
      );
      if (!funcionario) {
        fs.unlink(req.file.path, () => {});
        return res.status(404).json({ error: 'Colaborador no encontrado' });
      }
      const rel = storage.rutaRelativa(req.file.path);
      storage.copiarAEspejo(rel);
      const result = await db.execute(
        `INSERT INTO cursos_certificados
          (funcionario_id, nombre, horas, fecha_certificacion, archivo_nombre, archivo_path, subido_por)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, nombre, horas, fecha_certificacion, req.file.originalname, rel, req.session.usuarioId]
      );
      res.json({ ok: true, id: result.insertId });
    } catch (e) {
      fs.unlink(req.file.path, () => {});
      res.status(500).json({ error: safeError(e) });
    }
  });
});

router.delete('/funcionarios/:id/cursos/:cursoId', requireAuth, async (req, res) => {
  const id = parseId(req.params.id);
  const cursoId = parseId(req.params.cursoId);
  if (!id || !cursoId) return res.status(400).json({ error: 'Solicitud inválida' });
  try {
    const row = await db.queryOne(
      'SELECT id, archivo_path FROM cursos_certificados WHERE id = ? AND funcionario_id = ?',
      [cursoId, id]
    );
    if (!row) return res.status(404).json({ error: 'Curso no encontrado' });
    await db.execute('DELETE FROM cursos_certificados WHERE id = ? AND funcionario_id = ?', [cursoId, id]);
    storage.borrarArchivo(row.archivo_path);
    res.json({ ok: true, id: cursoId });
  } catch (e) {
    res.status(500).json({ error: safeError(e) });
  }
});

router.post('/funcionarios/:id/adicionales', requireAuth, (req, res) => {
  upload.single('archivo')(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ error: err.message || 'No se pudo subir el archivo' });
    }
    if (!req.file) return res.status(400).json({ error: 'Adjunta un PDF, JPG o PNG' });

    const id = parseId(req.params.id);
    const descripcion = clean(req.body?.descripcion, 255);
    if (!id) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'Colaborador inválido' });
    }
    if (!descripcion) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'Indica la descripción del documento' });
    }

    try {
      const funcionario = await db.queryOne(
        'SELECT id FROM funcionarios WHERE id = ? AND activo = 1',
        [id]
      );
      if (!funcionario) {
        fs.unlink(req.file.path, () => {});
        return res.status(404).json({ error: 'Colaborador no encontrado' });
      }
      const rel = storage.rutaRelativa(req.file.path);
      storage.copiarAEspejo(rel);
      const result = await db.execute(
        `INSERT INTO documentos_adicionales
          (funcionario_id, descripcion, archivo_nombre, archivo_path, subido_por)
         VALUES (?, ?, ?, ?, ?)`,
        [id, descripcion, req.file.originalname, rel, req.session.usuarioId]
      );
      res.json({ ok: true, id: result.insertId });
    } catch (e) {
      fs.unlink(req.file.path, () => {});
      res.status(500).json({ error: safeError(e) });
    }
  });
});

router.delete('/funcionarios/:id/adicionales/:extraId', requireAuth, async (req, res) => {
  const id = parseId(req.params.id);
  const extraId = parseId(req.params.extraId);
  if (!id || !extraId) return res.status(400).json({ error: 'Solicitud inválida' });
  try {
    const row = await db.queryOne(
      'SELECT id, archivo_path FROM documentos_adicionales WHERE id = ? AND funcionario_id = ?',
      [extraId, id]
    );
    if (!row) return res.status(404).json({ error: 'Documento adicional no encontrado' });
    await db.execute('DELETE FROM documentos_adicionales WHERE id = ? AND funcionario_id = ?', [extraId, id]);
    storage.borrarArchivo(row.archivo_path);
    res.json({ ok: true, id: extraId });
  } catch (e) {
    res.status(500).json({ error: safeError(e) });
  }
});

router.post('/funcionarios/:id/contratos', requireAuth, (req, res) => {
  upload.single('archivo')(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ error: err.message || 'No se pudo subir el archivo' });
    }
    if (!req.file) return res.status(400).json({ error: 'Adjunta un PDF, JPG o PNG' });

    const id = parseId(req.params.id);
    const tipo = clean(req.body?.tipo, 20);
    const descripcion = clean(req.body?.descripcion, 255) || null;
    const fecha_firma = fechaIso(req.body?.fecha_firma);
    const fecha_terminacion = fechaIso(req.body?.fecha_terminacion);

    if (!id) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'Colaborador inválido' });
    }
    if (tipo !== 'contrato' && tipo !== 'otrosi') {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'El tipo debe ser contrato u otrosi' });
    }
    if (!fecha_firma || !fecha_terminacion) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'Indica fecha de firma y fecha de terminación' });
    }

    try {
      const funcionario = await db.queryOne(
        'SELECT id FROM funcionarios WHERE id = ? AND activo = 1',
        [id]
      );
      if (!funcionario) {
        fs.unlink(req.file.path, () => {});
        return res.status(404).json({ error: 'Colaborador no encontrado' });
      }
      const rel = storage.rutaRelativa(req.file.path);
      storage.copiarAEspejo(rel);
      const result = await db.execute(
        `INSERT INTO contratos
          (funcionario_id, tipo, descripcion, archivo_nombre, archivo_path,
           fecha_firma, fecha_terminacion, subido_por)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          tipo,
          descripcion,
          req.file.originalname,
          rel,
          fecha_firma,
          fecha_terminacion,
          req.session.usuarioId
        ]
      );
      res.json({ ok: true, id: result.insertId });
    } catch (e) {
      fs.unlink(req.file.path, () => {});
      res.status(500).json({ error: safeError(e) });
    }
  });
});

router.delete('/funcionarios/:id/contratos/:contratoId', requireAuth, async (req, res) => {
  const id = parseId(req.params.id);
  const contratoId = parseId(req.params.contratoId);
  if (!id || !contratoId) return res.status(400).json({ error: 'Solicitud inválida' });
  try {
    const row = await db.queryOne(
      'SELECT id, archivo_path FROM contratos WHERE id = ? AND funcionario_id = ?',
      [contratoId, id]
    );
    if (!row) return res.status(404).json({ error: 'Contrato no encontrado' });
    await db.execute('DELETE FROM contratos WHERE id = ? AND funcionario_id = ?', [contratoId, id]);
    storage.borrarArchivo(row.archivo_path);
    res.json({ ok: true, id: contratoId });
  } catch (e) {
    res.status(500).json({ error: safeError(e) });
  }
});

router.get('/funcionarios/:id/cursos/:cursoId/archivo', requireAuth, async (req, res) => {
  const id = parseId(req.params.id);
  const cursoId = parseId(req.params.cursoId);
  try {
    const row = await db.queryOne(
      `SELECT archivo_path, archivo_nombre
       FROM cursos_certificados
       WHERE id = ? AND funcionario_id = ?`,
      [cursoId, id]
    );
    if (!row) return res.status(404).json({ error: 'Curso no encontrado' });
    await servirArchivoRes(res, row, 'Curso no encontrado');
  } catch (e) {
    res.status(500).json({ error: safeError(e) });
  }
});

router.get('/funcionarios/:id/adicionales/:extraId/archivo', requireAuth, async (req, res) => {
  const id = parseId(req.params.id);
  const extraId = parseId(req.params.extraId);
  try {
    const row = await db.queryOne(
      `SELECT archivo_path, archivo_nombre
       FROM documentos_adicionales
       WHERE id = ? AND funcionario_id = ?`,
      [extraId, id]
    );
    if (!row) return res.status(404).json({ error: 'Documento adicional no encontrado' });
    await servirArchivoRes(res, row, 'Documento adicional no encontrado');
  } catch (e) {
    res.status(500).json({ error: safeError(e) });
  }
});

router.get('/funcionarios/:id/contratos/:contratoId/archivo', requireAuth, async (req, res) => {
  const id = parseId(req.params.id);
  const contratoId = parseId(req.params.contratoId);
  try {
    const row = await db.queryOne(
      `SELECT archivo_path, archivo_nombre
       FROM contratos
       WHERE id = ? AND funcionario_id = ?`,
      [contratoId, id]
    );
    if (!row) return res.status(404).json({ error: 'Contrato no encontrado' });
    await servirArchivoRes(res, row, 'Contrato no encontrado');
  } catch (e) {
    res.status(500).json({ error: safeError(e) });
  }
});

router.post('/funcionarios/:id/descarga-pdf', requireAuth, async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Colaborador inválido' });
  try {
    const funcionario = await db.queryOne(
      'SELECT id, nombres, apellidos FROM funcionarios WHERE id = ?',
      [id]
    );
    if (!funcionario) return res.status(404).json({ error: 'Colaborador no encontrado' });

    const todos = Boolean(req.body?.todos);
    const docIds = Array.isArray(req.body?.documentos) ? req.body.documentos.map(parseId).filter(Boolean) : [];
    const cursoIds = Array.isArray(req.body?.cursos) ? req.body.cursos.map(parseId).filter(Boolean) : [];
    const extraIds = Array.isArray(req.body?.adicionales) ? req.body.adicionales.map(parseId).filter(Boolean) : [];
    const contratoIds = Array.isArray(req.body?.contratos) ? req.body.contratos.map(parseId).filter(Boolean) : [];

    let docs;
    let cursos;
    let extras;
    let contratos;

    if (todos) {
      docs = await db.query(
        'SELECT archivo_path, archivo_nombre FROM documentos WHERE funcionario_id = ?',
        [id]
      );
      cursos = await db.query(
        'SELECT archivo_path, archivo_nombre FROM cursos_certificados WHERE funcionario_id = ? AND archivo_path IS NOT NULL',
        [id]
      );
      extras = await db.query(
        'SELECT archivo_path, archivo_nombre FROM documentos_adicionales WHERE funcionario_id = ?',
        [id]
      );
      contratos = await db.query(
        'SELECT archivo_path, archivo_nombre FROM contratos WHERE funcionario_id = ?',
        [id]
      );
    } else {
      docs = docIds.length
        ? await db.query(
            `SELECT archivo_path, archivo_nombre FROM documentos
             WHERE funcionario_id = ? AND id IN (${docIds.map(() => '?').join(',')})`,
            [id, ...docIds]
          )
        : [];
      cursos = cursoIds.length
        ? await db.query(
            `SELECT archivo_path, archivo_nombre FROM cursos_certificados
             WHERE funcionario_id = ? AND id IN (${cursoIds.map(() => '?').join(',')})`,
            [id, ...cursoIds]
          )
        : [];
      extras = extraIds.length
        ? await db.query(
            `SELECT archivo_path, archivo_nombre FROM documentos_adicionales
             WHERE funcionario_id = ? AND id IN (${extraIds.map(() => '?').join(',')})`,
            [id, ...extraIds]
          )
        : [];
      contratos = contratoIds.length
        ? await db.query(
            `SELECT archivo_path, archivo_nombre FROM contratos
             WHERE funcionario_id = ? AND id IN (${contratoIds.map(() => '?').join(',')})`,
            [id, ...contratoIds]
          )
        : [];
    }

    const items = [...docs, ...cursos, ...extras, ...contratos]
      .filter((r) => r.archivo_path)
      .map((r) => ({ path: r.archivo_path, nombre: r.archivo_nombre || r.archivo_path }));

    const pdfBytes = await empaquetarPdf(items);
    const safeName = `${clean(funcionario.apellidos, 40)}_${clean(funcionario.nombres, 40)}`
      .replace(/\s+/g, '_')
      .replace(/[^\w.\-áéíóúñÁÉÍÓÚÑ_]+/g, '') || `funcionario_${id}`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="expediente_${safeName}.pdf"`);
    res.send(Buffer.from(pdfBytes));
  } catch (e) {
    res.status(500).json({ error: safeError(e) });
  }
});

module.exports = router;
