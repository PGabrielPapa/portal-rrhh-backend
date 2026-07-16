import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
const router = Router();
router.use(requireAuth, requireRole('rrhh', 'admin'));
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT p.*, pu.nombre AS puesto_nom, u.nombre AS unidad_nom,
              (SELECT COUNT(*)::int FROM empleados e WHERE e.activo AND p.puesto_id IS NOT NULL AND e.puesto_id=p.puesto_id) AS ocupadas
         FROM posiciones p LEFT JOIN puestos pu ON pu.id=p.puesto_id LEFT JOIN unidades_org u ON u.id=p.unidad_id
        WHERE p.activo ORDER BY p.nombre`);
    res.json(rows.map((p) => { const oc = p.puesto_id ? p.ocupadas : 0; return { id: p.id, nombre: p.nombre, puestoId: p.puesto_id, puesto: p.puesto_nom, unidadId: p.unidad_id, unidad: p.unidad_nom, empresa: p.empresa, dotacion: p.dotacion, estado: p.estado, ocupadas: oc, vacantes: Math.max(0, p.dotacion - oc) }; }));
  } catch (e) { next(e); }
});
router.post('/', async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.nombre || !String(b.nombre).trim()) return res.status(400).json({ error: 'El nombre es obligatorio' });
    const r = await query('INSERT INTO posiciones (nombre, puesto_id, unidad_id, empresa, dotacion, estado, nota) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
      [String(b.nombre).trim(), b.puestoId || null, b.unidadId || null, b.empresa || null, Number(b.dotacion) || 1, b.estado || 'abierta', b.nota || null]);
    res.status(201).json({ ok: true, id: r.rows[0].id });
  } catch (e) { next(e); }
});
router.put('/:id', async (req, res, next) => {
  try {
    const b = req.body || {};
    const r = await query('UPDATE posiciones SET nombre=$1, puesto_id=$2, unidad_id=$3, empresa=$4, dotacion=$5, estado=$6, nota=$7 WHERE id=$8 RETURNING id',
      [String(b.nombre || '').trim(), b.puestoId || null, b.unidadId || null, b.empresa || null, Number(b.dotacion) || 1, b.estado || 'abierta', b.nota || null, req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'No encontrada' }); res.json({ ok: true });
  } catch (e) { next(e); }
});
router.delete('/:id', async (req, res, next) => {
  try { const r = await query('DELETE FROM posiciones WHERE id=$1', [req.params.id]); if (!r.rowCount) return res.status(404).json({ error: 'No encontrada' }); res.json({ ok: true }); }
  catch (e) { next(e); }
});
export default router;
