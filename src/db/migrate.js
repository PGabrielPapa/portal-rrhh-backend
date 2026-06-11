// Runner de migraciones simple: ejecuta schema.sql. Con --reset, dropea las
// tablas primero (solo para desarrollo).
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
  await pool.end();
}

main().catch((e) => { console.error('[migrate] error:', e); process.exit(1); });
