import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);
const gestiona = (r) => ['manager', 'rrhh', 'admin'].includes(r);

router.get('/mias', async (req, res, next) => {
  try { const { rows } = await query('SELECT * FROM sanciones WHERE empleado_id = $1 ORDER BY fecha DESC', [req.user.id]); res.json(rows); }
  catch (e) { next(e); }
});

router.get('/', async (req, res, next) => {
  try {
    if (!gestiona(req.user.role)) {
      const { rows } = await query('SELECT * FROM sanciones WHERE empleado_id = $1 ORDER BY fecha DESC', [req.user.id]);
      return res.json(rows);
    }
    const { empresa, q, estado } = req.query; const cond = [], params = [];
    if (req.user.role === 'manager') { params.push(req.user.empresa_id); cond.push(`e.empresa_id = $${params.length}`); }
    if (empresa) { params.push(empresa); cond.push(`em.nombre = $${params.length}`); }
    if (estado) { params.push(estado); cond.push(`s.estado = $${params.length}`); }
    if (q) { params.push(`%${String(q).toLowerCase()}%`); const i = params.length; cond.push(`(lower(e.nom) LIKE $${i} OR e.leg_num LIKE $${i})`); }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    const { rows } = await query(
      `SELECT s.*, e.nom, e.leg_num, em.nombre AS empresa FROM sanciones s
         JOIN empleados e ON e.id = s.empleado_id JOIN empresas em ON em.id = e.empresa_id
         ${where} ORDER BY (s.estado='solicitada') DESC, s.fecha DESC`, params);
    res.json(rows);
  } catch (e) { next(e); }
});

// POST — gerente SOLICITA (estado=solicitada); rrhh/admin APLICA directamente
router.post('/', requireRole('manager', 'rrhh', 'admin'), async (req, res, next) => {
  try {
    const { empleadoId, tipo, falta, fecha, dias, descripcion } = req.body || {};
    if (!empleadoId || !tipo || !fecha) return res.status(400).json({ error: 'empleado, tipo y fecha son obligatorios' });
    const estado = req.user.role === 'manager' ? 'solicitada' : 'aplicada';
    const r = await query(
      'INSERT INTO sanciones (empleado_id, tipo, falta, fecha, dias, descripcion, estado, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
      [empleadoId, tipo, falta || null, fecha, parseInt(dias, 10) || 0, descripcion || null, estado, req.user.dni]);
    res.status(201).json({ ok: true, id: r.rows[0].id, estado });
  } catch (e) { next(e); }
});

// PATCH — RR.HH. aplica/rechaza una sanción solicitada
router.patch('/:id', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const estado = (req.body || {}).estado;
    if (!['aplicada', 'rechazada'].includes(estado)) return res.status(400).json({ error: 'Estado inválido' });
    const r = await query(`UPDATE sanciones SET estado=$1, resuelto_por=$2 WHERE id=$3 AND estado='solicitada' RETURNING id`, [estado, req.user.dni, req.params.id]);
    if (!r.rowCount) return res.status(409).json({ error: 'La sanción no existe o no está pendiente' });
    res.json({ ok: true, estado });
  } catch (e) { next(e); }
});

export default router;
