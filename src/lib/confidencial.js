import { query } from '../db.js';

// ¿El usuario logueado puede ver los legajos confidenciales?
// - admin: siempre.
// - resto: solo si su propio legajo tiene data.verConfidenciales = true.
export async function puedeVerConfidenciales(user) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  try {
    const r = await query("SELECT (data->>'verConfidenciales') AS v FROM empleados WHERE id=$1", [user.id]);
    return String(r.rows?.[0]?.v || '').toLowerCase() === 'true';
  } catch { return false; }
}
