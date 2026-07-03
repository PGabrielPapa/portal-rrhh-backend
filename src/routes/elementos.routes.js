import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
const router = Router();
router.use(requireAuth);
const gestiona = (r) => ['rrhh', 'admin'].includes(r);
const cap = (s) => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
async function histElem(elemId, empId, evento, detalle, dni) {
  try { await query('INSERT INTO elementos_hist (elemento_id, empleado_id, evento, detalle, created_by) VALUES ($1,$2,$3,$4,$5)', [elemId, empId, evento, detalle || null, dni || null]); } catch (e) { /* noop */ }
}

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
    const data = { numeroChip: b.numeroChip || null, empresaChip: b.empresaChip || null };
    const r = await query('INSERT INTO elementos_trabajo (empleado_id,tipo,descripcion,identificador,estado,fecha_entrega,observaciones,created_by,data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',
      [b.empleadoId, b.tipo, b.descripcion || null, b.identificador || null, 'entregado', b.fechaEntrega || null, b.observaciones || null, req.user.dni, JSON.stringify(data)]);
    await histElem(r.rows[0].id, b.empleadoId, 'Entregado', [b.tipo, b.identificador].filter(Boolean).join(' · '), req.user.dni);
    res.status(201).json({ ok: true, id: r.rows[0].id });
  } catch (e) { next(e); }
});
router.patch('/:id', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const { estado, fechaDevolucion } = req.body || {};
    if (!['entregado', 'devuelto', 'perdido', 'roto'].includes(estado)) return res.status(400).json({ error: 'Estado inválido' });
    const cur = (await query('SELECT empleado_id, tipo, identificador FROM elementos_trabajo WHERE id=$1', [req.params.id])).rows[0];
    await query('UPDATE elementos_trabajo SET estado=$1, fecha_devolucion=COALESCE($2,fecha_devolucion) WHERE id=$3', [estado, fechaDevolucion || null, req.params.id]);
    await histElem(Number(req.params.id), cur?.empleado_id, cap(estado), [cur?.tipo, cur?.identificador, fechaDevolucion ? 'dev. ' + fechaDevolucion : ''].filter(Boolean).join(' · '), req.user.dni);
    res.json({ ok: true });
  } catch (e) { next(e); }
});
// GET /api/elementos/:id/historial — eventos de un elemento (rrhh/admin).
router.get('/:id/historial', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const { rows } = await query('SELECT id, evento, detalle, created_by, created_at FROM elementos_hist WHERE elemento_id=$1 ORDER BY created_at DESC, id DESC', [req.params.id]);
    res.json(rows);
  } catch (e) { next(e); }
});
export default router;
