require('dotenv').config();
const mysql = require('mysql2/promise');

let pool = null;

async function initPool() {
  if (pool) return pool;

  pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT, 10) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'innar_gestion',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 50,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
    charset: 'utf8mb4',
    dateStrings: true,
    timezone: process.env.DB_TIMEZONE || '-05:00'
  });

  pool.on('connection', (connection) => {
    connection.query('SET time_zone = ?', [process.env.DB_TIMEZONE || '-05:00'], () => {});
  });

  console.log(`✓ Pool MySQL: ${process.env.DB_HOST}:${process.env.DB_PORT || 3306}`);
  return pool;
}

function assertPool(op) {
  if (!pool) {
    throw new Error(`[db-mysql] Pool no inicializado al ejecutar ${op}.`);
  }
}

async function query(sql, params = []) {
  assertPool('query');
  const [rows] = await pool.execute(sql, params);
  return rows;
}

async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

async function execute(sql, params = []) {
  assertPool('execute');
  const [result] = await pool.execute(sql, params);
  return result;
}

async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = { initPool, query, queryOne, execute, closePool, getPool: () => pool };
