// Resolución de afiliación sindical por fecha (histórico) para la liquidación.
// Un empleado está afiliado en una fecha F si tiene un período con desde <= F y
// (hasta IS NULL o hasta >= F). Se usa para los aportes/contribuciones solidarias.
import { query } from '../db.js';

// Fecha de referencia del período liquidado: último día del mes (la afiliación debe
// estar abierta a esa fecha para considerarse vigente durante el período).
export function fechaRefPeriodo(anio, mes) {
  const y = Number(anio), m = Number(mes);
  const ultimo = new Date(y, m, 0).getDate();
  return `${y}-${String(m).padStart(2, '0')}-${String(ultimo).padStart(2, '0')}`;
}

// ¿El empleado está afiliado a la fecha de referencia del período?
export async function afiliadoEnFecha(empleadoId, anio, mes) {
  const f = fechaRefPeriodo(anio, mes);
  const r = await query(
    `SELECT 1 FROM afiliaciones_sindicales
      WHERE empleado_id = $1 AND desde <= $2::date AND (hasta IS NULL OR hasta >= $2::date)
      LIMIT 1`, [empleadoId, f]);
  return r.rows.length > 0;
}

// Bulk para la corrida: Set con los IDs afiliados a la fecha del período (evita N+1).
export async function afiliadosEnFecha(ids, anio, mes) {
  const s = new Set();
  if (!ids || !ids.length) return s;
  const f = fechaRefPeriodo(anio, mes);
  const r = await query(
    `SELECT DISTINCT empleado_id FROM afiliaciones_sindicales
      WHERE empleado_id = ANY($1) AND desde <= $2::date AND (hasta IS NULL OR hasta >= $2::date)`,
    [ids, f]);
  for (const row of r.rows) s.add(row.empleado_id);
  return s;
}
