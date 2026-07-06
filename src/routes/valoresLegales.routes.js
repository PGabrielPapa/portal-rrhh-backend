import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

function mapRow(r) {
  return { id: r.id, vigenciaDesde: r.vigencia_desde, topeSipaMax: Number(r.tope_sipa_max), topeSipaMin: Number(r.tope_sipa_min),
    smvm: Number(r.smvm), scvoPercapita: Number(r.scvo_percapita), scvoSumaAsegurada: Number(r.scvo_suma_asegurada),
    ffep: Number(r.ffep), fuente: r.fuente, nota: r.nota, updatedBy: r.updated_by, updatedAt: r.updated_at };
}

// ── Calendario de valores OFICIALES publicados (se agregan acá cuando salen nuevos) ──
export const VALORES_PUBLICADOS = [
  { vigencia: '2026-03-01', scvoPercapita: 424.62, scvoSumaAsegurada: 2071300, fuente: 'SSN Dto.1567/74 mar-2026' },
  { vigencia: '2026-06-01', topeSipaMax: 4414652.38, topeSipaMin: 135837.40, smvm: 367800, ffep: 1827, fuente: 'ANSES/SRT jun-2026' },
  { vigencia: '2026-07-01', topeSipaMax: 4509567.41, topeSipaMin: 138757.90, smvm: 372400, fuente: 'ANSES Res.186/2026 (base SIPA) + SMVM jul-2026' },
  { vigencia: '2026-08-01', smvm: 376600, fuente: 'SMVM ago-2026' },
];
const CAMPOS_VL = ['topeSipaMax', 'topeSipaMin', 'smvm', 'scvoPercapita', 'scvoSumaAsegurada', 'ffep'];

// Actualiza automáticamente la tabla con el calendario publicado (idempotente; NO pisa filas cargadas a mano).
export async function autoActualizarValores() {
  const fechas = [...new Set(VALORES_PUBLICADOS.map((e) => e.vigencia))].sort();
  let creadas = 0, actualizadas = 0;
  for (const vig of fechas) {
    const row = {}; let fuente = '';
    for (const e of VALORES_PUBLICADOS) {
      if (e.vigencia > vig) continue;
      for (const c of CAMPOS_VL) if (e[c] != null) row[c] = e[c];
      if (e.vigencia === vig && e.fuente) fuente = e.fuente;
    }
    const r = await query(
      `INSERT INTO valores_legales (vigencia_desde, tope_sipa_max, tope_sipa_min, smvm, scvo_percapita, scvo_suma_asegurada, ffep, fuente, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'auto')
       ON CONFLICT (vigencia_desde) DO UPDATE SET
         tope_sipa_max=EXCLUDED.tope_sipa_max, tope_sipa_min=EXCLUDED.tope_sipa_min, smvm=EXCLUDED.smvm,
         scvo_percapita=EXCLUDED.scvo_percapita, scvo_suma_asegurada=EXCLUDED.scvo_suma_asegurada, ffep=EXCLUDED.ffep,
         fuente=EXCLUDED.fuente, updated_at=now()
       WHERE valores_legales.updated_by = 'auto'
       RETURNING (xmax = 0) AS inserted`,
      [vig, row.topeSipaMax || 0, row.topeSipaMin || 0, row.smvm || 0, row.scvoPercapita || 0, row.scvoSumaAsegurada || 0, row.ffep || 0, 'auto: ' + (fuente || 'publicado oficial')]);
    if (r.rowCount) { if (r.rows[0].inserted) creadas++; else actualizadas++; }
  }
  return { creadas, actualizadas, total: fechas.length };
}

// Valores vigentes a una fecha (la fila de mayor vigencia_desde <= fecha).
export async function valoresLegalesVigentes(fechaISO) {
  const ref = String(fechaISO || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
  const r = (await query('SELECT * FROM valores_legales WHERE vigencia_desde <= $1 ORDER BY vigencia_desde DESC LIMIT 1', [ref])).rows[0];
  return r ? mapRow(r) : null;
}

// Verificación: ¿hay valores cargados y vigentes para el período (mismo mes/año)?
export async function verificarValoresLegales(anio, mes) {
  const fecha = `${anio}-${String(mes).padStart(2, '0')}-15`;
  const v = await valoresLegalesVigentes(fecha);
  if (!v) return { ok: false, faltan: true, desactualizado: false, vigencia: null, valores: null,
    mensaje: 'No hay valores legales cargados (tope SIPA, SMVM, SCVO, FFEP). Cargalos en "Valores legales" antes de liquidar.' };
  const mesPer = `${anio}-${String(mes).padStart(2, '0')}`;
  const mesVig = String(v.vigenciaDesde).slice(0, 7);
  const desactualizado = mesVig < mesPer;
  const faltaValor = !(v.topeSipaMax > 0) || !(v.smvm > 0);
  return {
    ok: !desactualizado && !faltaValor, faltan: false, desactualizado, faltaValor,
    vigencia: v.vigenciaDesde, valores: v,
    mensaje: desactualizado
      ? `Atención: los valores legales vigentes son de ${mesVig} y estás liquidando ${mesPer}. Verificá/actualizá tope SIPA, SMVM, SCVO y FFEP del período.`
      : (faltaValor ? 'Faltan completar algunos valores legales del período (tope SIPA o SMVM).' : null),
  };
}

router.post('/auto-actualizar', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try { const r = await autoActualizarValores(); res.json({ ok: true, ...r }); } catch (e) { next(e); }
});

router.get('/', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try { const { rows } = await query('SELECT * FROM valores_legales ORDER BY vigencia_desde DESC'); res.json(rows.map(mapRow)); }
  catch (e) { next(e); }
});

// Verificación para un período (la usa la pantalla de liquidación antes de la corrida).
router.get('/verificar', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const d = new Date();
    const anio = Number(req.query.anio) || d.getFullYear();
    const mes = Number(req.query.mes) || (d.getMonth() + 1);
    res.json(await verificarValoresLegales(anio, mes));
  } catch (e) { next(e); }
});

router.post('/', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.vigenciaDesde) return res.status(400).json({ error: 'La vigencia (fecha desde) es obligatoria' });
    const r = await query(
      `INSERT INTO valores_legales (vigencia_desde, tope_sipa_max, tope_sipa_min, smvm, scvo_percapita, scvo_suma_asegurada, ffep, fuente, nota, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (vigencia_desde) DO UPDATE SET tope_sipa_max=EXCLUDED.tope_sipa_max, tope_sipa_min=EXCLUDED.tope_sipa_min, smvm=EXCLUDED.smvm,
         scvo_percapita=EXCLUDED.scvo_percapita, scvo_suma_asegurada=EXCLUDED.scvo_suma_asegurada, ffep=EXCLUDED.ffep, fuente=EXCLUDED.fuente, nota=EXCLUDED.nota, updated_by=EXCLUDED.updated_by, updated_at=now()
       RETURNING id`,
      [b.vigenciaDesde, Number(b.topeSipaMax) || 0, Number(b.topeSipaMin) || 0, Number(b.smvm) || 0, Number(b.scvoPercapita) || 0, Number(b.scvoSumaAsegurada) || 0, Number(b.ffep) || 0, b.fuente || null, b.nota || null, req.user?.email || '']);
    res.status(201).json({ ok: true, id: r.rows[0].id });
  } catch (e) { next(e); }
});

router.delete('/:id', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try { const r = await query('DELETE FROM valores_legales WHERE id=$1 RETURNING id', [req.params.id]); if (!r.rowCount) return res.status(404).json({ error: 'No encontrado' }); res.json({ ok: true }); }
  catch (e) { next(e); }
});

export default router;
