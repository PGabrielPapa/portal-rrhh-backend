// Cambia el índice único de recibos para permitir 2+ liquidaciones del mismo tipo
// en un mismo período (agrega la columna correlativo a la clave). Idempotente y seguro.
import { pool } from '../db.js';

export async function migrarRecibosCorrelativo() {
  try {
    await pool.query('ALTER TABLE recibos ADD COLUMN IF NOT EXISTS correlativo INTEGER NOT NULL DEFAULT 1');
    const nuevo = await pool.query("SELECT 1 FROM pg_constraint WHERE conname='uq_recibo_corr'");
    if (nuevo.rowCount) return { ok: true, cambiado: false };
    // Quita la constraint vieja (si existe) y agrega la nueva con correlativo.
    await pool.query('ALTER TABLE recibos DROP CONSTRAINT IF EXISTS uq_recibo');
    await pool.query('ALTER TABLE recibos ADD CONSTRAINT uq_recibo_corr UNIQUE (empleado_id, anio, mes, tipo, correlativo)');
    return { ok: true, cambiado: true };
  } catch (e) {
    console.error('[migrate-recibos-correlativo]', e.message);
    return { ok: false, error: e.message };
  }
}
