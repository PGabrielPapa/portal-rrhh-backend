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
    const gestor = puedeVerTodos(req.user.role);
    if (req.query.empleadoId && gestor) empleadoId = Number(req.query.empleadoId);
    const esPropio = empleadoId === req.user.id;
    // El empleado solo ve recibos publicados; los gestores ven todos.
    const filtro = (esPropio && !gestor) ? 'AND publicado = true' : (req.query.empleadoId && gestor ? '' : (esPropio ? '' : ''));
    const { rows } = await query(
      `SELECT id, anio, mes, tipo, neto, created_at, publicado FROM recibos WHERE empleado_id = $1 ${filtro} ORDER BY anio DESC, mes DESC`,
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
    const gestor = puedeVerTodos(req.user.role);
    if (rec.empleado_id !== req.user.id && !gestor) return res.status(403).json({ error: 'Sin permiso' });
    if (rec.empleado_id === req.user.id && !gestor && !rec.publicado) return res.status(404).json({ error: 'Recibo no disponible' });
    // Log de visualización cuando el empleado consulta su propio recibo.
    if (rec.empleado_id === req.user.id) {
      query('INSERT INTO recibo_vistas (recibo_id, empleado_id) VALUES ($1,$2)', [rec.id, req.user.id]).catch(() => {});
    }
    res.json(rec.data);
  } catch (e) { next(e); }
});

// GET /api/recibos/:id/vistas — log de visualizaciones (rrhh/admin/manager)
router.get('/:id/vistas', requireRole('rrhh', 'admin', 'manager'), async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT v.created_at, e.nom, e.leg_num FROM recibo_vistas v JOIN empleados e ON e.id=v.empleado_id WHERE v.recibo_id=$1 ORDER BY v.created_at DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (e) { next(e); }
});

export default router;
