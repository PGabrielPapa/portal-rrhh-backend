import { query } from '../db.js';

export function mapGanRow(r) {
  return {
    id: r.id, periodo: r.periodo, vigenciaDesde: r.vigencia_desde, rg: r.rg,
    mniAnual: Number(r.mni_anual), dedEspAnual: Number(r.ded_esp_anual), dedEsp2Anual: Number(r.ded_esp2_anual),
    cargaConyugeAnual: Number(r.carga_conyuge_anual), cargaHijoAnual: Number(r.carga_hijo_anual), cargaHijoIncAnual: Number(r.carga_hijo_inc_anual),
    escala: r.escala || [], provisional: r.provisional === true, updatedBy: r.updated_by, updatedAt: r.updated_at,
  };
}

// Tabla de Ganancias vigente a la fecha (la de mayor vigencia_desde <= fecha). null si no hay ninguna.
export async function ganTablaParaFecha(fechaISO) {
  const ref = String(fechaISO || '').slice(0, 10) || '2100-12-31';
  let r = (await query('SELECT * FROM ganancias_periodos WHERE vigencia_desde <= $1 ORDER BY vigencia_desde DESC LIMIT 1', [ref])).rows[0];
  if (!r) r = (await query('SELECT * FROM ganancias_periodos ORDER BY vigencia_desde ASC LIMIT 1')).rows[0];
  return r ? mapGanRow(r) : null;
}

// ── Calendario oficial de tablas RG 4003 (deducciones art. 30 + escala art. 94) ──
// Cuando ARCA publica el semestre, se agrega acá y el sistema lo carga solo.
// Cada entrada: { periodo:'AAAA-Sn', vigenciaDesde:'AAAA-MM-01', rg, mniAnual, dedEspAnual,
//   dedEsp2Anual, cargaConyugeAnual, cargaHijoAnual, cargaHijoIncAnual, escala:[{desde,hasta,fijo,alicuota}] }
export const GAN_PUBLICADOS = [
  {
    periodo: '2026-S2',
    vigenciaDesde: '2026-07-01',
    rg: 'RG ARCA \u2014 Ganancias 4ta cat., 2\u00b0 semestre 2026 (jul-dic) (art. 30 y art. 94)',
    mniAnual: 6019671.36,
    dedEspAnual: 28894422.56,
    dedEsp2Anual: 0,
    cargaConyugeAnual: 5669323.06,
    cargaHijoAnual: 2859060.30,
    cargaHijoIncAnual: 5718120.61,
    escala: [
      { desde: 0, hasta: 2336953.69, fijo: 0, alicuota: 5 },
      { desde: 2336953.69, hasta: 4673907.37, fijo: 116847.68, alicuota: 9 },
      { desde: 4673907.37, hasta: 7010861.06, fijo: 327173.51, alicuota: 12 },
      { desde: 7010861.06, hasta: 10516291.59, fijo: 607607.96, alicuota: 15 },
      { desde: 10516291.59, hasta: 21032583.19, fijo: 1133422.53, alicuota: 19 },
      { desde: 21032583.19, hasta: 31548874.78, fijo: 3131517.94, alicuota: 23 },
      { desde: 31548874.78, hasta: 47323312.17, fijo: 5550265.01, alicuota: 27 },
      { desde: 47323312.17, hasta: 70984968.27, fijo: 9809363.11, alicuota: 31 },
      { desde: 70984968.27, hasta: null, fijo: 17144476.49, alicuota: 35 },
    ],
  },
];

async function insertGanOficial(pub) {
  await query(
    `INSERT INTO ganancias_periodos (periodo, vigencia_desde, rg, mni_anual, ded_esp_anual, ded_esp2_anual,
        carga_conyuge_anual, carga_hijo_anual, carga_hijo_inc_anual, escala, provisional, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,false,'auto-arca')
     ON CONFLICT (periodo) DO UPDATE SET vigencia_desde=EXCLUDED.vigencia_desde, rg=EXCLUDED.rg,
        mni_anual=EXCLUDED.mni_anual, ded_esp_anual=EXCLUDED.ded_esp_anual, ded_esp2_anual=EXCLUDED.ded_esp2_anual,
        carga_conyuge_anual=EXCLUDED.carga_conyuge_anual, carga_hijo_anual=EXCLUDED.carga_hijo_anual,
        carga_hijo_inc_anual=EXCLUDED.carga_hijo_inc_anual, escala=EXCLUDED.escala, provisional=false, updated_at=now()`,
    [pub.periodo, pub.vigenciaDesde, pub.rg || null, pub.mniAnual || 0, pub.dedEspAnual || 0, pub.dedEsp2Anual || 0,
     pub.cargaConyugeAnual || 0, pub.cargaHijoAnual || 0, pub.cargaHijoIncAnual || 0, JSON.stringify(pub.escala || [])]);
}

// Consulta y actualiza automaticamente la tabla de Ganancias del semestre del periodo.
// - Si ARCA publico el semestre (esta en GAN_PUBLICADOS): lo carga/actualiza como OFICIAL.
// - Si no hay tabla del semestre y aun no salio: copia la ultima oficial como PROVISORIA.
// Devuelve { estado: 'oficial'|'provisoria'|'falta', periodo, ... }.
export async function autoActualizarGanancias(anio, mes) {
  const d = new Date();
  const y = Number(anio) || d.getFullYear();
  const m = Number(mes) || (d.getMonth() + 1);
  const sem = m <= 6 ? 1 : 2;
  const periodo = `${y}-S${sem}`;
  const vigDesde = `${y}-${sem === 1 ? '01' : '07'}-01`;
  const pub = GAN_PUBLICADOS.find((x) => x.periodo === periodo);
  const ex = (await query('SELECT id, provisional FROM ganancias_periodos WHERE periodo=$1', [periodo])).rows[0];

  if (pub) {
    if (!ex || ex.provisional) { await insertGanOficial(pub); return { estado: 'oficial', periodo, cargada: !ex }; }
    return { estado: 'oficial', periodo };
  }
  if (ex) return { estado: ex.provisional ? 'provisoria' : 'oficial', periodo };
  // No publicado y sin tabla del semestre: copiar la ultima disponible como provisoria.
  const ult = (await query('SELECT * FROM ganancias_periodos WHERE provisional=false ORDER BY vigencia_desde DESC LIMIT 1')).rows[0]
           || (await query('SELECT * FROM ganancias_periodos ORDER BY vigencia_desde DESC LIMIT 1')).rows[0];
  if (!ult) return { estado: 'falta', periodo };
  const rgTxt = ult.rg ? String(ult.rg).replace(/ — provisoria.*/, '') + ' — provisoria (a la espera de la publicacion del semestre)' : 'Provisoria';
  await query(
    `INSERT INTO ganancias_periodos (periodo, vigencia_desde, rg, mni_anual, ded_esp_anual, ded_esp2_anual,
        carga_conyuge_anual, carga_hijo_anual, carga_hijo_inc_anual, escala, provisional, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,'auto-provisoria') ON CONFLICT (periodo) DO NOTHING`,
    [periodo, vigDesde, rgTxt, ult.mni_anual, ult.ded_esp_anual, ult.ded_esp2_anual,
     ult.carga_conyuge_anual, ult.carga_hijo_anual, ult.carga_hijo_inc_anual, JSON.stringify(ult.escala || [])]);
  return { estado: 'provisoria', periodo, copiadaDe: ult.periodo, creada: true };
}
