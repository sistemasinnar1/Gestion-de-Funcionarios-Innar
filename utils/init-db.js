require('dotenv').config();
const mysql = require('mysql2/promise');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { DOC_TYPES } = require('./documentos-catalogo');
const storage = require('./storage');

const DEFAULT_ADMIN_USER = 'superadmin';

function assertSafeDbName(name) {
  if (!/^[a-zA-Z0-9_]+$/.test(name)) {
    throw new Error('DB_NAME inválido');
  }
  return name;
}

async function columnExists(conn, dbName, table, column) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS n
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [dbName, table, column]
  );
  return rows[0].n > 0;
}

async function initializeDatabase() {
  const dbName = assertSafeDbName(process.env.DB_NAME || 'innar_gestion');
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT, 10) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    multipleStatements: true
  });

  await conn.query(
    `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  );
  await conn.query(`USE \`${dbName}\``);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id INT AUTO_INCREMENT PRIMARY KEY,
      usuario VARCHAR(64) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NULL,
      email VARCHAR(190) NULL,
      nombre VARCHAR(150) NOT NULL,
      rol ENUM('superadmin', 'admin', 'talento_humano', 'contabilidad', 'almacen', 'calidad')
        NOT NULL DEFAULT 'admin',
      activo TINYINT(1) NOT NULL DEFAULT 1,
      ultimo_acceso DATETIME NULL,
      creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_usuario (usuario),
      UNIQUE KEY uq_email (email)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  if (!(await columnExists(conn, dbName, 'usuarios', 'email'))) {
    await conn.query('ALTER TABLE usuarios ADD COLUMN email VARCHAR(190) NULL AFTER password_hash');
  }
  try {
    await conn.query('ALTER TABLE usuarios ADD UNIQUE KEY uq_email (email)');
  } catch (_) { /* ya existe */ }

  await conn.query(`
    CREATE TABLE IF NOT EXISTS login_attempts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      ip_address VARCHAR(45) NOT NULL,
      usuario VARCHAR(100),
      intentos_fallidos INT DEFAULT 0,
      bloqueado_hasta DATETIME,
      primer_intento DATETIME DEFAULT CURRENT_TIMESTAMP,
      ultimo_intento DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_ip (ip_address),
      INDEX idx_usuario (usuario)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS access_codes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      usuario_id INT NOT NULL,
      codigo_hash CHAR(64) NOT NULL,
      expires_at DATETIME NOT NULL,
      used_at DATETIME NULL,
      intentos INT NOT NULL DEFAULT 0,
      ip_address VARCHAR(45),
      creado_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_usuario_activo (usuario_id, used_at, expires_at),
      CONSTRAINT fk_access_codes_usuario
        FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS funcionarios (
      id INT AUTO_INCREMENT PRIMARY KEY,
      nombres VARCHAR(120) NOT NULL,
      apellidos VARCHAR(120) NOT NULL,
      documento VARCHAR(30) NOT NULL,
      cargo VARCHAR(120) NULL,
      area VARCHAR(120) NULL,
      telefono VARCHAR(30) NULL,
      correo VARCHAR(190) NULL,
      fecha_nacimiento DATE NULL,
      tipo_persona ENUM('asistencial', 'administrativo') NOT NULL DEFAULT 'administrativo',
      forma_vinculacion ENUM('contrato_trabajo', 'prestacion_servicios', 'cooperativa') NULL,
      foto_path VARCHAR(500) NULL,
      activo TINYINT(1) NOT NULL DEFAULT 1,
      creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_documento (documento),
      INDEX idx_nombre (nombres, apellidos),
      INDEX idx_cargo (cargo),
      INDEX idx_area (area),
      INDEX idx_tipo_persona (tipo_persona)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  const funcionarioCols = [
    ['telefono', 'telefono VARCHAR(30) NULL AFTER area'],
    ['correo', 'correo VARCHAR(190) NULL AFTER telefono'],
    ['fecha_nacimiento', 'fecha_nacimiento DATE NULL AFTER correo'],
    ['tipo_persona', "tipo_persona ENUM('asistencial', 'administrativo') NOT NULL DEFAULT 'administrativo' AFTER fecha_nacimiento"],
    ['forma_vinculacion', "forma_vinculacion ENUM('contrato_trabajo', 'prestacion_servicios', 'cooperativa') NULL AFTER tipo_persona"],
    ['foto_path', 'foto_path VARCHAR(500) NULL AFTER forma_vinculacion'],
    ['acudiente_nombre', 'acudiente_nombre VARCHAR(180) NULL AFTER foto_path'],
    ['acudiente_contacto', 'acudiente_contacto VARCHAR(80) NULL AFTER acudiente_nombre'],
    ['riesgo_arl', "riesgo_arl ENUM('I','II','III','IV','V') NULL AFTER acudiente_contacto"],
    ['proximo_examen_medico', 'proximo_examen_medico DATE NULL AFTER riesgo_arl'],
    ['electrodiagnostico', 'electrodiagnostico TINYINT(1) NOT NULL DEFAULT 0 AFTER proximo_examen_medico'],
    ['exige_telemedicina', 'exige_telemedicina TINYINT(1) NOT NULL DEFAULT 0 AFTER electrodiagnostico']
  ];
  for (const [name, ddl] of funcionarioCols) {
    if (!(await columnExists(conn, dbName, 'funcionarios', name))) {
      await conn.query(`ALTER TABLE funcionarios ADD COLUMN ${ddl}`);
    }
  }

  await conn.query(`
    CREATE TABLE IF NOT EXISTS cursos_certificados (
      id INT AUTO_INCREMENT PRIMARY KEY,
      funcionario_id INT NOT NULL,
      nombre VARCHAR(200) NOT NULL,
      horas DECIMAL(6,1) NULL,
      fecha_certificacion DATE NULL,
      archivo_nombre VARCHAR(255) NULL,
      archivo_path VARCHAR(500) NULL,
      subido_por INT NULL,
      creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_curso_func (funcionario_id),
      CONSTRAINT fk_curso_funcionario
        FOREIGN KEY (funcionario_id) REFERENCES funcionarios(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS documentos_adicionales (
      id INT AUTO_INCREMENT PRIMARY KEY,
      funcionario_id INT NOT NULL,
      descripcion VARCHAR(255) NOT NULL,
      archivo_nombre VARCHAR(255) NOT NULL,
      archivo_path VARCHAR(500) NOT NULL,
      subido_por INT NULL,
      creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_extra_func (funcionario_id),
      CONSTRAINT fk_extra_funcionario
        FOREIGN KEY (funcionario_id) REFERENCES funcionarios(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS contratos (
      id INT AUTO_INCREMENT PRIMARY KEY,
      funcionario_id INT NOT NULL,
      tipo ENUM('contrato', 'otrosi', 'preaviso') NOT NULL DEFAULT 'contrato',
      descripcion VARCHAR(255) NULL,
      archivo_nombre VARCHAR(255) NOT NULL,
      archivo_path VARCHAR(500) NOT NULL,
      fecha_inicio DATE NULL,
      fecha_firma DATE NULL,
      fecha_terminacion DATE NULL,
      subido_por INT NULL,
      creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_contrato_func (funcionario_id),
      INDEX idx_contrato_vence (fecha_terminacion),
      CONSTRAINT fk_contrato_funcionario
        FOREIGN KEY (funcionario_id) REFERENCES funcionarios(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  try {
    await conn.query(
      `ALTER TABLE contratos
       MODIFY COLUMN tipo ENUM('contrato', 'otrosi', 'preaviso') NOT NULL DEFAULT 'contrato'`
    );
  } catch (_) {
    /* ya está actualizado o tabla nueva */
  }

  if (!(await columnExists(conn, dbName, 'contratos', 'fecha_inicio'))) {
    await conn.query(
      'ALTER TABLE contratos ADD COLUMN fecha_inicio DATE NULL AFTER archivo_path'
    );
    await conn.query(
      `UPDATE contratos
       SET fecha_inicio = fecha_firma
       WHERE fecha_inicio IS NULL AND fecha_firma IS NOT NULL`
    );
    await conn.query(
      `UPDATE contratos SET fecha_firma = NULL WHERE fecha_inicio IS NOT NULL`
    );
    console.log('✓ Contratos: fecha_inicio migrada desde la antigua fecha_firma');
  }

  await conn.query(`
    CREATE TABLE IF NOT EXISTS vacaciones (
      id INT AUTO_INCREMENT PRIMARY KEY,
      funcionario_id INT NOT NULL,
      tipo ENUM('disfrute', 'pago') NOT NULL,
      dias DECIMAL(5,1) NOT NULL,
      fecha_inicio DATE NULL,
      fecha_fin DATE NULL,
      fecha_registro DATE NOT NULL,
      notas VARCHAR(255) NULL,
      registrado_por INT NULL,
      creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_vac_func (funcionario_id),
      INDEX idx_vac_fecha (fecha_registro),
      CONSTRAINT fk_vac_funcionario
        FOREIGN KEY (funcionario_id) REFERENCES funcionarios(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS polizas (
      id INT AUTO_INCREMENT PRIMARY KEY,
      funcionario_id INT NOT NULL,
      descripcion VARCHAR(200) NOT NULL,
      fecha_vencimiento DATE NULL,
      archivo_nombre VARCHAR(255) NOT NULL,
      archivo_path VARCHAR(500) NOT NULL,
      subido_por INT NULL,
      creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_poliza_func (funcionario_id),
      INDEX idx_poliza_vence (fecha_vencimiento),
      CONSTRAINT fk_poliza_funcionario
        FOREIGN KEY (funcionario_id) REFERENCES funcionarios(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // Migrar pólizas legacy del slot documentos → panel polizas (una sola vez por archivo).
  try {
    const [legacy] = await conn.query(
      `SELECT d.funcionario_id, d.archivo_nombre, d.archivo_path, d.fecha_vencimiento, d.subido_por
       FROM documentos d
       WHERE d.tipo = 'poliza_rc'
         AND NOT EXISTS (
           SELECT 1 FROM polizas p
           WHERE p.funcionario_id = d.funcionario_id AND p.archivo_path = d.archivo_path
         )`
    );
    for (const row of legacy) {
      await conn.execute(
        `INSERT INTO polizas (funcionario_id, descripcion, fecha_vencimiento, archivo_nombre, archivo_path, subido_por)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          row.funcionario_id,
          'Póliza de responsabilidad civil',
          row.fecha_vencimiento,
          row.archivo_nombre,
          row.archivo_path,
          row.subido_por
        ]
      );
    }
    if (legacy.length) {
      console.log(`✓ ${legacy.length} póliza(s) migrada(s) al registro de pólizas`);
    }
  } catch (_) {
    /* tabla recién creada o sin docs legacy */
  }

  await conn.query(`
    CREATE TABLE IF NOT EXISTS hojas_vida (
      id INT AUTO_INCREMENT PRIMARY KEY,
      funcionario_id INT NOT NULL,
      version INT NOT NULL,
      archivo_nombre VARCHAR(255) NOT NULL,
      archivo_path VARCHAR(500) NOT NULL,
      subido_por INT NULL,
      creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_funcionario_version (funcionario_id, version),
      CONSTRAINT fk_hv_funcionario
        FOREIGN KEY (funcionario_id) REFERENCES funcionarios(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS documentos (
      id INT AUTO_INCREMENT PRIMARY KEY,
      funcionario_id INT NOT NULL,
      tipo VARCHAR(64) NOT NULL,
      archivo_nombre VARCHAR(255) NOT NULL,
      archivo_path VARCHAR(500) NOT NULL,
      fecha_documento DATE NULL,
      fecha_vencimiento DATE NULL,
      subido_por INT NULL,
      creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_func_tipo (funcionario_id, tipo),
      CONSTRAINT fk_doc_funcionario
        FOREIGN KEY (funcionario_id) REFERENCES funcionarios(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await conn.query(`
    INSERT INTO documentos (funcionario_id, tipo, archivo_nombre, archivo_path, subido_por, creado_en)
    SELECT hv.funcionario_id, 'hoja_vida', hv.archivo_nombre, hv.archivo_path, hv.subido_por, hv.creado_en
    FROM hojas_vida hv
    WHERE NOT EXISTS (
      SELECT 1 FROM documentos d
      WHERE d.funcionario_id = hv.funcionario_id
        AND d.tipo = 'hoja_vida'
        AND d.archivo_path = hv.archivo_path
    )
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS jobs_estado (
      clave VARCHAR(64) PRIMARY KEY,
      valor VARCHAR(190) NULL,
      actualizado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS org_tareas (
      id INT AUTO_INCREMENT PRIMARY KEY,
      padre_id INT NULL,
      titulo VARCHAR(220) NOT NULL,
      detalle TEXT NULL,
      tematica VARCHAR(40) NOT NULL DEFAULT 'otro',
      urgencia TINYINT NOT NULL DEFAULT 2,
      importancia TINYINT NOT NULL DEFAULT 2,
      fecha_cumplimiento DATE NULL,
      requiere_prueba TINYINT(1) NOT NULL DEFAULT 0,
      recordar_tarde TINYINT(1) NOT NULL DEFAULT 0,
      aviso_frecuencia ENUM(
        'ninguno', 'cada_2_horas', 'cada_4_horas', 'cada_8_horas',
        'hora_fija', 'diario', 'cada_2_dias', 'semanal'
      ) NOT NULL DEFAULT 'ninguno',
      aviso_hora TINYINT NULL,
      ultimo_aviso_en DATETIME NULL,
      estado ENUM('pendiente', 'completada') NOT NULL DEFAULT 'pendiente',
      completada_en DATETIME NULL,
      completada_por INT NULL,
      justificacion TEXT NULL,
      prueba_nombre VARCHAR(255) NULL,
      prueba_path VARCHAR(500) NULL,
      creado_por INT NULL,
      creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      actualizado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_org_tarea_estado (estado, fecha_cumplimiento),
      INDEX idx_org_tarea_tema (tematica),
      INDEX idx_org_tarea_padre (padre_id),
      CONSTRAINT fk_org_tarea_padre
        FOREIGN KEY (padre_id) REFERENCES org_tareas(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  if (!(await columnExists(conn, dbName, 'org_tareas', 'aviso_frecuencia'))) {
    await conn.query(
      `ALTER TABLE org_tareas
       ADD COLUMN aviso_frecuencia ENUM(
         'ninguno', 'cada_2_horas', 'cada_4_horas', 'cada_8_horas',
         'hora_fija', 'diario', 'cada_2_dias', 'semanal'
       ) NOT NULL DEFAULT 'ninguno' AFTER recordar_tarde`
    );
    await conn.query(
      `UPDATE org_tareas SET aviso_frecuencia = 'diario' WHERE recordar_tarde = 1`
    );
    console.log('✓ org_tareas: aviso_frecuencia');
  } else {
    await conn.query(
      `ALTER TABLE org_tareas
       MODIFY COLUMN aviso_frecuencia ENUM(
         'ninguno', 'cada_2_horas', 'cada_4_horas', 'cada_8_horas',
         'hora_fija', 'diario', 'cada_2_dias', 'semanal'
       ) NOT NULL DEFAULT 'ninguno'`
    );
  }
  if (!(await columnExists(conn, dbName, 'org_tareas', 'aviso_hora'))) {
    await conn.query(
      'ALTER TABLE org_tareas ADD COLUMN aviso_hora TINYINT NULL AFTER aviso_frecuencia'
    );
    console.log('✓ org_tareas: aviso_hora');
  }
  if (!(await columnExists(conn, dbName, 'org_tareas', 'ultimo_aviso_en'))) {
    await conn.query(
      'ALTER TABLE org_tareas ADD COLUMN ultimo_aviso_en DATETIME NULL AFTER aviso_hora'
    );
    console.log('✓ org_tareas: ultimo_aviso_en');
  } else {
    await conn.query(
      'ALTER TABLE org_tareas MODIFY COLUMN ultimo_aviso_en DATETIME NULL'
    );
  }

  await conn.query(`
    CREATE TABLE IF NOT EXISTS org_agenda (
      id INT AUTO_INCREMENT PRIMARY KEY,
      titulo VARCHAR(220) NOT NULL,
      tipo VARCHAR(40) NOT NULL DEFAULT 'otro',
      detalle TEXT NULL,
      ubicacion VARCHAR(180) NULL,
      fecha DATE NOT NULL,
      periodicidad ENUM('ninguna', 'semanal', 'mensual', 'trimestral', 'anual')
        NOT NULL DEFAULT 'ninguna',
      alerta_dias INT NOT NULL DEFAULT 30,
      activo TINYINT(1) NOT NULL DEFAULT 1,
      creado_por INT NULL,
      creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      actualizado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_org_agenda_fecha (fecha, activo),
      INDEX idx_org_agenda_tipo (tipo)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS org_agenda_obs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      agenda_id INT NOT NULL,
      texto TEXT NOT NULL,
      creado_por INT NULL,
      creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_org_obs_agenda (agenda_id),
      CONSTRAINT fk_org_obs_agenda
        FOREIGN KEY (agenda_id) REFERENCES org_agenda(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  const multipleTipos = DOC_TYPES.filter((d) => d.multiple).map((d) => d.id);
  const ph = multipleTipos.map(() => '?').join(',') || "''";
  const [sobrantes] = await conn.query(
    `SELECT d.id, d.archivo_path
     FROM documentos d
     INNER JOIN (
       SELECT funcionario_id, tipo, MAX(id) AS keep_id
       FROM documentos
       WHERE tipo NOT IN (${ph})
       GROUP BY funcionario_id, tipo
       HAVING COUNT(*) > 1
     ) x ON d.funcionario_id = x.funcionario_id AND d.tipo = x.tipo
     WHERE d.id <> x.keep_id`,
    multipleTipos
  );
  if (sobrantes.length) {
    const ids = sobrantes.map((row) => row.id);
    const idPh = ids.map(() => '?').join(',');
    await conn.query(`DELETE FROM documentos WHERE id IN (${idPh})`, ids);
    sobrantes.forEach((row) => storage.borrarArchivo(row.archivo_path));
    console.log(`✓ ${sobrantes.length} archivo(s) reemplazado(s) antiguos se eliminaron`);
  }

  const adminEmail = (process.env.ADMIN_EMAIL || 'admin@innar.local').trim().toLowerCase();
  const [rows] = await conn.query('SELECT COUNT(*) AS total FROM usuarios');
  if (rows[0].total === 0) {
    const unusedHash = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 10);
    await conn.execute(
      'INSERT INTO usuarios (usuario, password_hash, email, nombre, rol) VALUES (?, ?, ?, ?, ?)',
      [DEFAULT_ADMIN_USER, unusedHash, adminEmail, 'Super Administrador', 'superadmin']
    );
    console.log('✓ Usuario inicial creado: superadmin');
  } else {
    await conn.execute(
      'UPDATE usuarios SET email = ? WHERE usuario = ?',
      [adminEmail, DEFAULT_ADMIN_USER]
    );
    console.log(`✓ ${rows[0].total} usuario(s) en la base`);
  }

  await conn.end();
  console.log(`✓ Base de datos "${dbName}" lista`);
}

if (require.main === module) {
  initializeDatabase()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('❌ Error inicializando BD:', err.message);
      process.exit(1);
    });
}

module.exports = { initializeDatabase };
