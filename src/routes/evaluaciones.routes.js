import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);
const gestiona = (r) => ['manager', 'rrhh', 'admin'].includes(r);

router.get('/', async (req, res, next) => {
  try {
    if (!gestiona(req.user.role)) {
      const { rows } = await query('SELECT * FROM evaluaciones WHERE empleado_id = $1 ORDER BY created_at DESC', [req.user.id]);
      return res.json(rows);
    }
    const { empresa, q } = req.query; const cond = [], params = [];
    if (empresa) { params.push(empresa); cond.push(`em.nombre = $${params.length}`); }
    if (q) { params.push(`%${String(q).toLowerCase()}%`); const i = params.length; cond.push(`(lower(e.nom) LIKE $${i} OR e.leg_num LIKE $${i})`); }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    const { rows } = await query(
      `SELECT v.*, e.nom, e.leg_num, em.nombre AS empresa FROM evaluaciones v
         JOIN empleados e ON e.id = v.empleado_id JOIN empresas em ON em.id = e.empresa_id
         ${where} ORDER BY v.created_at DESC`, params);
    res.json(rows);
  } catch (e) { next(e); }
});

router.post('/', requireRole('manager', 'rrhh', 'admin'), async (req, res, next) => {
  try {
    const { empleadoId, periodo, tipo, calificacion, comentarios } = req.body || {};
    if (!empleadoId || !periodo) return res.status(400).json({ error: 'empleado y período son obligatorios' });
    const r = await query(
      'INSERT INTO evaluaciones (empleado_id, periodo, tipo, calificacion, comentarios, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [empleadoId, periodo, tipo || null, calificacion || null, comentarios || null, req.user.dni]);
    res.status(201).json({ ok: true, id: r.rows[0].id });
  } catch (e) { next(e); }
});

export default router;
