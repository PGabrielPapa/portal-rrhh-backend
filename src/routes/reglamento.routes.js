import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

router.get('/', async (req, res, next) => {
  try { const { rows } = await query('SELECT data FROM reglamento WHERE id=1'); res.json(rows[0]?.data || { vacaciones: [], licencias: [], texto: '' }); }
  catch (e) { next(e); }
});

router.put('/', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const data = req.body || {};
    await query('INSERT INTO reglamento (id, data, updated_by) VALUES (1,$1,$2) ON CONFLICT (id) DO UPDATE SET data=$1, updated_by=$2, updated_at=now()', [JSON.stringify(data), req.user.dni]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
