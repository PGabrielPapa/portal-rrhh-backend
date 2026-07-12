import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);
router.use(requireRole('rrhh', 'admin'));
const soloRRHH = requireRole('rrhh', 'admin');

// ── Onboarding: plantilla ──
router.get('/onboarding/plantilla', async (req, res, next) => {
  try { const { rows } = await query('SELECT id, tarea, responsable, orden, activo FROM onboarding_plantilla ORDER BY orden, id'); res.json(rows); }
  catch (e) { next(e); }
});
router.post('/onboarding/plantilla', soloRRHH, async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.tarea || !String(b.tarea).trim()) return res.status(400).json({ error: 'La tarea es obligatoria' });
    const r = await query('INSERT INTO onboarding_plantilla (tarea, responsable, orden, activo) VALUES ($1,$2,$3,true) RETURNING id',
      [String(b.tarea).trim(), b.responsable || null, Number(b.orden) || 0]);
    res.status(201).json({ ok: true, id: r.rows[0].id });
  } catch (e) { next(e); }
});
router.delete('/onboarding/plantilla/:id', soloRRHH, async (req, res, next) => {
  try { const r = await query('DELETE FROM onboarding_plantilla WHERE id=$1', [req.params.id]); if (!r.rowCount) return res.status(404).json({ error: 'No encontrada' }); res.json({ ok: true }); }
  catch (e) { next(e); }
});

// ── Onboarding: por empleado ──
router.get('/onboarding/:empleadoId', async (req, res, next) => {
  try { const { rows } = await query('SELECT id, tarea, responsable, orden, hecho, done_at FROM onboarding WHERE empleado_id=$1 ORDER BY orden, id', [req.params.empleadoId]); res.json(rows); }
  catch (e) { next(e); }
});
// Inicia el onboarding copiando la plantilla activa (si aún no tiene tareas).
router.post('/onboarding/:empleadoId/iniciar', soloRRHH, async (req, res, next) => {
  try {
    const ya = (await query('SELECT count(*)::int AS n FROM onboarding WHERE empleado_id=$1', [req.params.empleadoId])).rows[0].n;
    if (ya > 0) return res.status(409).json({ error: 'El empleado ya tiene un onboarding iniciado' });
    const plant = (await query('SELECT tarea, responsable, orden FROM onboarding_plantilla WHERE activo=true ORDER BY orden, id')).rows;
    for (const t of plant) await query('INSERT INTO onboarding (empleado_id, tarea, responsable, orden) VALUES ($1,$2,$3,$4)', [req.params.empleadoId, t.tarea, t.responsable, t.orden]);
    res.status(201).json({ ok: true, creadas: plant.length });
  } catch (e) { next(e); }
});
router.post('/onboarding/:empleadoId/tarea', soloRRHH, async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.tarea || !String(b.tarea).trim()) return res.status(400).json({ error: 'La tarea es obligatoria' });
    const r = await query('INSERT INTO onboarding (empleado_id, tarea, responsable, orden) VALUES ($1,$2,$3,$4) RETURNING id',
      [req.params.empleadoId, String(b.tarea).trim(), b.responsable || null, Number(b.orden) || 0]);
    res.status(201).json({ ok: true, id: r.rows[0].id });
  } catch (e) { next(e); }
});
router.patch('/onboarding/tarea/:id', async (req, res, next) => {
  try {
    const hecho = !!(req.body || {}).hecho;
    const r = await query('UPDATE onboarding SET hecho=$1, done_at=CASE WHEN $1 THEN now() ELSE NULL END WHERE id=$2 RETURNING id', [hecho, req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'No encontrada' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});
router.delete('/onboarding/tarea/:id', soloRRHH, async (req, res, next) => {
  try { const r = await query('DELETE FROM onboarding WHERE id=$1', [req.params.id]); if (!r.rowCount) return res.status(404).json({ error: 'No encontrada' }); res.json({ ok: true }); }
  catch (e) { next(e); }
});

// ── Sucesión por puesto ──
router.get('/sucesiones/:puestoId', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT s.id, s.empleado_id, s.readiness, s.nota, e.nom, e.leg_num
         FROM sucesiones s JOIN empleados e ON e.id=s.empleado_id WHERE s.puesto_id=$1 ORDER BY e.nom`, [req.params.puestoId]);
    res.json(rows);
  } catch (e) { next(e); }
});
router.post('/sucesiones/:puestoId', soloRRHH, async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.empleadoId) return res.status(400).json({ error: 'Indicá el empleado sucesor' });
    const r = await query('INSERT INTO sucesiones (puesto_id, empleado_id, readiness, nota) VALUES ($1,$2,$3,$4) ON CONFLICT (puesto_id, empleado_id) DO UPDATE SET readiness=EXCLUDED.readiness, nota=EXCLUDED.nota RETURNING id',
      [req.params.puestoId, b.empleadoId, b.readiness || 'mediano', b.nota || null]);
    res.status(201).json({ ok: true, id: r.rows[0].id });
  } catch (e) { next(e); }
});
router.delete('/sucesiones/:id', soloRRHH, async (req, res, next) => {
  try { const r = await query('DELETE FROM sucesiones WHERE id=$1', [req.params.id]); if (!r.rowCount) return res.status(404).json({ error: 'No encontrada' }); res.json({ ok: true }); }
  catch (e) { next(e); }
});

export default router;
