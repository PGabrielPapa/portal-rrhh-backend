import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// GET /api/parametros — parámetros de liquidación vigentes
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT data, updated_by, updated_at FROM parametros_liq WHERE id = 1');
    res.json(rows[0] || { data: {} });
  } catch (e) { next(e); }
});

// PUT /api/parametros  (rrhh/admin) — merge superficial de los campos enviados
router.put('/', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const patch = req.body || {};
    if (typeof patch !== 'object' || Array.isArray(patch)) return res.status(400).json({ error: 'Cuerpo inválido' });
    const { rows } = await query(
      `UPDATE parametros_liq SET data = data || $1::jsonb, updated_by = $2, updated_at = now()
        WHERE id = 1 RETURNING data, updated_by, updated_at`,
      [JSON.stringify(patch), req.user.dni]
    );
    res.json(rows[0]);
  } catch (e) { next(e); }
});

export default router;
