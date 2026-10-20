const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const router = express.Router();
const db = require('../utils/db-mysql');
const storage = require('../utils/storage');
const { requireAuth, safeError } = require('../middleware');
const {
  TEMATICAS,
  NIVELES,
  TIPOS_AGENDA,
  PERIODICIDADES,
  AVISO_FRECUENCIAS,
  tematicaValida,
  tipoAgendaValido,
  periodicidadValida,
  avisoFrecuenciaValida,
  avisoHoraValida,
  avisoUsaHoraFija,
  nivel,
  addPeriodo,
  enriquecerTarea,
  enriquecerEvento,
  fechaIso
} = require('../utils/organizador-catalogo');
const { eventosDesdeBanco } = require('../utils/organizador-banco');
const { estadoFecha, ALERTA_DIAS } = require('../utils/documentos-catalogo');

storage.ensureDirs();

const ALLOWED_EXT = /\.(pdf|jpe?g|png)$/i;
const ALLOWED_MIME = new Set(['application/pdf', 'image/jpeg', 'image/png']);

const uploadPrueba = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, storage.organizadorDir()),
    filename: (_req, file, cb) => {
      const safe = String(file.originalname || 'prueba').replace(/[^\w.\-áéíóúñÁÉÍÓÚÑ ]+/g, '_');
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

function parseId(value) {
  const id = parseInt(value, 10);
  return id > 0 ? id : 0;
}

function flag01(value) {
  return value === true || value === '1' || Number(value) === 1 ? 1 : 0;
}

function mimeFor(name) {
  const n = String(name || '').toLowerCase();
  if (n.endsWith('.pdf')) return 'application/pdf';
  if (n.endsWith('.png')) return 'image/png';
  if (n.endsWith('.jpg') || n.endsWith('.jpeg')) return 'image/jpeg';
  return 'application/octet-stream';
}

function usuarioId(req) {
  return parseId(req.session?.usuarioId);
}

async function tareaDe(id) {
  return db.queryOne(
    `SELECT t.*, u.nombre AS completada_por_nombre, c.nombre AS creado_por_nombre
     FROM org_tareas t
     LEFT JOIN usuarios u ON u.id = t.completada_por
     LEFT JOIN usuarios c ON c.id = t.creado_por
     WHERE t.id = ?`,
    [id]
  );
}

function payloadTarea(body, { partial = false } = {}) {
  const titulo = clean(body?.titulo, 220);
  if (!partial && !titulo) return { error: 'Escribe un título' };
  const tematica = clean(body?.tematica, 40) || 'otro';
  if (tematica && !tematicaValida(tematica)) return { error: 'Temática no válida' };
  const campos = {};
  if (!partial || body.titulo != null) campos.titulo = titulo;
  if (!partial || body.detalle != null) campos.detalle = clean(body?.detalle, 4000) || null;
  if (!partial || body.tematica != null) campos.tematica = tematicaValida(tematica) ? tematica : 'otro';
  if (!partial || body.urgencia != null) campos.urgencia = nivel(body?.urgencia);
  if (!partial || body.importancia != null) campos.importancia = nivel(body?.importancia);
  if (!partial || body.fecha_cumplimiento != null) {
    campos.fecha_cumplimiento = fechaIso(body?.fecha_cumplimiento) || null;
  }
  if (!partial || body.requiere_prueba != null) campos.requiere_prueba = flag01(body?.requiere_prueba);
  if (!partial || body.recordar_tarde != null) campos.recordar_tarde = flag01(body?.recordar_tarde);
  if (!partial || body.aviso_frecuencia != null) {
    const freq = clean(body?.aviso_frecuencia, 30) || 'ninguno';
    campos.aviso_frecuencia = avisoFrecuenciaValida(freq) ? freq : 'ninguno';
    if (campos.aviso_frecuencia !== 'ninguno') campos.recordar_tarde = 1;
    else if (body.recordar_tarde == null) campos.recordar_tarde = 0;
  }
  if (!partial || body.aviso_hora != null || body.aviso_frecuencia != null) {
    const freq = campos.aviso_frecuencia
      || (avisoFrecuenciaValida(body?.aviso_frecuencia) ? body.aviso_frecuencia : null);
    if (avisoUsaHoraFija(freq)) {
      const hora = avisoHoraValida(body?.aviso_hora);
      campos.aviso_hora = hora != null ? hora : 12;
    } else if (freq) {
      campos.aviso_hora = null;
    }
  }
  return { campos };
}

function arbolTareas(rows) {
  const map = {};
  rows.forEach((r) => {
    map[r.id] = { ...enriquecerTarea(r), hijos: [] };
  });
  const roots = [];
  rows.forEach((r) => {
    if (r.padre_id && map[r.padre_id]) map[r.padre_id].hijos.push(map[r.id]);
    else if (!r.padre_id) roots.push(map[r.id]);
  });
  return roots;
}

router.get('/organizador/catalogo', requireAuth, (_req, res) => {
  res.json({
    tematicas: TEMATICAS,
    niveles: NIVELES,
    tipos_agenda: Object.fromEntries(
      Object.entries(TIPOS_AGENDA).map(([id, t]) => [id, t.label])
    ),
    tipos_agenda_alerta: Object.fromEntries(
      Object.entries(TIPOS_AGENDA).map(([id, t]) => [id, t.alerta])
    ),
    periodicidades: PERIODICIDADES,
    aviso_frecuencias: AVISO_FRECUENCIAS
  });
});

router.get('/organizador/resumen', requireAuth, async (_req, res) => {
  try {
    const pendientes = await db.query(
      `SELECT id, fecha_cumplimiento, recordar_tarde
       FROM org_tareas WHERE estado = 'pendiente' AND padre_id IS NULL`
    );
    const hoy = fechaIso(new Date().toISOString());
    const vencidas = pendientes.filter((t) => t.fecha_cumplimiento && fechaIso(t.fecha_cumplimiento) < hoy).length;
    const hoyN = pendientes.filter((t) => fechaIso(t.fecha_cumplimiento) === hoy).length;
    const tarde = pendientes.filter((t) => Number(t.recordar_tarde) === 1).length;
    const agenda = await db.query(
      `SELECT fecha, alerta_dias, tipo FROM org_agenda WHERE activo = 1`
    );
    const banco = await eventosDesdeBanco();
    const porVencer = [...agenda.map((e) => enriquecerEvento(e)), ...banco]
      .filter((e) => e.fecha_estado === 'por_vencer' || e.fecha_estado === 'vencido').length;
    res.json({
      pendientes: pendientes.length,
      vencidas,
      para_hoy: hoyN,
      recordar_tarde: tarde,
      agenda_alertas: porVencer
    });
  } catch (e) {
    res.status(500).json({ error: safeError(e) });
  }
});

router.get('/organizador/tareas', requireAuth, async (req, res) => {
  try {
    const estado = clean(req.query.estado, 20) || 'pendiente';
    const tematica = clean(req.query.tematica, 40);
    const params = [];
    let sql = `SELECT t.*, u.nombre AS completada_por_nombre, c.nombre AS creado_por_nombre
               FROM org_tareas t
               LEFT JOIN usuarios u ON u.id = t.completada_por
               LEFT JOIN usuarios c ON c.id = t.creado_por`;
    const where = [];
    if (estado === 'pendiente' || estado === 'completada') {
      where.push('t.estado = ?');
      params.push(estado);
    }
    if (tematica && tematicaValida(tematica)) {
      where.push('t.tematica = ?');
      params.push(tematica);
    }
    if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
    sql += ' ORDER BY t.urgencia DESC, t.importancia DESC, t.fecha_cumplimiento IS NULL, t.fecha_cumplimiento ASC, t.id DESC';
    const rows = await db.query(sql, params);

    if (estado === 'pendiente') {
      const idsPadres = rows.filter((r) => !r.padre_id).map((r) => r.id);
      let hijos = [];
      if (idsPadres.length) {
        hijos = await db.query(
          `SELECT t.*, u.nombre AS completada_por_nombre, c.nombre AS creado_por_nombre
           FROM org_tareas t
           LEFT JOIN usuarios u ON u.id = t.completada_por
           LEFT JOIN usuarios c ON c.id = t.creado_por
           WHERE t.padre_id IN (${idsPadres.map(() => '?').join(',')})`,
          idsPadres
        );
      }
      const combined = [...rows.filter((r) => !r.padre_id), ...hijos];
      return res.json(arbolTareas(combined));
    }

    if (estado === 'completada') {
      const padres = rows.filter((r) => !r.padre_id);
      const ids = padres.map((r) => r.id);
      let hijos = [];
      if (ids.length) {
        hijos = await db.query(
          `SELECT t.*, u.nombre AS completada_por_nombre, c.nombre AS creado_por_nombre
           FROM org_tareas t
           LEFT JOIN usuarios u ON u.id = t.completada_por
           LEFT JOIN usuarios c ON c.id = t.creado_por
           WHERE t.padre_id IN (${ids.map(() => '?').join(',')})`,
          ids
        );
      }
      return res.json(arbolTareas([...padres, ...hijos]));
    }

    res.json(arbolTareas(rows));
  } catch (e) {
    res.status(500).json({ error: safeError(e) });
  }
});

router.post('/organizador/tareas', requireAuth, async (req, res) => {
  try {
    const parsed = payloadTarea(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const padreId = parseId(req.body?.padre_id) || null;
    if (padreId) {
      const padre = await db.queryOne('SELECT id, estado FROM org_tareas WHERE id = ? AND padre_id IS NULL', [padreId]);
      if (!padre) return res.status(404).json({ error: 'La tarea principal no existe' });
      if (padre.estado === 'completada') {
        return res.status(400).json({ error: 'No se puede agregar una subtarea a una tarea ya completada' });
      }
    }
    const c = parsed.campos;
    const result = await db.execute(
      `INSERT INTO org_tareas
        (padre_id, titulo, detalle, tematica, urgencia, importancia, fecha_cumplimiento,
         requiere_prueba, recordar_tarde, aviso_frecuencia, aviso_hora, creado_por)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        padreId,
        c.titulo,
        c.detalle,
        c.tematica,
        c.urgencia,
        c.importancia,
        c.fecha_cumplimiento,
        padreId ? c.requiere_prueba : c.requiere_prueba,
        padreId ? 0 : (c.recordar_tarde || 0),
        padreId ? 'ninguno' : (c.aviso_frecuencia || 'ninguno'),
        padreId ? null : (c.aviso_hora ?? null),
        usuarioId(req) || null
      ]
    );
    const row = await tareaDe(result.insertId);
    res.json({ ok: true, tarea: enriquecerTarea(row) });
  } catch (e) {
    res.status(500).json({ error: safeError(e) });
  }
});

router.patch('/organizador/tareas/:id', requireAuth, async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Tarea inválida' });
  try {
    const row = await tareaDe(id);
    if (!row) return res.status(404).json({ error: 'Tarea no encontrada' });
    if (row.estado === 'completada') {
      return res.status(400).json({ error: 'Una tarea completada no se edita; revísala en trazabilidad' });
    }
    const parsed = payloadTarea(req.body, { partial: true });
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const c = parsed.campos;
    await db.execute(
      `UPDATE org_tareas SET
         titulo = COALESCE(?, titulo),
         detalle = ?,
         tematica = COALESCE(?, tematica),
         urgencia = COALESCE(?, urgencia),
         importancia = COALESCE(?, importancia),
         fecha_cumplimiento = ?,
         requiere_prueba = COALESCE(?, requiere_prueba),
         recordar_tarde = COALESCE(?, recordar_tarde),
         aviso_frecuencia = COALESCE(?, aviso_frecuencia),
         aviso_hora = ?
       WHERE id = ?`,
      [
        c.titulo || null,
        c.detalle !== undefined ? c.detalle : row.detalle,
        c.tematica || null,
        c.urgencia ?? null,
        c.importancia ?? null,
        c.fecha_cumplimiento !== undefined ? c.fecha_cumplimiento : row.fecha_cumplimiento,
        c.requiere_prueba ?? null,
        row.padre_id ? 0 : (c.recordar_tarde != null ? c.recordar_tarde : row.recordar_tarde),
        row.padre_id ? 'ninguno' : (c.aviso_frecuencia ?? null),
        row.padre_id
          ? null
          : (c.aviso_hora !== undefined ? c.aviso_hora : (row.aviso_hora ?? null)),
        id
      ]
    );
    res.json({ ok: true, tarea: enriquecerTarea(await tareaDe(id)) });
  } catch (e) {
    res.status(500).json({ error: safeError(e) });
  }
});

router.delete('/organizador/tareas/:id', requireAuth, async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Tarea inválida' });
  try {
    const row = await tareaDe(id);
    if (!row) return res.status(404).json({ error: 'Tarea no encontrada' });
    if (row.prueba_path) storage.borrarArchivo(row.prueba_path);
    const hijos = await db.query('SELECT prueba_path FROM org_tareas WHERE padre_id = ?', [id]);
    hijos.forEach((h) => {
      if (h.prueba_path) storage.borrarArchivo(h.prueba_path);
    });
    await db.execute('DELETE FROM org_tareas WHERE id = ?', [id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: safeError(e) });
  }
});

router.post('/organizador/tareas/:id/completar', requireAuth, (req, res) => {
  uploadPrueba.single('prueba')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || 'No se pudo subir la prueba' });
    const id = parseId(req.params.id);
    if (!id) {
      if (req.file) fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'Tarea inválida' });
    }
    try {
      const row = await tareaDe(id);
      if (!row) {
        if (req.file) fs.unlink(req.file.path, () => {});
        return res.status(404).json({ error: 'Tarea no encontrada' });
      }
      if (row.estado === 'completada') {
        if (req.file) fs.unlink(req.file.path, () => {});
        return res.status(400).json({ error: 'Esta tarea ya estaba completada' });
      }
      const justificacion = clean(req.body?.justificacion, 4000);
      const requiere = Number(row.requiere_prueba) === 1;
      if (requiere && !req.file && !justificacion) {
        return res.status(400).json({ error: 'Esta tarea pide prueba o una descripción de cómo se completó' });
      }
      let pruebaPath = row.prueba_path;
      let pruebaNombre = row.prueba_nombre;
      if (req.file) {
        pruebaPath = storage.rutaRelativa(req.file.path);
        pruebaNombre = req.file.originalname || req.file.filename;
        storage.copiarAEspejo(pruebaPath);
      }
      await db.execute(
        `UPDATE org_tareas SET
           estado = 'completada',
           completada_en = NOW(),
           completada_por = ?,
           justificacion = ?,
           prueba_path = ?,
           prueba_nombre = ?
         WHERE id = ?`,
        [usuarioId(req) || null, justificacion || null, pruebaPath, pruebaNombre, id]
      );
      res.json({ ok: true, tarea: enriquecerTarea(await tareaDe(id)) });
    } catch (e) {
      if (req.file) fs.unlink(req.file.path, () => {});
      res.status(500).json({ error: safeError(e) });
    }
  });
});

router.get('/organizador/tareas/:id/prueba', requireAuth, async (req, res) => {
  const id = parseId(req.params.id);
  try {
    const row = await db.queryOne('SELECT prueba_path, prueba_nombre FROM org_tareas WHERE id = ?', [id]);
    if (!row?.prueba_path) return res.status(404).json({ error: 'Sin prueba adjunta' });
    const abs = storage.resolverLectura(row.prueba_path);
    if (!abs) return res.status(404).json({ error: 'El archivo ya no está en el servidor' });
    res.setHeader('Content-Type', mimeFor(row.prueba_nombre || row.prueba_path));
    res.setHeader('Content-Disposition', `inline; filename="${path.basename(row.prueba_nombre || 'prueba')}"`);
    fs.createReadStream(abs).pipe(res);
  } catch (e) {
    res.status(500).json({ error: safeError(e) });
  }
});

router.get('/organizador/agenda', requireAuth, async (req, res) => {
  try {
    const tipo = clean(req.query.tipo, 40);
    const incluirBanco = String(req.query.banco || '1') !== '0';
    const params = [];
    let sql = `SELECT a.*, u.nombre AS creado_por_nombre
               FROM org_agenda a
               LEFT JOIN usuarios u ON u.id = a.creado_por
               WHERE a.activo = 1`;
    if (tipo && tipoAgendaValido(tipo)) {
      sql += ' AND a.tipo = ?';
      params.push(tipo);
    }
    sql += ' ORDER BY a.fecha ASC, a.id ASC';
    const rows = await db.query(sql, params);
    const ids = rows.map((r) => r.id);
    let obs = [];
    if (ids.length) {
      obs = await db.query(
        `SELECT o.*, u.nombre AS creado_por_nombre
         FROM org_agenda_obs o
         LEFT JOIN usuarios u ON u.id = o.creado_por
         WHERE o.agenda_id IN (${ids.map(() => '?').join(',')})
         ORDER BY o.creado_en DESC`,
        ids
      );
    }
    const byId = {};
    obs.forEach((o) => {
      if (!byId[o.agenda_id]) byId[o.agenda_id] = [];
      byId[o.agenda_id].push({
        id: o.id,
        texto: o.texto,
        creado_en: o.creado_en,
        creado_por_nombre: o.creado_por_nombre,
        tiene_prueba: Boolean(o.prueba_path)
      });
    });
    const propios = rows.map((r) => {
      const ev = enriquecerEvento(r);
      ev.observaciones = byId[r.id] || [];
      return ev;
    });
    const banco = incluirBanco ? await eventosDesdeBanco() : [];
    const tareas = await db.query(
      `SELECT id, titulo, detalle, tematica, fecha_cumplimiento, urgencia, importancia
       FROM org_tareas
       WHERE estado = 'pendiente' AND padre_id IS NULL AND fecha_cumplimiento IS NOT NULL`
    );
    const desdeTareas = tareas.map((t) => {
      const fecha = String(t.fecha_cumplimiento || '').slice(0, 10);
      return {
        id: `tarea-${t.id}`,
        fuente: 'tarea',
        tipo: 'otro',
        tipo_label: TEMATICAS[t.tematica] || t.tematica || 'Tarea',
        titulo: t.titulo,
        detalle: t.detalle || 'Tarea pendiente del organizador',
        fecha,
        periodicidad: 'ninguna',
        alerta_dias: ALERTA_DIAS,
        fecha_estado: estadoFecha(fecha, ALERTA_DIAS),
        editable: false,
        tarea_id: t.id
      };
    });
    const lista = [...propios, ...banco, ...desdeTareas].sort((a, b) => String(a.fecha || '9999').localeCompare(String(b.fecha || '9999')));
    res.json(lista);
  } catch (e) {
    res.status(500).json({ error: safeError(e) });
  }
});

router.post('/organizador/agenda', requireAuth, async (req, res) => {
  try {
    const titulo = clean(req.body?.titulo, 220);
    if (!titulo) return res.status(400).json({ error: 'Escribe un título' });
    const tipo = clean(req.body?.tipo, 40) || 'otro';
    if (!tipoAgendaValido(tipo)) return res.status(400).json({ error: 'Tipo de evento no válido' });
    const fecha = fechaIso(req.body?.fecha);
    if (!fecha) return res.status(400).json({ error: 'Indica la fecha' });
    const periodicidad = clean(req.body?.periodicidad, 20) || 'ninguna';
    if (!periodicidadValida(periodicidad)) return res.status(400).json({ error: 'Periodicidad no válida' });
    const alerta = parseInt(req.body?.alerta_dias, 10);
    const requiere = Number(req.body?.requiere_prueba) === 1 ? 1 : 0;
    const result = await db.execute(
      `INSERT INTO org_agenda
        (titulo, tipo, detalle, ubicacion, fecha, periodicidad, alerta_dias, requiere_prueba, creado_por)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        titulo,
        tipo,
        clean(req.body?.detalle, 4000) || null,
        clean(req.body?.ubicacion, 180) || null,
        fecha,
        periodicidad,
        Number.isFinite(alerta) && alerta >= 0 ? alerta : (TIPOS_AGENDA[tipo].alerta),
        requiere,
        usuarioId(req) || null
      ]
    );
    const row = await db.queryOne('SELECT * FROM org_agenda WHERE id = ?', [result.insertId]);
    res.json({ ok: true, evento: enriquecerEvento(row) });
  } catch (e) {
    res.status(500).json({ error: safeError(e) });
  }
});

router.patch('/organizador/agenda/:id', requireAuth, async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Evento inválido' });
  try {
    const row = await db.queryOne('SELECT * FROM org_agenda WHERE id = ?', [id]);
    if (!row) return res.status(404).json({ error: 'Evento no encontrado' });
    const titulo = req.body?.titulo != null ? clean(req.body.titulo, 220) : row.titulo;
    if (!titulo) return res.status(400).json({ error: 'Escribe un título' });
    const tipo = req.body?.tipo != null ? clean(req.body.tipo, 40) : row.tipo;
    if (!tipoAgendaValido(tipo)) return res.status(400).json({ error: 'Tipo de evento no válido' });
    const fecha = req.body?.fecha != null ? fechaIso(req.body.fecha) : fechaIso(row.fecha);
    if (!fecha) return res.status(400).json({ error: 'Indica la fecha' });
    const periodicidad = req.body?.periodicidad != null
      ? clean(req.body.periodicidad, 20)
      : row.periodicidad;
    if (!periodicidadValida(periodicidad)) return res.status(400).json({ error: 'Periodicidad no válida' });
    const alertaIn = parseInt(req.body?.alerta_dias, 10);
    const requiere = req.body?.requiere_prueba != null
      ? (Number(req.body.requiere_prueba) === 1 ? 1 : 0)
      : Number(row.requiere_prueba) === 1 ? 1 : 0;
    await db.execute(
      `UPDATE org_agenda SET
         titulo = ?, tipo = ?, detalle = ?, ubicacion = ?, fecha = ?,
         periodicidad = ?, alerta_dias = ?, requiere_prueba = ?
       WHERE id = ?`,
      [
        titulo,
        tipo,
        req.body?.detalle != null ? (clean(req.body.detalle, 4000) || null) : row.detalle,
        req.body?.ubicacion != null ? (clean(req.body.ubicacion, 180) || null) : row.ubicacion,
        fecha,
        periodicidad,
        Number.isFinite(alertaIn) && alertaIn >= 0 ? alertaIn : row.alerta_dias,
        requiere,
        id
      ]
    );
    const updated = await db.queryOne('SELECT * FROM org_agenda WHERE id = ?', [id]);
    res.json({ ok: true, evento: enriquecerEvento(updated) });
  } catch (e) {
    res.status(500).json({ error: safeError(e) });
  }
});

router.delete('/organizador/agenda/:id', requireAuth, async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Evento inválido' });
  try {
    const pruebas = await db.query('SELECT prueba_path FROM org_agenda_obs WHERE agenda_id = ?', [id]);
    pruebas.forEach((p) => {
      if (p.prueba_path) storage.borrarArchivo(p.prueba_path);
    });
    await db.execute('DELETE FROM org_agenda WHERE id = ?', [id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: safeError(e) });
  }
});

router.post('/organizador/agenda/:id/observacion', requireAuth, async (req, res) => {
  const id = parseId(req.params.id);
  const texto = clean(req.body?.texto, 4000);
  if (!id) return res.status(400).json({ error: 'Evento inválido' });
  if (!texto) return res.status(400).json({ error: 'Escribe la observación' });
  try {
    const row = await db.queryOne('SELECT id FROM org_agenda WHERE id = ?', [id]);
    if (!row) return res.status(404).json({ error: 'Evento no encontrado' });
    await db.execute(
      'INSERT INTO org_agenda_obs (agenda_id, texto, creado_por) VALUES (?, ?, ?)',
      [id, texto, usuarioId(req) || null]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: safeError(e) });
  }
});

router.post('/organizador/agenda/:id/realizar', requireAuth, (req, res, next) => {
  const ct = String(req.headers['content-type'] || '');
  if (ct.includes('multipart/form-data')) return uploadPrueba.single('prueba')(req, res, next);
  next();
}, async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'Evento inválido' });
  }
  try {
    const row = await db.queryOne('SELECT * FROM org_agenda WHERE id = ?', [id]);
    if (!row) {
      if (req.file) fs.unlink(req.file.path, () => {});
      return res.status(404).json({ error: 'Evento no encontrado' });
    }
    const nota = clean(req.body?.texto, 4000) || 'Marcado como realizado';
    const requiere = Number(row.requiere_prueba) === 1;
    if (requiere && !req.file && nota === 'Marcado como realizado') {
      return res.status(400).json({ error: 'Este evento pide prueba: adjunta un archivo o describe cómo se hizo' });
    }
    let pruebaPath = null;
    let pruebaNombre = null;
    if (req.file) {
      pruebaPath = storage.rutaRelativa(req.file.path);
      pruebaNombre = req.file.originalname || req.file.filename;
      storage.copiarAEspejo(pruebaPath);
    }
    await db.execute(
      `INSERT INTO org_agenda_obs (agenda_id, texto, prueba_nombre, prueba_path, creado_por)
       VALUES (?, ?, ?, ?, ?)`,
      [id, nota, pruebaNombre, pruebaPath, usuarioId(req) || null]
    );
    if (row.periodicidad && row.periodicidad !== 'ninguna') {
      const hoy = fechaIso(new Date().toISOString());
      let next = addPeriodo(row.fecha, row.periodicidad, row.fecha);
      while (next && next <= hoy) next = addPeriodo(next, row.periodicidad, row.fecha);
      if (next) await db.execute('UPDATE org_agenda SET fecha = ? WHERE id = ?', [next, id]);
    }
    const updated = await db.queryOne('SELECT * FROM org_agenda WHERE id = ?', [id]);
    res.json({ ok: true, evento: enriquecerEvento(updated) });
  } catch (e) {
    if (req.file) fs.unlink(req.file.path, () => {});
    res.status(500).json({ error: safeError(e) });
  }
});

router.get('/organizador/agenda/obs/:obsId/prueba', requireAuth, async (req, res) => {
  const id = parseId(req.params.obsId);
  try {
    const row = await db.queryOne(
      'SELECT prueba_path, prueba_nombre FROM org_agenda_obs WHERE id = ?',
      [id]
    );
    if (!row?.prueba_path) return res.status(404).json({ error: 'Sin prueba adjunta' });
    const abs = storage.resolverLectura(row.prueba_path);
    if (!abs) return res.status(404).json({ error: 'El archivo ya no está en el servidor' });
    res.setHeader('Content-Type', mimeFor(row.prueba_nombre || row.prueba_path));
    res.setHeader('Content-Disposition', `inline; filename="${path.basename(row.prueba_nombre || 'prueba')}"`);
    fs.createReadStream(abs).pipe(res);
  } catch (e) {
    res.status(500).json({ error: safeError(e) });
  }
});

module.exports = router;
