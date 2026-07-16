import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
const router = Router();
router.use(requireAuth);
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT u.*, r.nom AS responsable_nom,
              (SELECT COUNT(*)::int FROM empleados e WHERE e.activo AND (e.data->>'unidadId')=u.id::text) AS ocupantes
         FROM unidades_org u LEFT JOIN empleados r ON r.id=u.responsable_id ORDER BY u.nombre`);
    res.json(rows.map((u) => ({ id: u.id, nombre: u.nombre, tipo: u.tipo, padreId: u.padre_id, responsableId: u.responsable_id, responsableNom: u.responsable_nom, empresa: u.empresa, activo: u.activo, ocupantes: u.ocupantes })));
  } catch (e) { next(e); }
});
router.post('/', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.nombre || !String(b.nombre).trim()) return res.status(400).json({ error: 'El nombre es obligatorio' });
    const r = await query('INSERT INTO unidades_org (nombre, tipo, padre_id, responsable_id, empresa, activo) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [String(b.nombre).trim(), b.tipo || 'area', b.padreId || null, b.responsableId || null, b.empresa || null, b.activo !== false]);
    res.status(201).json({ ok: true, id: r.rows[0].id });
  } catch (e) { next(e); }
});
router.put('/:id', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const b = req.body || {};
    if (Number(b.padreId) === Number(req.params.id)) return res.status(400).json({ error: 'Una unidad no puede depender de sí misma' });
    const r = await query('UPDATE unidades_org SET nombre=$1, tipo=$2, padre_id=$3, responsable_id=$4, empresa=$5, activo=$6 WHERE id=$7 RETURNING id',
      [String(b.nombre || '').trim(), b.tipo || 'area', b.padreId || null, b.responsableId || null, b.empresa || null, b.activo !== false, req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'No encontrada' }); res.json({ ok: true });
  } catch (e) { next(e); }
});
router.delete('/:id', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try { const r = await query('DELETE FROM unidades_org WHERE id=$1', [req.params.id]); if (!r.rowCount) return res.status(404).json({ error: 'No encontrada' }); res.json({ ok: true }); }
  catch (e) { next(e); }
});
export default router;
