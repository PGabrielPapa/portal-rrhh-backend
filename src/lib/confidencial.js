import { query } from '../db.js';

// ¿El usuario logueado puede ver los legajos confidenciales?
// - admin y RR.HH. (gerencia): siempre.
// - resto (gerentes de área, empleados): solo si fueron designados
//   (su propio legajo tiene data.verConfidenciales = true).
export async function puedeVerConfidenciales(user) {
  if (!user) return false;
  if (user.role === 'admin' || user.role === 'rrhh') return true;
  try {
    const r = await query("SELECT (data->>'verConfidenciales') AS v FROM empleados WHERE id=$1", [user.id]);
    return String(r.rows?.[0]?.v || '').toLowerCase() === 'true';
  } catch { return false; }
}

// ¿Puede administrar la confidencialidad (marcar legajos y designar personas)?
// Solo admin y RR.HH.
export function puedeGestionarConfidenciales(user) {
  return !!user && (user.role === 'admin' || user.role === 'rrhh');
}
