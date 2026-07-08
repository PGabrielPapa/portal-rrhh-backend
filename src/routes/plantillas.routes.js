import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// Lectura: RR.HH./admin (para el ABM) y también para el alta de empleados.
router.get('/', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const cond = req.query.activos === '1' ? 'WHERE activo=true' : '';
    const { rows } = await query(`SELECT id, nombre, data, activo FROM plantillas_legajo ${cond} ORDER BY nombre`);
    res.json(rows);
  } catch (e) { next(e); }
});

router.post('/', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.nombre || !String(b.nombre).trim()) return res.status(400).json({ error: 'El nombre es obligatorio' });
    const r = await query('INSERT INTO plantillas_legajo (nombre, data, activo) VALUES ($1,$2,$3) RETURNING id',
      [String(b.nombre).trim(), JSON.stringify(b.data || {}), b.activo !== false]);
    res.status(201).json({ ok: true, id: r.rows[0].id });
  } catch (e) { next(e); }
});

router.put('/:id', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.nombre || !String(b.nombre).trim()) return res.status(400).json({ error: 'El nombre es obligatorio' });
    const r = await query('UPDATE plantillas_legajo SET nombre=$1, data=$2, activo=$3 WHERE id=$4 RETURNING id',
      [String(b.nombre).trim(), JSON.stringify(b.data || {}), b.activo !== false, req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'No encontrada' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.delete('/:id', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const r = await query('DELETE FROM plantillas_legajo WHERE id=$1', [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'No encontrada' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
