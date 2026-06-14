import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

const map = (r) => ({ id: r.id, codigo: r.codigo, nombre: r.nombre, cct: r.cct, vigencia: r.vigencia, ...r.data });

// GET /api/convenios — lista de convenios por sindicato
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM convenios ORDER BY codigo');
    res.json(rows.map(map));
  } catch (e) { next(e); }
});

// GET /api/convenios/:codigo
router.get('/:codigo', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM convenios WHERE codigo = $1', [String(req.params.codigo).toUpperCase()]);
    if (!rows[0]) return res.status(404).json({ error: 'Convenio no encontrado' });
    res.json(map(rows[0]));
  } catch (e) { next(e); }
});

export default router;
