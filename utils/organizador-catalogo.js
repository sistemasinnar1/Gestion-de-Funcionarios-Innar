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
  mantenimiento_biomedico: { label: 'Mantenimiento / calibración biomédica', alerta: 30 },
  mantenimiento_edificio: { label: 'Mantenimiento del edificio', alerta: 30 },
  comite: { label: 'Comité / reunión', alerta: 7 },
  impuesto_servicio: { label: 'Impuestos, tasas y servicios', alerta: 30 },
  extintor: { label: 'Recarga de extintores', alerta: 30 },
  informe: { label: 'Informe a contratante / autoridad', alerta: 14 },
  nomina_pila: { label: 'Nómina y PILA', alerta: 5 },
  otro: { label: 'Otro evento de calidad', alerta: 30 }
};

const PERIODICIDADES = {
  ninguna: 'Sin repetición',
  semanal: 'Cada semana',
  mensual: 'Cada mes',
  trimestral: 'Cada 3 meses',
  anual: 'Cada año'
};

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

function addPeriodo(iso, periodicidad) {
  const dt = parseIsoDate(iso);
  if (!dt) return null;
  if (periodicidad === 'semanal') dt.setDate(dt.getDate() + 7);
  else if (periodicidad === 'mensual') dt.setMonth(dt.getMonth() + 1);
  else if (periodicidad === 'trimestral') dt.setMonth(dt.getMonth() + 3);
  else if (periodicidad === 'anual') dt.setFullYear(dt.getFullYear() + 1);
  else return fechaIso(iso);
  return toIsoDate(dt);
}

function avanzarHastaFuturo(iso, periodicidad, hoy) {
  const today = fechaIso(hoy) || toIsoDate(new Date());
  if (!iso) return null;
  if (!periodicidad || periodicidad === 'ninguna') return fechaIso(iso);
  let actual = fechaIso(iso);
  let guard = 0;
  while (actual && actual < today && guard < 400) {
    const next = addPeriodo(actual, periodicidad);
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
    fecha_estado: stFecha
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
    : (ancla && ancla >= today ? ancla : ancla);
  const st = fecha ? estadoFecha(fecha, alerta) : 'sin_fecha';
  return {
    ...row,
    fuente: row.fuente || 'agenda',
    tipo_label: tipo.label,
    periodicidad,
    periodicidad_label: PERIODICIDADES[periodicidad],
    alerta_dias: alerta,
    fecha,
    fecha_estado: st,
    editable: row.fuente !== 'banco'
  };
}

module.exports = {
  TEMATICAS,
  NIVELES,
  TIPOS_AGENDA,
  PERIODICIDADES,
  ALERTA_DIAS,
  CONTRATO_ALERTA_DIAS,
  tematicaValida,
  tipoAgendaValido,
  periodicidadValida,
  nivel,
  cuadrante,
  addPeriodo,
  avanzarHastaFuturo,
  enriquecerTarea,
  enriquecerEvento,
  fechaIso,
  daysUntil,
  estadoFecha,
  toIsoDate
};
