import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { historialDe } from '../lib/configHist.js';

const router = Router();
router.use(requireAuth);

router.get('/', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try { res.json(await historialDe(String(req.query.modulo || ''), req.query.ref ? String(req.query.ref) : null)); }
  catch (e) { next(e); }
});

export default router;
