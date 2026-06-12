import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
const router = Router();
router.use(requireAuth);
const gestiona = (r) => ['rrhh', 'admin'].includes(r);

router.get('/', async (req, res, next) => {
  try {
    if (!gestiona(req.user.role)) { const { rows } = await query('SELECT * FROM elementos_trabajo WHERE empleado_id=$1 ORDER BY created_at DESC', [req.user.id]); return res.json(rows); }
    const { q, empresa, estado } = req.query; const cond = [], params = [];
    if (empresa) { params.push(empresa); cond.push(`em.nombre=$${params.length}`); }
    if (estado) { params.push(estado); cond.push(`t.estado=$${params.length}`); }
    if (q) { params.push(`%${String(q).toLowerCase()}%`); const i = params.length; cond.push(`(lower(e.nom) LIKE $${i} OR e.leg_num LIKE $${i})`); }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    const { rows } = await query(`SELECT t.*, e.nom, e.leg_num, em.nombre AS empresa FROM elementos_trabajo t JOIN empleados e ON e.id=t.empleado_id JOIN empresas em ON em.id=e.empresa_id ${where} ORDER BY (t.estado='entregado') DESC, t.created_at DESC`, params);
    res.json(rows);
  } catch (e) { next(e); }
});
router.post('/', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.empleadoId || !b.tipo) return res.status(400).json({ error: 'empleado y tipo son obligatorios' });
    const r = await query('INSERT INTO elementos_trabajo (empleado_id,tipo,descripcion,identificador,estado,fecha_entrega,observaciones,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
      [b.empleadoId, b.tipo, b.descripcion || null, b.identificador || null, 'entregado', b.fechaEntrega || null, b.observaciones || null, req.user.dni]);
    res.status(201).json({ ok: true, id: r.rows[0].id });
  } catch (e) { next(e); }
});
router.patch('/:id', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const { estado, fechaDevolucion } = req.body || {};
    if (!['entregado', 'devuelto', 'perdido', 'roto'].includes(estado)) return res.status(400).json({ error: 'Estado inválido' });
    await query('UPDATE elementos_trabajo SET estado=$1, fecha_devolucion=COALESCE($2,fecha_devolucion) WHERE id=$3', [estado, fechaDevolucion || null, req.params.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});
export default router;
