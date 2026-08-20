require('dotenv').config();
const db = require('../utils/db-mysql');
const { hacerRespaldoCompleto } = require('../utils/respaldo');

(async () => {
  await db.initPool();
  const result = await hacerRespaldoCompleto({ forzar: true });
  console.log(result.dump ? '✓ Respaldo de archivos y MySQL listo' : '✓ Respaldo de archivos listo (mysqldump no disponible)');
  console.log(result.dest);
  if (result.faltan) console.log(`⚠ ${result.faltan} registro(s) sin archivo en disco`);
  if (result.dumpError) console.log(`⚠ MySQL: ${result.dumpError}`);
  await db.closePool();
})().catch((err) => {
  console.error('❌ No se pudo hacer el respaldo:', err.message);
  process.exit(1);
});
