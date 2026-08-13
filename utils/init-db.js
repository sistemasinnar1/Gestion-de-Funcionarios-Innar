require('dotenv').config();
const mysql = require('mysql2/promise');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

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
      `UPDATE usuarios
       SET email = ?
       WHERE usuario = ? AND (email IS NULL OR email = '')`,
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
