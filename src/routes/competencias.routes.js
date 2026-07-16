import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
const router = Router();
router.use(requireAuth);
router.get('/', async (req, res, next) => {
  try { const { rows } = await query('SELECT id, nombre, categoria, descripcion, niveles, activo FROM competencias WHERE activo OR $1 ORDER BY categoria NULLS FIRST, nombre', [req.query.todas === '1']); res.json(rows); }
  catch (e) { next(e); }
});
router.post('/', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.nombre || !String(b.nombre).trim()) return res.status(400).json({ error: 'El nombre es obligatorio' });
    const r = await query('INSERT INTO competencias (nombre, categoria, descripcion, niveles, activo) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [String(b.nombre).trim(), b.categoria || null, b.descripcion || null, JSON.stringify(Array.isArray(b.niveles) ? b.niveles : []), b.activo !== false]);
    res.status(201).json({ ok: true, id: r.rows[0].id });
  } catch (e) { next(e); }
});
router.put('/:id', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const r = await query('UPDATE competencias SET nombre=$1, categoria=$2, descripcion=$3, niveles=$4, activo=$5 WHERE id=$6 RETURNING id',
      [String(b.nombre || '').trim(), b.categoria || null, b.descripcion || null, JSON.stringify(Array.isArray(b.niveles) ? b.niveles : []), b.activo !== false, req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'No encontrada' }); res.json({ ok: true });
  } catch (e) { next(e); }
});
router.delete('/:id', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try { const r = await query('DELETE FROM competencias WHERE id=$1', [req.params.id]); if (!r.rowCount) return res.status(404).json({ error: 'No encontrada' }); res.json({ ok: true }); }
  catch (e) { next(e); }
});
export default router;
