// Runner de migraciones: aplica schema.sql y luego las migraciones idempotentes
// (mismas que corren al iniciar el server), para que `npm run migrate` deje la
// base completa. Con --reset, dropea las tablas primero (solo para desarrollo).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const reset = process.argv.includes('--reset');

async function main() {
  if (reset) {
    console.log('[migrate] --reset: dropeando tablas…');
    await pool.query('DROP TABLE IF EXISTS empleados CASCADE; DROP TABLE IF EXISTS empresas CASCADE;');
  }
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('[migrate] esquema aplicado ✓');

  // Migraciones idempotentes posteriores al schema (claves foráneas, correlativo, puestos).
  try {
    const { migrarFKs } = await import('./migrateFKs.js');
    const r = await migrarFKs();
    console.log(`[migrate] claves foráneas verificadas ✓ (${r.agregadas} agregadas)`);
  } catch (e) { console.error('[migrate] FKs:', e.message); }

  try {
    const { migrarRecibosCorrelativo } = await import('./migrateRecibosCorrelativo.js');
    const r = await migrarRecibosCorrelativo();
    if (r.cambiado) console.log('[migrate] índice de recibos actualizado (correlativo) ✓');
  } catch (e) { console.error('[migrate] correlativo:', e.message); }

  try {
    const { migrarPuestos } = await import('./migratePuestos.js');
    const r = await migrarPuestos();
    if (!r.skip) console.log(`[migrate] puestos sembrados ✓ (${r.creados})`);
  } catch (e) { console.error('[migrate] puestos:', e.message); }

  await pool.end();
}

main().catch((e) => { console.error('[migrate] error:', e); process.exit(1); });
