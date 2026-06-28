import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

function mapRow(r) {
  return { id: r.id, empleadoId: r.empleado_id, empleadoNom: r.empleado_nom, legNum: r.leg_num, tipo: r.tipo, modo: r.modo,
    monto: Number(r.monto), porcentaje: Number(r.porcentaje), caratula: r.caratula, juzgado: r.juzgado, expediente: r.expediente, oficio: r.oficio,
    total: Number(r.total), retenido: Number(r.retenido), desde: r.desde, hasta: r.hasta, activo: r.activo, obs: r.obs };
}

// Helper para la liquidación: agrega los embargos activos de un empleado en opts del motor.
export async function embargosOpts(empleadoId, fechaRef) {
  const f = fechaRef || new Date().toISOString().slice(0, 10);
  const { rows } = await query(
    `SELECT * FROM embargos WHERE empleado_id=$1 AND activo=true
       AND (desde IS NULL OR desde<=$2) AND (hasta IS NULL OR hasta>=$2)
       AND (total=0 OR retenido < total)`, [empleadoId, f]);
  let embargo = 0, cuotaAlimentaria = 0, embargoAlimentosPct = 0;
  for (const e of rows) {
    if (e.tipo === 'alimentos') {
      if (e.modo === 'porcentaje') embargoAlimentosPct += Number(e.porcentaje) || 0;
      else cuotaAlimentaria += Number(e.monto) || 0;
    } else { embargo += Number(e.monto) || 0; }
  }
  return { embargo, cuotaAlimentaria, embargoAlimentosPct, _ids: rows.map((r) => r.id) };
}

router.get('/', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const cond = [], args = [];
    if (req.query.empleadoId) { args.push(Number(req.query.empleadoId)); cond.push(`e.empleado_id=$${args.length}`); }
    if (req.query.activos === '1') cond.push('e.activo=true');
    const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
    const { rows } = await query(
      `SELECT e.*, em.nom AS empleado_nom, em.leg_num FROM embargos e JOIN empleados em ON em.id=e.empleado_id ${where} ORDER BY e.activo DESC, em.nom`, args);
    res.json(rows.map(mapRow));
  } catch (e) { next(e); }
});

router.post('/', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.empleadoId) return res.status(400).json({ error: 'Empleado obligatorio' });
    const r = await query(
      `INSERT INTO embargos (empleado_id, tipo, modo, monto, porcentaje, caratula, juzgado, expediente, oficio, total, desde, hasta, activo, obs, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
      [b.empleadoId, b.tipo || 'judicial', b.modo || 'monto', Number(b.monto) || 0, Number(b.porcentaje) || 0, b.caratula || null, b.juzgado || null, b.expediente || null, b.oficio || null, Number(b.total) || 0, b.desde || null, b.hasta || null, b.activo !== false, b.obs || null, req.user?.email || '']);
    res.status(201).json({ ok: true, id: r.rows[0].id });
  } catch (e) { next(e); }
});

router.put('/:id', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const r = await query(
      `UPDATE embargos SET tipo=$1, modo=$2, monto=$3, porcentaje=$4, caratula=$5, juzgado=$6, expediente=$7, oficio=$8, total=$9, retenido=$10, desde=$11, hasta=$12, activo=$13, obs=$14, updated_at=now() WHERE id=$15 RETURNING id`,
      [b.tipo || 'judicial', b.modo || 'monto', Number(b.monto) || 0, Number(b.porcentaje) || 0, b.caratula || null, b.juzgado || null, b.expediente || null, b.oficio || null, Number(b.total) || 0, Number(b.retenido) || 0, b.desde || null, b.hasta || null, b.activo !== false, b.obs || null, req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'No encontrado' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.delete('/:id', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try { const r = await query('DELETE FROM embargos WHERE id=$1 RETURNING id', [req.params.id]); if (!r.rowCount) return res.status(404).json({ error: 'No encontrado' }); res.json({ ok: true }); }
  catch (e) { next(e); }
});

export default router;
