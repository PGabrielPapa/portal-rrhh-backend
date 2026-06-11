import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);
const puedeVerTodos = (role) => ['rrhh', 'admin', 'manager'].includes(role);

// GET /api/recibos — propios; rrhh/admin/manager con ?empleadoId= ven los de ese empleado
router.get('/', async (req, res, next) => {
  try {
    let empleadoId = req.user.id;
    if (req.query.empleadoId && puedeVerTodos(req.user.role)) empleadoId = Number(req.query.empleadoId);
    const { rows } = await query(
      `SELECT id, anio, mes, tipo, neto, created_at FROM recibos WHERE empleado_id = $1 ORDER BY anio DESC, mes DESC`,
      [empleadoId]
    );
    res.json(rows);
  } catch (e) { next(e); }
});

// GET /api/recibos/gestion — todos los recibos (rrhh/admin/manager), con filtros
router.get('/gestion', requireRole('rrhh', 'admin', 'manager'), async (req, res, next) => {
  try {
    const { anio, mes, empresa, q } = req.query;
    const cond = [], params = [];
    if (anio) { params.push(Number(anio)); cond.push(`r.anio = $${params.length}`); }
    if (mes) { params.push(Number(mes)); cond.push(`r.mes = $${params.length}`); }
    if (empresa) { params.push(empresa); cond.push(`em.nombre = $${params.length}`); }
    if (q) { params.push(`%${String(q).toLowerCase()}%`); const i = params.length; cond.push(`(lower(e.nom) LIKE $${i} OR e.leg_num LIKE $${i})`); }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    const { rows } = await query(
      `SELECT r.id, r.anio, r.mes, r.tipo, r.neto, r.created_at, r.created_by,
              e.nom, e.leg_num, em.nombre AS empresa
         FROM recibos r JOIN empleados e ON e.id = r.empleado_id
         JOIN empresas em ON em.id = e.empresa_id
         ${where}
        ORDER BY r.anio DESC, r.mes DESC, e.nom`,
      params
    );
    res.json(rows);
  } catch (e) { next(e); }
});

// GET /api/recibos/:id — detalle (propio, o cualquiera si rrhh/admin/manager)
router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM recibos WHERE id = $1', [req.params.id]);
    const rec = rows[0];
    if (!rec) return res.status(404).json({ error: 'Recibo no encontrado' });
    if (rec.empleado_id !== req.user.id && !puedeVerTodos(req.user.role)) return res.status(403).json({ error: 'Sin permiso' });
    res.json(rec.data);
  } catch (e) { next(e); }
});

export default router;
