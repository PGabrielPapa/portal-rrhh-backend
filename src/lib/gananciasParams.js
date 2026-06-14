import { query } from '../db.js';

export function mapGanRow(r) {
  return {
    id: r.id, periodo: r.periodo, vigenciaDesde: r.vigencia_desde, rg: r.rg,
    mniAnual: Number(r.mni_anual), dedEspAnual: Number(r.ded_esp_anual), dedEsp2Anual: Number(r.ded_esp2_anual),
    cargaConyugeAnual: Number(r.carga_conyuge_anual), cargaHijoAnual: Number(r.carga_hijo_anual), cargaHijoIncAnual: Number(r.carga_hijo_inc_anual),
    escala: r.escala || [], updatedBy: r.updated_by, updatedAt: r.updated_at,
  };
}

// Tabla de Ganancias vigente a la fecha (la de mayor vigencia_desde <= fecha). null si no hay ninguna.
export async function ganTablaParaFecha(fechaISO) {
  const ref = String(fechaISO || '').slice(0, 10) || '2100-12-31';
  let r = (await query('SELECT * FROM ganancias_periodos WHERE vigencia_desde <= $1 ORDER BY vigencia_desde DESC LIMIT 1', [ref])).rows[0];
  if (!r) r = (await query('SELECT * FROM ganancias_periodos ORDER BY vigencia_desde ASC LIMIT 1')).rows[0];
  return r ? mapGanRow(r) : null;
}
