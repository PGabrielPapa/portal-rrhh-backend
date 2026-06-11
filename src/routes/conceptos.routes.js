import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

const TIPOS = ['remunerativo', 'no_remunerativo', 'descuento', 'aporte', 'contribucion'];

// GET /api/conceptos?q=&tipo=&activos=
router.get('/', async (req, res, next) => {
  try {
    const { q, tipo, activos } = req.query;
    const cond = [], params = [];
    if (tipo) { params.push(tipo); cond.push(`tipo = $${params.length}`); }
    if (activos === 'true') cond.push('activo = true');
    if (q) { params.push(`%${String(q).toLowerCase()}%`); const i = params.length; cond.push(`(lower(descripcion) LIKE $${i} OR codigo LIKE $${i})`); }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    const { rows } = await query(`SELECT * FROM conceptos ${where} ORDER BY codigo`, params);
    res.json(rows);
  } catch (e) { next(e); }
});

// POST /api/conceptos  (rrhh/admin)
router.post('/', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.codigo || !b.descripcion) return res.status(400).json({ error: 'Código y descripción son obligatorios' });
    const tipo = TIPOS.includes(b.tipo) ? b.tipo : 'remunerativo';
    const { rows } = await query(
      `INSERT INTO conceptos (codigo, descripcion, tipo, formula, base_legal) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [String(b.codigo).trim(), String(b.descripcion).trim(), tipo, b.formula || null, b.base_legal || null]
    );
    res.status(201).json(rows[0]);
  } catch (e) { next(e); }
});

// PUT /api/conceptos/:id  (rrhh/admin)
router.put('/:id', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const fields = { descripcion: b.descripcion, tipo: TIPOS.includes(b.tipo) ? b.tipo : undefined, formula: b.formula, base_legal: b.base_legal };
    const sets = [], params = [];
    for (const [k, v] of Object.entries(fields)) { if (v !== undefined) { params.push(v); sets.push(`${k} = $${params.length}`); } }
    if (!sets.length) return res.status(400).json({ error: 'Nada para actualizar' });
    params.push(req.params.id);
    const { rows } = await query(`UPDATE conceptos SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
    if (!rows[0]) return res.status(404).json({ error: 'Concepto no encontrado' });
    res.json(rows[0]);
  } catch (e) { next(e); }
});

// PATCH /api/conceptos/:id/activo  (rrhh/admin)
router.patch('/:id/activo', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    await query('UPDATE conceptos SET activo = $1 WHERE id = $2', [!!(req.body || {}).activo, req.params.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
