import { query } from '../db.js';

// Registro de auditoría (fire-and-forget: nunca frena la operación principal).
export function logAudit(actor, accion, detalle, target) {
  query('INSERT INTO audit_log (actor_dni, accion, detalle, target) VALUES ($1,$2,$3,$4)',
    [actor, accion, detalle || null, target || null]).catch(() => {});
}
