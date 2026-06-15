import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
const router = Router();
router.use(requireAuth);
const gestiona = (r) => ['rrhh', 'admin'].includes(r);

router.get('/', async (req, res, next) => {
  try {
    if (!gestiona(req.user.role)) { const { rows } = await query('SELECT * FROM beneficios WHERE empleado_id=$1 ORDER BY created_at DESC', [req.user.id]); return res.json(rows); }
    const { q, empresa } = req.query; const cond = [], params = [];
    if (empresa) { params.push(empresa); cond.push(`em.nombre=$${params.length}`); }
    if (q) { params.push(`%${String(q).toLowerCase()}%`); const i = params.length; cond.push(`(lower(e.nom) LIKE $${i} OR e.leg_num LIKE $${i})`); }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    const { rows } = await query(`SELECT b.*, e.nom, e.leg_num, em.nombre AS empresa FROM beneficios b JOIN empleados e ON e.id=b.empleado_id JOIN empresas em ON em.id=e.empresa_id ${where} ORDER BY b.activo DESC, b.created_at DESC`, params);
    res.json(rows);
  } catch (e) { next(e); }
});
router.post('/', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.empleadoId || !b.tipo) return res.status(400).json({ error: 'empleado y tipo son obligatorios' });
    const r = await query('INSERT INTO beneficios (empleado_id,tipo,modalidad,monto,proveedor,vigencia_desde,vigencia_hasta,detalle,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',
      [b.empleadoId, b.tipo, b.modalidad || null, parseFloat(b.monto) || 0, b.proveedor || null, b.vigenciaDesde || null, b.vigenciaHasta || null, b.detalle || null, req.user.dni]);
    res.status(201).json({ ok: true, id: r.rows[0].id });
  } catch (e) { next(e); }
});
// PUT /api/beneficios/:id — editar el beneficio otorgado (rrhh/admin)
router.put('/:id', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.tipo) return res.status(400).json({ error: 'El tipo es obligatorio' });
    const r = await query(
      `UPDATE beneficios SET tipo=$1, modalidad=$2, monto=$3, proveedor=$4, vigencia_desde=$5, vigencia_hasta=$6, detalle=$7 WHERE id=$8 RETURNING id`,
      [b.tipo, b.modalidad || null, parseFloat(b.monto) || 0, b.proveedor || null, b.vigenciaDesde || null, b.vigenciaHasta || null, b.detalle || null, req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Beneficio no encontrado' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});
router.patch('/:id/activo', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try { await query('UPDATE beneficios SET activo=$1 WHERE id=$2', [!!(req.body || {}).activo, req.params.id]); res.json({ ok: true }); }
  catch (e) { next(e); }
});
export default router;
