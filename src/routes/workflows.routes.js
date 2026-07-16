import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
const router = Router();
router.use(requireAuth, requireRole('rrhh', 'admin'));
router.get('/', async (req, res, next) => {
  try { const { rows } = await query('SELECT id, proceso, nombre, pasos, activo, updated_at FROM workflows ORDER BY proceso, nombre'); res.json(rows); }
  catch (e) { next(e); }
});
router.post('/', async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.proceso || !b.nombre) return res.status(400).json({ error: 'Proceso y nombre son obligatorios' });
    const pasos = Array.isArray(b.pasos) ? b.pasos.map((p, i) => ({ orden: Number(p.orden) || i + 1, rol: p.rol || '', etiqueta: p.etiqueta || '', obligatorio: p.obligatorio !== false })) : [];
    const r = await query('INSERT INTO workflows (proceso, nombre, pasos, activo, updated_by) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [b.proceso, String(b.nombre).trim(), JSON.stringify(pasos), b.activo !== false, req.user.dni]);
    res.status(201).json({ ok: true, id: r.rows[0].id });
  } catch (e) { next(e); }
});
router.put('/:id', async (req, res, next) => {
  try {
    const b = req.body || {};
    const pasos = Array.isArray(b.pasos) ? b.pasos.map((p, i) => ({ orden: Number(p.orden) || i + 1, rol: p.rol || '', etiqueta: p.etiqueta || '', obligatorio: p.obligatorio !== false })) : [];
    const r = await query('UPDATE workflows SET proceso=$1, nombre=$2, pasos=$3, activo=$4, updated_by=$5, updated_at=now() WHERE id=$6 RETURNING id',
      [b.proceso, String(b.nombre || '').trim(), JSON.stringify(pasos), b.activo !== false, req.user.dni, req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'No encontrado' }); res.json({ ok: true });
  } catch (e) { next(e); }
});
router.delete('/:id', async (req, res, next) => {
  try { const r = await query('DELETE FROM workflows WHERE id=$1', [req.params.id]); if (!r.rowCount) return res.status(404).json({ error: 'No encontrado' }); res.json({ ok: true }); }
  catch (e) { next(e); }
});
// GET /api/workflows/aplicable?proceso=  — flujo activo para un proceso (para consultar desde los circuitos).
// Accesible a cualquier usuario autenticado (solo lectura de la definición).
router.get('/aplicable', async (req, res, next) => {
  try {
    const proceso = String(req.query.proceso || '');
    const r = (await query('SELECT id, proceso, nombre, pasos FROM workflows WHERE activo AND proceso=$1 ORDER BY updated_at DESC LIMIT 1', [proceso])).rows[0];
    res.json(r || null);
  } catch (e) { next(e); }
});

export default router;
