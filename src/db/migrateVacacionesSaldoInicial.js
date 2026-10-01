// Saldo INICIAL de vacaciones por empleado (arrastre histórico).
//
// El sistema calcula el saldo del año como (días que corresponden por antigüedad
// — LCT art. 150) menos (días tomados ese año). Eso no contempla el arrastre de
// años anteriores: los días que un trabajador se venía guardando antes de que el
// portal llevara el registro. Esta tabla guarda ese arrastre, una sola vez por
// empleado, y el endpoint de saldos lo SUMA al cálculo del año:
//
//   saldo = saldo_inicial + corresponden(año) − tomadas(año)
//
// Se carga desde el Excel histórico de RR.HH. (columna "DÍAS PENDIENTES").
import { query } from '../db.js';

export async function migrarVacacionesSaldoInicial() {
  const res = { creada: false };
  await query(`CREATE TABLE IF NOT EXISTS vacaciones_saldo_inicial (
    empleado_id     INTEGER PRIMARY KEY REFERENCES empleados(id) ON DELETE CASCADE,
    dias            NUMERIC NOT NULL DEFAULT 0,   -- arrastre de años anteriores (puede ser negativo)
    obs             TEXT,
    actualizado_por TEXT,
    actualizado_en  TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  res.creada = true;
  return res;
}

export default migrarVacacionesSaldoInicial;
