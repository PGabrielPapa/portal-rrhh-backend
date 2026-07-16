import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth, requireRole('rrhh', 'admin'));

const norm = (tr) => (Array.isArray(tr) ? tr : []).map((t) => ({ hastaAnios: Number(t.hastaAnios) || 0, basico: Number(t.basico) || 0 }))
  .filter((t) => t.basico > 0).sort((a, b) => a.hastaAnios - b.hastaAnios);

router.get('/', async (req, res, next) => {
  try { const { rows } = await query('SELECT id, nombre, convenio, categoria, tramos, activo, updated_at FROM matriz_antiguedad ORDER BY nombre'); res.json(rows); }
  catch (e) { next(e); }
});
router.post('/', async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.nombre || !String(b.nombre).trim()) return res.status(400).json({ error: 'El nombre es obligatorio' });
    const r = await query('INSERT INTO matriz_antiguedad (nombre, convenio, categoria, tramos, activo, updated_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [String(b.nombre).trim(), b.convenio || null, b.categoria || null, JSON.stringify(norm(b.tramos)), b.activo !== false, req.user?.dni || '']);
    res.status(201).json({ ok: true, id: r.rows[0].id });
  } catch (e) { next(e); }
});
router.put('/:id', async (req, res, next) => {
  try {
    const b = req.body || {};
    const r = await query('UPDATE matriz_antiguedad SET nombre=$1, convenio=$2, categoria=$3, tramos=$4, activo=$5, updated_by=$6, updated_at=now() WHERE id=$7 RETURNING id',
      [String(b.nombre || '').trim(), b.convenio || null, b.categoria || null, JSON.stringify(norm(b.tramos)), b.activo !== false, req.user?.dni || '', req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'No encontrada' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});
router.delete('/:id', async (req, res, next) => {
  try { const r = await query('DELETE FROM matriz_antiguedad WHERE id=$1', [req.params.id]); if (!r.rowCount) return res.status(404).json({ error: 'No encontrada' }); res.json({ ok: true }); }
  catch (e) { next(e); }
});

export default router;
