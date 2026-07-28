// Migra prod_valor_hora del esquema viejo (PK categoria,vigencia) al nuevo (PK empleado_id,vigencia).
// Idempotente: si la tabla ya tiene la columna empleado_id no hace nada.
import { query } from '../db.js';

export async function migrarProdValorHora() {
  const col = await query(
    `SELECT 1 FROM information_schema.columns WHERE table_name='prod_valor_hora' AND column_name='empleado_id'`);
  if (col.rowCount === 0) {
    // La tabla vieja no tiene datos útiles (valores individuales, no por categoría): se recrea.
    await query('DROP TABLE IF EXISTS prod_valor_hora');
    await query(`CREATE TABLE prod_valor_hora (
      empleado_id   INTEGER NOT NULL,
      vigencia      DATE NOT NULL,
      valor_hora    NUMERIC(14,4) NOT NULL DEFAULT 0,
      jornada_horas NUMERIC(5,2) NOT NULL DEFAULT 8,
      categoria     TEXT,
      PRIMARY KEY (empleado_id, vigencia)
    )`);
    return { skip: false };
  }
  // Ya está en esquema por empleado: sólo asegurar la columna de jornada.
  const jh = await query(
    `SELECT 1 FROM information_schema.columns WHERE table_name='prod_valor_hora' AND column_name='jornada_horas'`);
  if (jh.rowCount === 0) {
    await query('ALTER TABLE prod_valor_hora ADD COLUMN jornada_horas NUMERIC(5,2) NOT NULL DEFAULT 8');
    return { skip: false };
  }
  return { skip: true };
}
