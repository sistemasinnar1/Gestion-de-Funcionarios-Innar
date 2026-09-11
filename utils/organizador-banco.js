const db = require('./db-mysql');
const {
  fechaIso,
  estadoFecha,
  CONTRATO_ALERTA_DIAS,
  ALERTA_DIAS,
  elegirTerminacion,
  fechasTerminacionParaAlerta
} = require('./documentos-catalogo');

function nombreDe(row) {
  return `${row.nombres || ''} ${row.apellidos || ''}`.trim();
}

async function eventosDesdeBanco() {
  const items = [];
  try {
    const personas = await db.query(
      `SELECT id, nombres, apellidos, fecha_nacimiento, forma_vinculacion, proximo_examen_medico
       FROM funcionarios WHERE activo = 1`
    );
    personas.forEach((p) => {
      const nombre = nombreDe(p);
      if (p.forma_vinculacion === 'contrato_trabajo' && p.proximo_examen_medico) {
        const fecha = fechaIso(p.proximo_examen_medico);
        items.push({
          id: `banco-examen-${p.id}`,
          fuente: 'banco',
          tipo: 'otro',
          tipo_label: 'Examen médico ocupacional',
          titulo: `Examen periódico — ${nombre}`,
          detalle: 'Viene del banco de hojas de vida',
          fecha,
          periodicidad: 'ninguna',
          alerta_dias: ALERTA_DIAS,
          fecha_estado: estadoFecha(fecha, ALERTA_DIAS),
          editable: false
        });
      }
      const nac = fechaIso(p.fecha_nacimiento);
      if (nac) {
        const parts = nac.split('-');
        const now = new Date();
        let next = new Date(now.getFullYear(), Number(parts[1]) - 1, Number(parts[2]));
        if (next < new Date(now.getFullYear(), now.getMonth(), now.getDate())) {
          next = new Date(now.getFullYear() + 1, Number(parts[1]) - 1, Number(parts[2]));
        }
        const y = next.getFullYear();
        const m = String(next.getMonth() + 1).padStart(2, '0');
        const d = String(next.getDate()).padStart(2, '0');
        const fecha = `${y}-${m}-${d}`;
        const days = Math.round((next - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000);
        if (days >= 0 && days <= 14) {
          items.push({
            id: `banco-cumple-${p.id}`,
            fuente: 'banco',
            tipo: 'otro',
            tipo_label: 'Cumpleaños',
            titulo: `Cumpleaños — ${nombre}`,
            detalle: 'Viene del banco de hojas de vida',
            fecha,
            periodicidad: 'anual',
            alerta_dias: 7,
            fecha_estado: estadoFecha(fecha, 7),
            editable: false
          });
        }
      }
    });

    const contratos = await db.query(
      `SELECT c.id, c.funcionario_id, c.tipo, c.descripcion, c.fecha_terminacion, f.nombres, f.apellidos
       FROM contratos c
       INNER JOIN funcionarios f ON f.id = c.funcionario_id
       WHERE f.activo = 1 AND c.fecha_terminacion IS NOT NULL`
    );
    const byPerson = {};
    contratos.forEach((c) => {
      if (!byPerson[c.funcionario_id]) byPerson[c.funcionario_id] = [];
      byPerson[c.funcionario_id].push(c);
    });
    Object.keys(byPerson).forEach((fid) => {
      const lista = byPerson[fid];
      const ultimaFin = elegirTerminacion(fechasTerminacionParaAlerta(lista));
      if (!ultimaFin) return;
      const st = estadoFecha(ultimaFin, CONTRATO_ALERTA_DIAS);
      if (st !== 'vencido' && st !== 'por_vencer') return;
      const c = lista
        .filter((row) => row.tipo !== 'preaviso' && fechaIso(row.fecha_terminacion) === ultimaFin)
        .sort((a, b) => Number(b.id) - Number(a.id))[0] || lista[0];
      items.push({
        id: `banco-contrato-${fid}`,
        fuente: 'banco',
        tipo: 'otro',
        tipo_label: c.tipo === 'otrosi' ? 'Otrosí laboral' : 'Contrato laboral',
        titulo: `${c.tipo === 'otrosi' ? 'Otrosí' : 'Contrato'} — ${nombreDe(c)}`,
        detalle: c.descripcion || 'Última vigencia (prórrogas anteriores no se alertan)',
        fecha: ultimaFin,
        periodicidad: 'ninguna',
        alerta_dias: CONTRATO_ALERTA_DIAS,
        fecha_estado: st,
        editable: false
      });
    });

    const docs = await db.query(
      `SELECT d.id, d.funcionario_id, d.tipo, d.fecha_vencimiento, d.archivo_nombre, f.nombres, f.apellidos
       FROM documentos d
       INNER JOIN funcionarios f ON f.id = d.funcionario_id
       WHERE f.activo = 1 AND d.fecha_vencimiento IS NOT NULL
       ORDER BY d.id DESC`
    );
    const latestDoc = {};
    docs.forEach((d) => {
      const key = `${d.funcionario_id}:${d.tipo}`;
      if (!latestDoc[key]) latestDoc[key] = d;
    });
    Object.values(latestDoc).forEach((d) => {
      const fecha = fechaIso(d.fecha_vencimiento);
      const st = estadoFecha(fecha, ALERTA_DIAS);
      if (st !== 'vencido' && st !== 'por_vencer') return;
      const labels = {
        poliza_rc: 'Póliza de responsabilidad civil',
        curso_violencia_sexual: 'Curso de violencia sexual',
        curso_soporte_vital: 'Soporte vital',
        curso_duelo: 'Gestión de duelo',
        curso_telemedicina: 'Telemedicina'
      };
      items.push({
        id: `banco-doc-${d.funcionario_id}-${d.tipo}`,
        fuente: 'banco',
        tipo: 'otro',
        tipo_label: labels[d.tipo] || 'Documento del personal',
        titulo: `${labels[d.tipo] || d.tipo} — ${nombreDe(d)}`,
        detalle: d.archivo_nombre || 'Vigencia actual (historiales anteriores no se alertan)',
        fecha,
        periodicidad: 'ninguna',
        alerta_dias: ALERTA_DIAS,
        fecha_estado: st,
        editable: false
      });
    });
  } catch (err) {
    /* si el banco aún no tiene tablas, el organizador sigue */
  }
  return items;
}

module.exports = { eventosDesdeBanco };
