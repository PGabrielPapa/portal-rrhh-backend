import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);
const gestiona = (r) => ['manager', 'rrhh', 'admin'].includes(r);

router.get('/', async (req, res, next) => {
  try {
    if (!gestiona(req.user.role)) {
      const { rows } = await query('SELECT * FROM sanciones WHERE empleado_id = $1 ORDER BY fecha DESC', [req.user.id]);
      return res.json(rows);
    }
    const { empresa, q } = req.query; const cond = [], params = [];
    if (req.user.role === 'manager') { params.push(req.user.empresa_id); cond.push(`e.empresa_id = $${params.length}`); }
    if (empresa) { params.push(empresa); cond.push(`em.nombre = $${params.length}`); }
    if (q) { params.push(`%${String(q).toLowerCase()}%`); const i = params.length; cond.push(`(lower(e.nom) LIKE $${i} OR e.leg_num LIKE $${i})`); }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    const { rows } = await query(
      `SELECT s.*, e.nom, e.leg_num, em.nombre AS empresa FROM sanciones s
         JOIN empleados e ON e.id = s.empleado_id JOIN empresas em ON em.id = e.empresa_id
         ${where} ORDER BY s.fecha DESC`, params);
    res.json(rows);
  } catch (e) { next(e); }
});

// GET /api/sanciones/mias — SIEMPRE las propias (cualquier rol)
router.get('/mias', async (req, res, next) => {
  try { const { rows } = await query('SELECT * FROM sanciones WHERE empleado_id = $1 ORDER BY fecha DESC', [req.user.id]); res.json(rows); }
  catch (e) { next(e); }
});

router.post('/', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const { empleadoId, tipo, fecha, dias, descripcion } = req.body || {};
    if (!empleadoId || !tipo || !fecha) return res.status(400).json({ error: 'empleado, tipo y fecha son obligatorios' });
    const r = await query(
      'INSERT INTO sanciones (empleado_id, tipo, fecha, dias, descripcion, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [empleadoId, tipo, fecha, parseInt(dias, 10) || 0, descripcion || null, req.user.dni]);
    res.status(201).json({ ok: true, id: r.rows[0].id });
  } catch (e) { next(e); }
});

export default router;
