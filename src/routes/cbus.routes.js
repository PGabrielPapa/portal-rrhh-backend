import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// GET /api/cbus — CBUs del propio usuario
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await query(
      'SELECT id, cbu, banco, alias, titular, activo, created_at FROM cbus WHERE empleado_id = $1 ORDER BY created_at DESC',
      [req.user.id]
    );
    res.json(rows);
  } catch (e) { next(e); }
});

// POST /api/cbus — agregar un CBU propio
router.post('/', async (req, res, next) => {
  try {
    const { cbu, banco, alias, titular } = req.body || {};
    const digits = String(cbu || '').replace(/\D/g, '');
    if (digits.length !== 22) return res.status(400).json({ error: 'El CBU debe tener 22 dígitos' });
    const ins = await query(
      'INSERT INTO cbus (empleado_id, cbu, banco, alias, titular) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [req.user.id, digits, banco || null, alias || null, titular || null]
    );
    res.status(201).json({ ok: true, id: ins.rows[0].id });
  } catch (e) { next(e); }
});

// PATCH /api/cbus/:id/activo — activar/desactivar (solo propios)
router.patch('/:id/activo', async (req, res, next) => {
  try {
    const activo = !!(req.body || {}).activo;
    const r = await query('UPDATE cbus SET activo = $1 WHERE id = $2 AND empleado_id = $3', [activo, req.params.id, req.user.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'CBU no encontrado' });
    res.json({ ok: true, activo });
  } catch (e) { next(e); }
});

export default router;
