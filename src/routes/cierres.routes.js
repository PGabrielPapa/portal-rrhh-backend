import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// Helper exportable para chequear si un período está cerrado.
export async function periodoCerrado(empresa, anio, mes) {
  if (!empresa) return false;
  const r = await query('SELECT 1 FROM cierres_periodo WHERE empresa=$1 AND anio=$2 AND mes=$3', [empresa, Number(anio), Number(mes)]);
  return r.rowCount > 0;
}

router.get('/', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try { const { rows } = await query('SELECT * FROM cierres_periodo ORDER BY anio DESC, mes DESC, empresa'); res.json(rows); }
  catch (e) { next(e); }
});

// POST /api/cierres { empresa, anio, mes } — cerrar (solo admin)
router.post('/', requireRole('admin'), async (req, res, next) => {
  try {
    const { empresa, anio, mes } = req.body || {};
    if (!empresa || !anio || !mes) return res.status(400).json({ error: 'empresa, anio y mes son obligatorios' });
    await query('INSERT INTO cierres_periodo (empresa, anio, mes, cerrado_por) VALUES ($1,$2,$3,$4) ON CONFLICT (empresa, anio, mes) DO NOTHING', [empresa, Number(anio), Number(mes), req.user.dni]);
    res.status(201).json({ ok: true });
  } catch (e) { next(e); }
});

// DELETE /api/cierres { empresa, anio, mes } — reabrir (solo admin)
router.delete('/', requireRole('admin'), async (req, res, next) => {
  try {
    const { empresa, anio, mes } = req.query || {};
    const r = await query('DELETE FROM cierres_periodo WHERE empresa=$1 AND anio=$2 AND mes=$3 RETURNING id', [empresa, Number(anio), Number(mes)]);
    if (!r.rowCount) return res.status(404).json({ error: 'No estaba cerrado' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
