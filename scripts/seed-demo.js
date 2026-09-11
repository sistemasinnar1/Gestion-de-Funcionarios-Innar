/**
 * Datos de demostración para ver prórrogas, historial, opcionales y vacaciones.
 * Uso: node scripts/seed-demo.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const storage = require('../utils/storage');

const PDF = Buffer.from(
  '%PDF-1.1\n1 0 obj<<>>endobj\n2 0 obj<</Length 44>>stream\nBT /F1 12 Tf 40 750 Td (INNAR demo) Tj ET\nendstream\nendobj\n3 0 obj<</Type/Page/Parent 4 0 R/Contents 2 0 R>>endobj\n4 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n5 0 obj<</Type/Catalog/Pages 4 0 R>>endobj\nxref\n0 6\ntrailer<</Size 6/Root 5 0 R>>\nstartxref\n0\n%%EOF\n'
);

async function guardarDemo(nombre) {
  storage.ensureDirs();
  const dir = storage.documentosDir();
  const file = `demo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${nombre}`;
  const abs = path.join(dir, file);
  fs.writeFileSync(abs, PDF);
  const rel = storage.rutaRelativa(abs);
  storage.copiarAEspejo(rel);
  return { nombre: `${nombre}.pdf`, path: rel };
}

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'innar_gestion',
    dateStrings: true
  });

  const [exist] = await conn.query(
    "SELECT id FROM funcionarios WHERE documento IN ('100000001','100000002')"
  );
  if (exist.length) {
    console.log('Ya hay fichas demo (docs 100000001 / 100000002). No se duplican.');
    await conn.end();
    return;
  }

  const admin = await conn.query("SELECT id FROM usuarios WHERE usuario = 'superadmin' LIMIT 1");
  const uid = admin[0][0]?.id || null;

  // —— Trabajadora con contrato laboral (vacaciones + prórrogas) ——
  const [trab] = await conn.execute(
    `INSERT INTO funcionarios
      (nombres, apellidos, documento, cargo, area, telefono, correo, fecha_nacimiento,
       tipo_persona, forma_vinculacion, riesgo_arl, proximo_examen_medico,
       electrodiagnostico, exige_telemedicina, activo)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`,
    [
      'Diana Alejandra',
      'Benavides Ruiz (Demo)',
      '100000001',
      'Auxiliar administrativa',
      'Administrativo',
      '3001112233',
      'diana.demo@innar.local',
      '1992-04-12',
      'administrativo',
      'contrato_trabajo',
      'I',
      '2027-03-31',
      0,
      0
    ]
  );
  const idTrab = trab.insertId;

  const c1 = await guardarDemo('contrato-inicial');
  await conn.execute(
    `INSERT INTO contratos
      (funcionario_id, tipo, descripcion, archivo_nombre, archivo_path,
       fecha_inicio, fecha_firma, fecha_terminacion, subido_por)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [idTrab, 'contrato', 'Contrato inicial 2025', c1.nombre, c1.path, '2024-10-01', '2024-09-28', '2025-09-30', uid]
  );
  const c2 = await guardarDemo('otrosi-1');
  await conn.execute(
    `INSERT INTO contratos
      (funcionario_id, tipo, descripcion, archivo_nombre, archivo_path,
       fecha_inicio, fecha_firma, fecha_terminacion, subido_por)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [idTrab, 'otrosi', 'Prórroga 1', c2.nombre, c2.path, '2025-10-01', '2025-09-25', '2025-12-31', uid]
  );
  const c3 = await guardarDemo('otrosi-vigente');
  await conn.execute(
    `INSERT INTO contratos
      (funcionario_id, tipo, descripcion, archivo_nombre, archivo_path,
       fecha_inicio, fecha_firma, fecha_terminacion, subido_por)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [idTrab, 'otrosi', 'Prórroga vigente', c3.nombre, c3.path, '2026-01-01', '2025-12-20', '2026-12-31', uid]
  );

  const pOld = await guardarDemo('poliza-2024');
  await conn.execute(
    `INSERT INTO documentos
      (funcionario_id, tipo, archivo_nombre, archivo_path, fecha_documento, fecha_vencimiento, subido_por)
     VALUES (?,?,?,?,?,?,?)`,
    [idTrab, 'poliza_rc', pOld.nombre, pOld.path, '2024-01-15', '2024-12-31', uid]
  );
  const pNew = await guardarDemo('poliza-2026');
  await conn.execute(
    `INSERT INTO documentos
      (funcionario_id, tipo, archivo_nombre, archivo_path, fecha_documento, fecha_vencimiento, subido_por)
     VALUES (?,?,?,?,?,?,?)`,
    [idTrab, 'poliza_rc', pNew.nombre, pNew.path, '2026-01-10', '2027-01-10', uid]
  );

  await conn.execute(
    `INSERT INTO vacaciones
      (funcionario_id, tipo, dias, fecha_inicio, fecha_fin, fecha_registro, notas, registrado_por)
     VALUES (?,?,?,?,?,?,?,?)`,
    [idTrab, 'disfrute', 5, '2025-12-15', '2025-12-19', '2025-12-10', 'Vacaciones de fin de año (demo)', uid]
  );

  // —— Contratista: examen/recomendaciones opcionales ——
  const [cont] = await conn.execute(
    `INSERT INTO funcionarios
      (nombres, apellidos, documento, cargo, area, telefono, correo, fecha_nacimiento,
       tipo_persona, forma_vinculacion, riesgo_arl, electrodiagnostico, exige_telemedicina, activo)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1)`,
    [
      'Natalia',
      'Portillo Portilla (Demo)',
      '100000002',
      'Médica general',
      'Asistencial',
      '3004445566',
      'natalia.demo@innar.local',
      '1988-08-03',
      'asistencial',
      'prestacion_servicios',
      'III',
      0,
      0
    ]
  );
  const idCont = cont.insertId;

  const cc = await guardarDemo('contrato-ops');
  await conn.execute(
    `INSERT INTO contratos
      (funcionario_id, tipo, descripcion, archivo_nombre, archivo_path,
       fecha_inicio, fecha_firma, fecha_terminacion, subido_por)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [idCont, 'contrato', 'OPS 2026', cc.nombre, cc.path, '2026-01-15', '2026-01-10', '2026-12-15', uid]
  );

  const exam = await guardarDemo('examen-opcional');
  await conn.execute(
    `INSERT INTO documentos
      (funcionario_id, tipo, archivo_nombre, archivo_path, fecha_documento, fecha_vencimiento, subido_por)
     VALUES (?,?,?,?,?,?,?)`,
    [idCont, 'examen_medico', exam.nombre, exam.path, '2025-06-01', null, uid]
  );

  // Tarea demo organizador
  await conn.execute(
    `INSERT INTO org_tareas
      (titulo, detalle, tematica, urgencia, importancia, fecha_cumplimiento, estado, creado_por)
     VALUES (?,?,?,?,?,?, 'pendiente', ?)`,
    [
      'Revisar prórrogas del personal (demo)',
      'Solo debe alertar la última vigencia de cada ficha.',
      'juridico',
      3,
      3,
      '2026-09-12',
      uid
    ]
  ).catch(() => {});

  await conn.end();
  console.log('✓ Demo lista:');
  console.log('  - Diana Alejandra Benavides Ruiz (Demo) — contrato laboral, prórrogas, pólizas 2024/2026, vacaciones');
  console.log('  - Natalia Portillo Portilla (Demo) — contratista; examen opcional');
  console.log('Abre http://localhost:3001 → Hojas de vida');
}

main().catch((err) => {
  console.error('❌', err.message);
  process.exit(1);
});
