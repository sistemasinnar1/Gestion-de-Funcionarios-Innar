const TIPOS_PERSONA = {
  asistencial: {
    id: 'asistencial',
    label: 'Asistencial',
    descripcion: 'Personal con contacto con el paciente (médicos, especialistas, auxiliares, terapias, psicología, etc.)'
  },
  administrativo: {
    id: 'administrativo',
    label: 'Administrativo',
    descripcion: 'Sin contacto con el paciente'
  }
};

const FORMAS_VINCULACION = {
  contrato_trabajo: 'Contrato de trabajo',
  prestacion_servicios: 'Prestación de servicios',
  cooperativa: 'Cooperativa'
};

/** Periodicidad del examen médico ocupacional según clase de riesgo ARL (meses). */
const RIESGO_ARL = {
  I: { label: 'I — Mínimo', meses: 60 },
  II: { label: 'II — Bajo', meses: 36 },
  III: { label: 'III — Medio', meses: 24 },
  IV: { label: 'IV — Alto', meses: 12 },
  V: { label: 'V — Máximo', meses: 12 }
};

const ALERTA_DIAS = 30;
/** Aviso de contrato: 1 mes + 2 días ≈ 32 días. */
const CONTRATO_ALERTA_DIAS = 32;

/**
 * required:
 *  - 'ambos' | 'asistencial' | 'administrativo'
 *  - 'flag:electrodiagnostico' | 'flag:exige_telemedicina'
 * optionalAdmin: aparece en admin como opcional
 * flags: condiciones de persona
 */
const DOC_TYPES = [
  { id: 'hoja_vida', label: 'Hoja de vida', required: 'ambos' },
  { id: 'cedula', label: 'Cédula / documento de identidad', required: 'ambos', pideFechaNacimiento: true },
  { id: 'autorizacion_datos', label: 'Autorización de tratamiento de datos personales', required: 'ambos' },
  { id: 'titulo_bachiller', label: 'Título de bachiller', required: 'ambos' },
  { id: 'acta_bachiller', label: 'Acta de grado de bachiller', required: 'ambos' },
  { id: 'titulo_profesional', label: 'Título profesional o habilitador', required: 'asistencial', optionalAdmin: true },
  { id: 'acta_profesional', label: 'Acta de grado profesional o habilitadora', required: 'asistencial', optionalAdmin: true },
  { id: 'rethus', label: 'RETHUS o tarjeta profesional', required: 'asistencial' },
  { id: 'carnet_vacunacion', label: 'Carnet de vacunación', required: 'asistencial' },
  { id: 'certificado_rcp', label: 'Certificado de reanimación cardiopulmonar (RCP)', required: 'flag:electrodiagnostico' },
  { id: 'cursos_generales', label: 'Constancias y certificados de cursos', required: 'ambos', multiple: true },
  { id: 'constancias_trabajo', label: 'Constancias de trabajo', required: 'ambos', multiple: true },
  {
    id: 'examen_medico',
    label: 'Examen médico ocupacional',
    required: 'ambos',
    pideFecha: 'documento',
    labelFecha: 'Fecha del examen'
  },
  {
    id: 'recomendaciones_medico',
    label: 'Recomendaciones médico ocupacionales (Instituto)',
    required: 'ambos'
  },
  { id: 'afiliacion_salud', label: 'Afiliación a salud', required: 'ambos' },
  { id: 'afiliacion_pension', label: 'Afiliación a pensión', required: 'ambos' },
  {
    id: 'afiliacion_arl',
    label: 'Afiliación a ARL',
    required: 'ambos',
    pideRiesgoArl: true
  },
  {
    id: 'curso_violencia_sexual',
    label: 'Curso de violencia sexual',
    required: 'asistencial',
    vigenciaMeses: 24,
    pideFecha: 'documento',
    labelFecha: 'Fecha del curso'
  },
  {
    id: 'curso_soporte_vital',
    label: 'Soporte básico o avanzado vital',
    required: 'asistencial',
    vigenciaMeses: 24,
    pideFecha: 'documento',
    labelFecha: 'Fecha del curso'
  },
  {
    id: 'curso_duelo',
    label: 'Gestión de duelo',
    required: 'asistencial',
    vigenciaMeses: 24,
    pideFecha: 'documento',
    labelFecha: 'Fecha del curso'
  },
  {
    id: 'curso_telemedicina',
    label: 'Telemedicina',
    required: 'flag:exige_telemedicina',
    vigenciaMeses: 24,
    pideFecha: 'documento',
    labelFecha: 'Fecha del curso'
  },
  { id: 'poliza_rc', label: 'Póliza de responsabilidad civil', required: 'ambos', pideFecha: 'vencimiento', labelFecha: 'Fecha de vencimiento' },
  { id: 'rut', label: 'RUT', required: 'ambos' }
];

const DOC_BY_ID = Object.fromEntries(DOC_TYPES.map((d) => [d.id, d]));

function tipoPersonaValido(value) {
  return Boolean(TIPOS_PERSONA[value]);
}

function formaVinculacionValida(value) {
  return Boolean(FORMAS_VINCULACION[value]);
}

function riesgoArlValido(value) {
  return Boolean(RIESGO_ARL[String(value || '').toUpperCase()]);
}

function docTipoValido(value) {
  return Boolean(DOC_BY_ID[value]);
}

function flagsDePersona(persona = {}) {
  return {
    electrodiagnostico: Number(persona.electrodiagnostico) === 1,
    exige_telemedicina: Number(persona.exige_telemedicina) === 1
  };
}

function aplicaA(doc, tipoPersona, flags = {}) {
  if (doc.required === 'ambos' || doc.optionalAdmin) return true;
  if (doc.required === 'asistencial' || doc.required === 'administrativo') {
    return doc.required === tipoPersona;
  }
  if (doc.required === 'flag:electrodiagnostico') return Boolean(flags.electrodiagnostico);
  if (doc.required === 'flag:exige_telemedicina') return Boolean(flags.exige_telemedicina);
  return false;
}

function esRequerido(doc, tipoPersona, flags = {}) {
  if (doc.required === 'ambos') return true;
  if (doc.required === 'asistencial' || doc.required === 'administrativo') {
    return doc.required === tipoPersona;
  }
  if (doc.required === 'flag:electrodiagnostico') return Boolean(flags.electrodiagnostico);
  if (doc.required === 'flag:exige_telemedicina') return Boolean(flags.exige_telemedicina);
  return false;
}

function addMonths(iso, months) {
  const [y, m, d] = String(iso).split('-').map(Number);
  if (!y || !m || !d) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCMonth(dt.getUTCMonth() + months);
  return dt.toISOString().slice(0, 10);
}

function addDays(iso, days) {
  const fecha = fechaIso(iso);
  if (!fecha) return null;
  const d = new Date(`${fecha}T00:00:00`);
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function fechaIso(value) {
  const raw = String(value || '').trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}

function daysUntil(iso) {
  const fecha = fechaIso(iso);
  if (!fecha) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const d = new Date(`${fecha}T00:00:00`);
  return Math.round((d.getTime() - today.getTime()) / 86400000);
}

function proximoExamenDesde(fechaExamen, riesgo) {
  const fecha = fechaIso(fechaExamen);
  const key = String(riesgo || '').toUpperCase();
  const def = RIESGO_ARL[key];
  if (!fecha || !def) return null;
  return addMonths(fecha, def.meses);
}

function estadoArchivos(doc, archivos) {
  if (!archivos.length) return 'falta';
  const latest = archivos[0];
  const vence = latest.fecha_vencimiento || null;
  const days = daysUntil(vence);
  if (days != null && days < 0) return 'vencido';
  if (days != null && days <= ALERTA_DIAS) return 'por_vencer';
  return 'cargado';
}

function estadoFecha(iso, alertaDias = ALERTA_DIAS) {
  const days = daysUntil(iso);
  if (days == null) return null;
  if (days < 0) return 'vencido';
  if (days <= alertaDias) return 'por_vencer';
  return 'vigente';
}

function mapArchivo(row) {
  return {
    id: row.id,
    nombre: row.archivo_nombre,
    fecha_documento: row.fecha_documento || null,
    fecha_vencimiento: row.fecha_vencimiento || null,
    creado_en: row.creado_en,
    subido_por: row.subido_por_nombre || null
  };
}

function armarChecklist(tipoPersona, documentosRows, persona = {}) {
  const tipo = tipoPersonaValido(tipoPersona) ? tipoPersona : 'administrativo';
  const flags = flagsDePersona(persona);
  const grouped = {};
  (documentosRows || []).forEach((row) => {
    if (!grouped[row.tipo]) grouped[row.tipo] = [];
    grouped[row.tipo].push(row);
  });
  Object.keys(grouped).forEach((key) => {
    grouped[key].sort((a, b) => Number(b.id) - Number(a.id));
  });

  return DOC_TYPES.filter((doc) => aplicaA(doc, tipo, flags)).map((doc) => {
    const archivos = (grouped[doc.id] || []).map(mapArchivo);
    return {
      tipo: doc.id,
      label: doc.label,
      required: esRequerido(doc, tipo, flags),
      multiple: Boolean(doc.multiple),
      pideFechaNacimiento: Boolean(doc.pideFechaNacimiento),
      pideFecha: doc.pideFecha || null,
      labelFecha: doc.labelFecha || null,
      pideRiesgoArl: Boolean(doc.pideRiesgoArl),
      vigenciaMeses: doc.vigenciaMeses || null,
      estado: estadoArchivos(doc, archivos),
      archivos
    };
  });
}

function progresoDe(checklist, extras = {}) {
  const req = checklist.filter((item) => item.required);
  const cargados = req.filter((item) => item.estado === 'cargado' || item.estado === 'por_vencer').length;
  const faltantes = Math.max(0, req.length - cargados);
  let vencidos = checklist.filter((item) => item.estado === 'vencido').length;
  let por_vencer = checklist.filter((item) => item.estado === 'por_vencer').length;

  const examenEstado = estadoFecha(extras.proximo_examen_medico, ALERTA_DIAS);
  if (examenEstado === 'vencido') vencidos += 1;
  if (examenEstado === 'por_vencer') por_vencer += 1;

  const contratoEstado = estadoFecha(extras.proxima_terminacion_contrato, CONTRATO_ALERTA_DIAS);
  if (contratoEstado === 'vencido') vencidos += 1;
  if (contratoEstado === 'por_vencer') por_vencer += 1;

  return {
    cargados,
    requeridos: req.length,
    faltantes,
    vencidos,
    por_vencer,
    examen_estado: examenEstado,
    contrato_estado: contratoEstado
  };
}

function alertaDe(progreso) {
  if (progreso.vencidos > 0) return 'vencido';
  if (progreso.por_vencer > 0) return 'por_vencer';
  return null;
}

function fechasParaAlta(tipoDoc, body) {
  const def = DOC_BY_ID[tipoDoc];
  if (!def) return { error: 'Tipo de documento inválido' };
  const fechaDocumento = fechaIso(body.fecha_documento);
  const fechaVencimientoIn = fechaIso(body.fecha_vencimiento);

  if (def.pideFecha === 'documento') {
    if (!fechaDocumento) {
      return { error: def.labelFecha ? `Indica la ${def.labelFecha.toLowerCase()}` : 'Indica la fecha del documento' };
    }
    return {
      fecha_documento: fechaDocumento,
      fecha_vencimiento: def.vigenciaMeses ? addMonths(fechaDocumento, def.vigenciaMeses) : null
    };
  }
  if (def.pideFecha === 'vencimiento') {
    if (!fechaVencimientoIn) {
      return { error: 'Indica la fecha de vencimiento' };
    }
    return {
      fecha_documento: fechaDocumento,
      fecha_vencimiento: fechaVencimientoIn
    };
  }
  return { fecha_documento: fechaDocumento, fecha_vencimiento: fechaVencimientoIn };
}

module.exports = {
  TIPOS_PERSONA,
  FORMAS_VINCULACION,
  RIESGO_ARL,
  DOC_TYPES,
  DOC_BY_ID,
  tipoPersonaValido,
  formaVinculacionValida,
  riesgoArlValido,
  docTipoValido,
  aplicaA,
  esRequerido,
  flagsDePersona,
  armarChecklist,
  progresoDe,
  alertaDe,
  fechasParaAlta,
  fechaIso,
  daysUntil,
  addMonths,
  addDays,
  proximoExamenDesde,
  estadoFecha,
  ALERTA_DIAS,
  CONTRATO_ALERTA_DIAS
};
