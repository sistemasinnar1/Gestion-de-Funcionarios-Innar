const { fechaIso, addMonths, hoyIsoLocal } = require('./documentos-catalogo');

const DIAS_POR_ANIO = 15;
const CADUCIDAD_ANIOS = 2;
const MAX_DIAS_PAGO = 9;

function aniosCompletosDesde(inicioIso, hoyIso = hoyIsoLocal()) {
  const inicio = fechaIso(inicioIso);
  const hoy = fechaIso(hoyIso);
  if (!inicio || !hoy || hoy < inicio) return 0;
  const [yi, mi, di] = inicio.split('-').map(Number);
  const [yh, mh, dh] = hoy.split('-').map(Number);
  let anios = yh - yi;
  if (mh < mi || (mh === mi && dh < di)) anios -= 1;
  return Math.max(0, anios);
}

function aniversario(inicioIso, anios) {
  return addMonths(fechaIso(inicioIso), anios * 12);
}

/**
 * Calcula saldo de vacaciones para contrato laboral.
 * - Tras 1 año continuo: 15 días por cada año cumplido.
 * - Caducan a los 2 años del devengo.
 * - Se pueden registrar disfrute y pago (máx. 9 días pagados en total pendientes de política).
 */
function calcularVacaciones({ forma_vinculacion, fecha_inicio_continuidad, movimientos = [], hoy = hoyIsoLocal() }) {
  const vacio = {
    aplica: false,
    sugerencia: null,
    anios_continuos: 0,
    fecha_inicio_continuidad: null,
    dias_devengados: 0,
    dias_caducados: 0,
    dias_disfrutados: 0,
    dias_pagados: 0,
    dias_pendientes: 0,
    max_pago_restante: 0,
    periodos: []
  };

  if (forma_vinculacion !== 'contrato_trabajo') return vacio;
  const inicio = fechaIso(fecha_inicio_continuidad);
  if (!inicio) {
    return {
      ...vacio,
      aplica: true,
      sugerencia: 'Registra el contrato laboral con fecha de inicio para calcular vacaciones.'
    };
  }

  const anios = aniosCompletosDesde(inicio, hoy);
  const periodos = [];
  for (let n = 1; n <= anios; n += 1) {
    const fechaDevengo = aniversario(inicio, n);
    const fechaCaduca = addMonths(fechaDevengo, CADUCIDAD_ANIOS * 12);
    const caducado = fechaCaduca && fechaCaduca <= hoy;
    periodos.push({
      anio: n,
      fecha_devengo: fechaDevengo,
      fecha_caduca: fechaCaduca,
      dias: DIAS_POR_ANIO,
      caducado,
      restantes: caducado ? 0 : DIAS_POR_ANIO
    });
  }

  const movs = (movimientos || [])
    .map((m) => ({
      tipo: m.tipo,
      dias: Number(m.dias) || 0,
      fecha: fechaIso(m.fecha_registro) || fechaIso(m.fecha_inicio) || hoy
    }))
    .filter((m) => m.dias > 0)
    .sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)));

  let diasDisfrutados = 0;
  let diasPagados = 0;
  movs.forEach((m) => {
    let porConsumir = m.dias;
    if (m.tipo === 'pago') diasPagados += m.dias;
    if (m.tipo === 'disfrute') diasDisfrutados += m.dias;
    periodos.forEach((p) => {
      if (porConsumir <= 0 || p.restantes <= 0) return;
      if (m.fecha < p.fecha_devengo) return;
      if (p.fecha_caduca && m.fecha >= p.fecha_caduca) return;
      const toma = Math.min(p.restantes, porConsumir);
      p.restantes -= toma;
      porConsumir -= toma;
    });
  });

  const diasDevengados = periodos.reduce((s, p) => s + p.dias, 0);
  const diasCaducados = periodos
    .filter((p) => p.caducado)
    .reduce((s, p) => s + p.restantes, 0);
  const diasPendientes = periodos
    .filter((p) => !p.caducado)
    .reduce((s, p) => s + p.restantes, 0);
  const maxPagoRestante = Math.max(0, Math.min(MAX_DIAS_PAGO - diasPagados, diasPendientes));

  let sugerencia = null;
  if (anios < 1) {
    sugerencia = 'Al cumplir 1 año continuo de contrato laboral se generan 15 días de vacaciones.';
  } else if (diasPendientes > 0) {
    sugerencia = `Tiene ${diasPendientes} día(s) de vacaciones pendientes (15 por cada año cumplido; caducan a los 2 años).`;
  } else if (anios >= 1) {
    sugerencia = 'No hay días de vacaciones pendientes por registrar.';
  }

  return {
    aplica: true,
    sugerencia,
    anios_continuos: anios,
    fecha_inicio_continuidad: inicio,
    dias_devengados: diasDevengados,
    dias_caducados: diasCaducados,
    dias_disfrutados: diasDisfrutados,
    dias_pagados: diasPagados,
    dias_pendientes: Math.max(0, Number(diasPendientes.toFixed(1))),
    max_pago_restante: Math.max(0, Number(maxPagoRestante.toFixed(1))),
    max_dias_pago: MAX_DIAS_PAGO,
    dias_por_anio: DIAS_POR_ANIO,
    periodos
  };
}

function fechaInicioContinuidad(contratos) {
  const fechas = (contratos || [])
    .filter((c) => c && c.tipo !== 'preaviso')
    .map((c) => fechaIso(c.fecha_inicio) || fechaIso(c.fecha_firma))
    .filter(Boolean)
    .sort();
  return fechas[0] || null;
}

module.exports = {
  DIAS_POR_ANIO,
  CADUCIDAD_ANIOS,
  MAX_DIAS_PAGO,
  calcularVacaciones,
  fechaInicioContinuidad,
  aniosCompletosDesde
};
