require('dotenv').config();
const db = require('../utils/db-mysql');
const { hacerRespaldoCompleto } = require('../utils/respaldo');

(async () => {
  await db.initPool();
  const forzar = process.argv.includes('--force') || process.argv.includes('--forzar');
  const result = await hacerRespaldoCompleto({ forzar });
  if (result.skipped) {
    console.log(`✓ El respaldo de ${result.mes} ya existía (usa --force para repetirlo)`);
  } else {
    console.log(result.dump ? `✓ Respaldo mensual ${result.mes}: archivos y MySQL listos` : `⚠ Respaldo mensual ${result.mes}: archivos copiados, MySQL falló`);
  }
  console.log(result.dest);
  if (result.faltan) console.log(`⚠ ${result.faltan} registro(s) sin archivo en disco`);
  if (result.dumpError) console.log(`⚠ MySQL: ${result.dumpError}`);
  await db.closePool();
})().catch((err) => {
  console.error('❌ No se pudo hacer el respaldo:', err.message);
  process.exit(1);
});
