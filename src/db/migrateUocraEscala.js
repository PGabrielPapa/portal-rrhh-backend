// Siembra inicial de la escala de jornal UOCRA desde src/data/uocra_escala.seed.json.
// Idempotente: usa ON CONFLICT DO NOTHING, así una carga/edición manual posterior
// (desde la pantalla de escalas) NO se pisa al reiniciar.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '../db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function migrarUocraEscala() {
  let filas;
  try {
    const raw = fs.readFileSync(path.join(__dirname, '..', 'data', 'uocra_escala.seed.json'), 'utf8');
    filas = JSON.parse(raw);
  } catch (e) {
    return { skip: true, motivo: 'seed no encontrado' };
  }
  let creadas = 0;
  for (const f of filas) {
    const r = await query(
      `INSERT INTO uocra_escala (vigencia, cct, categoria, zona, valor_hora, mensual, snr)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (vigencia, cct, categoria, zona) DO NOTHING`,
      [f.vigencia, f.cct || '76/75', f.categoria, f.zona || 'A',
       f.valorHora ?? null, f.mensual ?? null, f.snr ?? 0]);
    creadas += r.rowCount || 0;
  }
  return { skip: false, creadas };
}
