import { query } from '../db.js';

// Registra en config_hist los cambios de un registro de configuración.
// fields: array de [clave, etiqueta]. before/after: objetos ya mapeados (o null en alta).
export async function logCambios(modulo, ref, before, after, fields, actor) {
  try {
    if (!before) {
      await query('INSERT INTO config_hist (modulo, ref, campo, valor_anterior, valor_nuevo, actor_dni) VALUES ($1,$2,$3,$4,$5,$6)',
        [modulo, String(ref || ''), 'Alta', null, String((after && (after.nombre ?? after.descripcion)) ?? ref ?? ''), actor || null]);
      return;
    }
    for (const [k, label] of fields) {
      const b = before[k] == null ? '' : String(before[k]);
      const a = after[k] == null ? '' : String(after[k]);
      if (b !== a) {
        await query('INSERT INTO config_hist (modulo, ref, campo, valor_anterior, valor_nuevo, actor_dni) VALUES ($1,$2,$3,$4,$5,$6)',
          [modulo, String(ref || ''), label, b || null, a || null, actor || null]);
      }
    }
  } catch { /* no romper el guardado */ }
}

export async function historialDe(modulo, ref) {
  const cond = ['modulo=$1']; const args = [modulo];
  if (ref) { args.push(ref); cond.push(`ref=$${args.length}`); }
  const { rows } = await query(
    `SELECT id, ref, campo, valor_anterior, valor_nuevo, actor_dni, created_at FROM config_hist WHERE ${cond.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT 300`, args);
  return rows;
}
