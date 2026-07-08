import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);
router.use(requireRole('rrhh', 'admin'));

// GET /api/agrupaciones — lista con cantidad de miembros.
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT a.id, a.nombre, a.descripcion, a.activo,
              (SELECT count(*)::int FROM agrupacion_legajos g WHERE g.agrupacion_id=a.id) AS miembros
         FROM agrupaciones a ORDER BY a.nombre`);
    res.json(rows);
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.nombre || !String(b.nombre).trim()) return res.status(400).json({ error: 'El nombre es obligatorio' });
    const r = await query('INSERT INTO agrupaciones (nombre, descripcion, activo) VALUES ($1,$2,$3) RETURNING id',
      [String(b.nombre).trim(), b.descripcion || null, b.activo !== false]);
    res.status(201).json({ ok: true, id: r.rows[0].id });
  } catch (e) { if (e.code === '23505') return res.status(400).json({ error: 'Ya existe una agrupación con ese nombre' }); next(e); }
});

router.put('/:id', async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.nombre || !String(b.nombre).trim()) return res.status(400).json({ error: 'El nombre es obligatorio' });
    const r = await query('UPDATE agrupaciones SET nombre=$1, descripcion=$2, activo=$3 WHERE id=$4 RETURNING id',
      [String(b.nombre).trim(), b.descripcion || null, b.activo !== false, req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'No encontrada' });
    res.json({ ok: true });
  } catch (e) { if (e.code === '23505') return res.status(400).json({ error: 'Ya existe una agrupación con ese nombre' }); next(e); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const r = await query('DELETE FROM agrupaciones WHERE id=$1', [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'No encontrada' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// GET /api/agrupaciones/:id/miembros — empleados de la agrupación.
router.get('/:id/miembros', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT e.id, e.nom, e.leg_num, em.nombre AS empresa
         FROM agrupacion_legajos g JOIN empleados e ON e.id=g.empleado_id JOIN empresas em ON em.id=e.empresa_id
        WHERE g.agrupacion_id=$1 ORDER BY em.nombre, e.nom`, [req.params.id]);
    res.json(rows.map((r) => ({ id: r.id, nom: r.nom, legNum: r.leg_num, empresa: r.empresa })));
  } catch (e) { next(e); }
});

router.post('/:id/miembros', async (req, res, next) => {
  try {
    const empId = Number((req.body || {}).empleadoId);
    if (!empId) return res.status(400).json({ error: 'Indicá el empleado' });
    await query('INSERT INTO agrupacion_legajos (agrupacion_id, empleado_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.params.id, empId]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.delete('/:id/miembros/:empId', async (req, res, next) => {
  try {
    await query('DELETE FROM agrupacion_legajos WHERE agrupacion_id=$1 AND empleado_id=$2', [req.params.id, req.params.empId]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
