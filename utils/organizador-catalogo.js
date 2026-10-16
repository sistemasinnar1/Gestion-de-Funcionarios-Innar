const { fechaIso, daysUntil, estadoFecha, ALERTA_DIAS, CONTRATO_ALERTA_DIAS } = require('./documentos-catalogo');

const TEMATICAS = {
  calidad: 'Calidad',
  talento_humano: 'Talento humano',
  juridico: 'Jurídico / contratos',
  financiero: 'Financiero / impuestos',
  mantenimiento: 'Mantenimiento',
  direccion: 'Dirección',
  otro: 'Otra'
};

const NIVELES = {
  1: 'Baja',
  2: 'Media',
  3: 'Alta',
  4: 'Crítica'
};

const TIPOS_AGENDA = {
  nomina: { label: 'Pago de nómina', alerta: 2 },
  pila: { label: 'Pago de la PILA', alerta: 2 },
  seguridad: { label: 'Pago de seguridad', alerta: 2 },
  servicios: { label: 'Pago de servicios', alerta: 2 },
  nomina_pila: { label: 'Nómina y PILA', alerta: 2 },
  impuesto_servicio: { label: 'Impuestos, tasas y servicios', alerta: 30 },
  poliza: { label: 'Vencimiento de póliza', alerta: 30 },
  insumo: { label: 'Insumo, dispositivo o pipeta', alerta: 30 },
  mantenimiento_biomedico: { label: 'Mantenimiento de equipo biomédico', alerta: 30 },
  mantenimiento_edificio: { label: 'Mantenimiento del edificio', alerta: 30 },
  ascensor: { label: 'Ascensor', alerta: 30 },
  equipo_edificio: { label: 'Equipo del edificio (UPS, planta, portón, cámaras…)', alerta: 30 },
  comite: { label: 'Comité / reunión', alerta: 7 },
  extintor: { label: 'Recarga de extintores', alerta: 30 },
  informe: { label: 'Informe a contratante / autoridad', alerta: 14 },
  otro: { label: 'Otro evento de calidad', alerta: 30 }
};

const PERIODICIDADES = {
  ninguna: 'Sin repetición',
  semanal: 'Cada semana',
  mensual: 'Cada mes (el mismo día)',
  trimestral: 'Cada 3 meses',
  anual: 'Cada año',
  cada_5_anios: 'Cada 5 años',
  cada_7_anios: 'Cada 7 años',
  cada_10_anios: 'Cada 10 años'
};

const AVISO_FRECUENCIAS = {
  ninguno: 'Sin aviso por correo',
  cada_2_horas: 'Cada 2 horas',
  cada_4_horas: 'Cada 4 horas',
  cada_8_horas: 'Cada 8 horas',
  hora_fija: 'Diario a una hora fija',
  diario: 'Diario',
  cada_2_dias: 'Cada 2 días',
  semanal: 'Cada semana'
};

const AVISO_FRECUENCIAS_ENUM = Object.keys(AVISO_FRECUENCIAS);

function avisoFrecuenciaValida(value) {
  return Boolean(AVISO_FRECUENCIAS[value]);
}

function horasAvisoFrecuencia(value) {
  if (value === 'cada_2_horas') return 2;
  if (value === 'cada_4_horas') return 4;
  if (value === 'cada_8_horas') return 8;
  return 0;
}

function diasAvisoFrecuencia(value) {
  if (value === 'diario') return 1;
  if (value === 'cada_2_dias') return 2;
  if (value === 'semanal') return 7;
  return 0;
}

function avisoHoraValida(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : null;
}

function avisoUsaHoraFija(value) {
  return value === 'hora_fija' || value === 'diario' || value === 'cada_2_dias' || value === 'semanal';
}

function tematicaValida(value) {
  return Boolean(TEMATICAS[value]);
}

function tipoAgendaValido(value) {
  return Boolean(TIPOS_AGENDA[value]);
}

function periodicidadValida(value) {
  return Boolean(PERIODICIDADES[value]);
}

function nivel(value, fallback = 2) {
  const n = parseInt(value, 10);
  return n >= 1 && n <= 4 ? n : fallback;
}

function cuadrante(urgencia, importancia) {
  const u = nivel(urgencia) >= 3;
  const i = nivel(importancia) >= 3;
  if (u && i) return { id: 'hacer', label: 'Hacer ahora' };
  if (!u && i) return { id: 'planear', label: 'Planear' };
  if (u && !i) return { id: 'atender', label: 'Atender pronto' };
  return { id: 'cuando', label: 'Cuando se pueda' };
}

function toIsoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseIsoDate(iso) {
  const raw = fechaIso(iso);
  if (!raw) return null;
  const [y, m, d] = raw.split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

function addMonthsClamped(iso, months, anchorDay) {
  const dt = parseIsoDate(iso);
  if (!dt) return null;
  const day = anchorDay || dt.getDate();
  const target = new Date(dt.getFullYear(), dt.getMonth() + months, 1);
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(day, last));
  return toIsoDate(target);
}

function mesesDePeriodicidad(periodicidad) {
  if (periodicidad === 'mensual') return 1;
  if (periodicidad === 'trimestral') return 3;
  if (periodicidad === 'anual') return 12;
  if (periodicidad === 'cada_5_anios') return 60;
  if (periodicidad === 'cada_7_anios') return 84;
  if (periodicidad === 'cada_10_anios') return 120;
  return 0;
}

function addPeriodo(iso, periodicidad, ancla) {
  const dt = parseIsoDate(iso);
  if (!dt) return null;
  if (periodicidad === 'semanal') {
    dt.setDate(dt.getDate() + 7);
    return toIsoDate(dt);
  }
  const meses = mesesDePeriodicidad(periodicidad);
  if (!meses) return fechaIso(iso);
  const anchorDay = parseIsoDate(ancla || iso)?.getDate() || dt.getDate();
  return addMonthsClamped(iso, meses, anchorDay);
}

function ocurrenciasEntre(iso, periodicidad, desde, hasta) {
  const ancla = fechaIso(iso);
  const start = fechaIso(desde);
  const end = fechaIso(hasta);
  if (!ancla || !start || !end || start > end) return [];
  if (!periodicidad || periodicidad === 'ninguna') {
    return ancla >= start && ancla <= end ? [ancla] : [];
  }
  let cursor = ancla < start ? avanzarHastaFuturo(ancla, periodicidad, start) : ancla;
  const out = [];
  let guard = 0;
  while (cursor && cursor <= end && guard < 600) {
    if (cursor >= start) out.push(cursor);
    const next = addPeriodo(cursor, periodicidad, ancla);
    if (!next || next <= cursor) break;
    cursor = next;
    guard += 1;
  }
  return out;
}

function avanzarHastaFuturo(iso, periodicidad, hoy) {
  const today = fechaIso(hoy) || toIsoDate(new Date());
  const ancla = fechaIso(iso);
  if (!ancla) return null;
  if (!periodicidad || periodicidad === 'ninguna') return ancla;
  let actual = ancla;
  let guard = 0;
  while (actual && actual < today && guard < 2000) {
    const next = addPeriodo(actual, periodicidad, ancla);
    if (!next || next === actual) break;
    actual = next;
    guard += 1;
  }
  return actual;
}

function enriquecerTarea(row) {
  const urgencia = nivel(row.urgencia);
  const importancia = nivel(row.importancia);
  const q = cuadrante(urgencia, importancia);
  const fecha = fechaIso(row.fecha_cumplimiento);
  const stFecha = fecha ? estadoFecha(fecha, ALERTA_DIAS) : 'sin_fecha';
  const aviso = avisoFrecuenciaValida(row.aviso_frecuencia)
    ? row.aviso_frecuencia
    : (Number(row.recordar_tarde) === 1 ? 'diario' : 'ninguno');
  return {
    ...row,
    urgencia,
    importancia,
    urgencia_label: NIVELES[urgencia],
    importancia_label: NIVELES[importancia] === 'Crítica' ? 'Esencial' : NIVELES[importancia],
    tematica_label: TEMATICAS[row.tematica] || row.tematica,
    cuadrante: q.id,
    cuadrante_label: q.label,
    fecha_cumplimiento: fecha,
    fecha_estado: stFecha,
    aviso_frecuencia: aviso,
    aviso_frecuencia_label: AVISO_FRECUENCIAS[aviso] || AVISO_FRECUENCIAS.ninguno,
    aviso_hora: avisoUsaHoraFija(aviso) ? (avisoHoraValida(row.aviso_hora) ?? 12) : null
  };
}

function enriquecerEvento(row, hoy) {
  const today = fechaIso(hoy) || toIsoDate(new Date());
  const tipo = TIPOS_AGENDA[row.tipo] || TIPOS_AGENDA.otro;
  const alerta = Number(row.alerta_dias) > 0 ? Number(row.alerta_dias) : tipo.alerta;
  const periodicidad = periodicidadValida(row.periodicidad) ? row.periodicidad : 'ninguna';
  const ancla = fechaIso(row.fecha);
  const fecha = periodicidad === 'ninguna'
    ? ancla
    : avanzarHastaFuturo(ancla, periodicidad, today);
  const st = fecha ? estadoFecha(fecha, alerta) : 'sin_fecha';
  return {
    ...row,
    fuente: row.fuente || 'agenda',
    tipo_label: tipo.label,
    periodicidad,
    periodicidad_label: PERIODICIDADES[periodicidad],
    alerta_dias: alerta,
    fecha,
    fecha_base: ancla,
    fecha_estado: st,
    editable: row.fuente !== 'banco' && row.fuente !== 'tarea'
  };
}

module.exports = {
  TEMATICAS,
  NIVELES,
  TIPOS_AGENDA,
  PERIODICIDADES,
  AVISO_FRECUENCIAS,
  AVISO_FRECUENCIAS_ENUM,
  ALERTA_DIAS,
  CONTRATO_ALERTA_DIAS,
  tematicaValida,
  tipoAgendaValido,
  periodicidadValida,
  avisoFrecuenciaValida,
  horasAvisoFrecuencia,
  diasAvisoFrecuencia,
  avisoHoraValida,
  avisoUsaHoraFija,
  nivel,
  cuadrante,
  addPeriodo,
  avanzarHastaFuturo,
  ocurrenciasEntre,
  enriquecerTarea,
  enriquecerEvento,
  fechaIso,
  daysUntil,
  estadoFecha,
  toIsoDate
};
