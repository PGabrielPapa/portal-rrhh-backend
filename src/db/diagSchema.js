// Diagnóstico: aplica el schema y lista, de forma legible, cada sentencia que falla
// con su error COMPLETO. Uso:  node src/db/diagSchema.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../db.js';
import { aplicarSchema } from './applySchema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
const r = await aplicarSchema(pool, sql);

console.log(`\n===== DIAGNÓSTICO DE SCHEMA =====`);
console.log(`Total sentencias: ${r.total} · OK: ${r.ok} · con error: ${r.errores.length}\n`);
if (!r.errores.length) {
  console.log('✓ Sin errores. Todas las tablas/objetos se aplicaron correctamente.');
} else {
  r.errores.forEach((e, n) => {
    console.log(`----- ERROR ${n + 1} -----`);
    console.log(`MENSAJE : ${e.error}`);
    console.log(`SENTENCIA: ${e.sql}`);
    console.log('');
  });
}
// Chequeo puntual de los objetos del workflow efectivo:
try {
  const cols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name IN ('anticipos','licencias') AND column_name='workflow'`);
  const tabs = await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_name IN ('anticipo_aprobaciones','licencia_aprobaciones','workflows','unidades_org','posiciones')`);
  console.log('Columnas workflow presentes:', cols.rows.map((x) => x.table_name).join(', ') || '(ninguna)');
  console.log('Tablas presentes:', tabs.rows.map((x) => x.table_name).join(', ') || '(ninguna)');
} catch (e) { console.log('No se pudo consultar el catálogo:', e.message); }
await pool.end();
