const TIPOS_PERSONA = {
  asistencial: {
    id: 'asistencial',
    label: 'Asistencial',
    descripcion: 'Personal en contacto con el paciente'
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

const DOC_TYPES = [
  { id: 'hoja_vida', label: 'Hoja de vida', required: 'ambos' },
  { id: 'cedula', label: 'Cédula / documento de identidad', required: 'ambos', pideFechaNacimiento: true },
  { id: 'titulo_bachiller', label: 'Título de bachiller', required: 'ambos' },
  { id: 'acta_bachiller', label: 'Acta de grado de bachiller', required: 'ambos' },
  { id: 'titulo_profesional', label: 'Título profesional o habilitador', required: 'asistencial', optionalAdmin: true },
  { id: 'acta_profesional', label: 'Acta de grado profesional o habilitadora', required: 'asistencial', optionalAdmin: true },
  { id: 'rethus', label: 'RETHUS o tarjeta profesional', required: 'asistencial' },
  { id: 'cursos_generales', label: 'Constancias y certificados de cursos', required: 'ambos', multiple: true },
  { id: 'constancias_trabajo', label: 'Constancias de trabajo', required: 'ambos', multiple: true },
  { id: 'examen_medico', label: 'Examen médico ocupacional', required: 'ambos' },
  { id: 'afiliacion_salud', label: 'Afiliación a salud', required: 'ambos' },
  { id: 'afiliacion_pension', label: 'Afiliación a pensión', required: 'ambos' },
  { id: 'afiliacion_arl', label: 'Afiliación a ARL', required: 'ambos' },
  {
    id: 'curso_violencia_sexual',
    label: 'Curso de violencia sexual',
    required: 'asistencial',
    vigenciaMeses: 24,
    pideFecha: 'documento'
  },
  {
    id: 'curso_soporte_vital',
    label: 'Soporte básico o avanzado vital',
    required: 'asistencial',
    vigenciaMeses: 24,
    pideFecha: 'documento'
  },
  {
    id: 'curso_duelo',
    label: 'Gestión de duelo',
    required: 'asistencial',
    vigenciaMeses: 24,
    pideFecha: 'documento'
  },
  {
    id: 'curso_telemedicina',
    label: 'Telemedicina',
    required: 'asistencial',
    vigenciaMeses: 24,
    pideFecha: 'documento'
  },
  { id: 'poliza_rc', label: 'Póliza de responsabilidad civil', required: 'ambos', pideFecha: 'vencimiento' },
  { id: 'rut', label: 'RUT', required: 'ambos' }
];

const ALERTA_DIAS = 30;
const DOC_BY_ID = Object.fromEntries(DOC_TYPES.map((d) => [d.id, d]));

function tipoPersonaValido(value) {
  return Boolean(TIPOS_PERSONA[value]);
}

function formaVinculacionValida(value) {
  return Boolean(FORMAS_VINCULACION[value]);
}

function docTipoValido(value) {
  return Boolean(DOC_BY_ID[value]);
}

function aplicaA(doc, tipoPersona) {
  if (doc.required === 'ambos' || doc.optionalAdmin) return true;
  return doc.required === tipoPersona;
}

function esRequerido(doc, tipoPersona) {
  if (doc.required === 'ambos') return true;
  return doc.required === tipoPersona;
}

function addMonths(iso, months) {
  const [y, m, d] = String(iso).split('-').map(Number);
  if (!y || !m || !d) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCMonth(dt.getUTCMonth() + months);
  return dt.toISOString().slice(0, 10);
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

function estadoArchivos(doc, archivos) {
  if (!archivos.length) return 'falta';
  const latest = archivos[0];
  const vence = latest.fecha_vencimiento || null;
  const days = daysUntil(vence);
  if (days != null && days < 0) return 'vencido';
  if (days != null && days <= ALERTA_DIAS) return 'por_vencer';
  return 'cargado';
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

function armarChecklist(tipoPersona, documentosRows) {
  const tipo = tipoPersonaValido(tipoPersona) ? tipoPersona : 'administrativo';
  const grouped = {};
  (documentosRows || []).forEach((row) => {
    if (!grouped[row.tipo]) grouped[row.tipo] = [];
    grouped[row.tipo].push(row);
  });
  Object.keys(grouped).forEach((key) => {
    grouped[key].sort((a, b) => Number(b.id) - Number(a.id));
  });

  return DOC_TYPES.filter((doc) => aplicaA(doc, tipo)).map((doc) => {
    const archivos = (grouped[doc.id] || []).map(mapArchivo);
    return {
      tipo: doc.id,
      label: doc.label,
      required: esRequerido(doc, tipo),
      multiple: Boolean(doc.multiple),
      pideFechaNacimiento: Boolean(doc.pideFechaNacimiento),
      pideFecha: doc.pideFecha || null,
      vigenciaMeses: doc.vigenciaMeses || null,
      estado: estadoArchivos(doc, archivos),
      archivos
    };
  });
}

function progresoDe(checklist) {
  const req = checklist.filter((item) => item.required);
  const cargados = req.filter((item) => item.estado === 'cargado' || item.estado === 'por_vencer').length;
  const faltantes = Math.max(0, req.length - cargados);
  return {
    cargados,
    requeridos: req.length,
    faltantes,
    vencidos: checklist.filter((item) => item.estado === 'vencido').length,
    por_vencer: checklist.filter((item) => item.estado === 'por_vencer').length
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
      return { error: 'Indica la fecha del curso' };
    }
    return {
      fecha_documento: fechaDocumento,
      fecha_vencimiento: addMonths(fechaDocumento, def.vigenciaMeses || 24)
    };
  }
  if (def.pideFecha === 'vencimiento') {
    if (!fechaVencimientoIn) {
      return { error: 'Indica la fecha de vencimiento de la póliza' };
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
  DOC_TYPES,
  DOC_BY_ID,
  tipoPersonaValido,
  formaVinculacionValida,
  docTipoValido,
  aplicaA,
  esRequerido,
  armarChecklist,
  progresoDe,
  alertaDe,
  fechasParaAlta,
  fechaIso,
  daysUntil,
  ALERTA_DIAS
};
