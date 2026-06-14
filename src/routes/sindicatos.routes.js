import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

const map = (r) => ({ id: r.id, codigo: r.codigo, nombre: r.nombre, pctEmpleado: Number(r.pct_empleado), pctPatronal: Number(r.pct_patronal), pctAntigPorAnio: Number(r.pct_antig_por_anio), nota: r.nota, tieneAdicionalTitulo: r.tiene_adicional_titulo, presBase: r.pres_base });

router.get('/', async (req, res, next) => {
  try { const { rows } = await query('SELECT * FROM sindicatos ORDER BY codigo'); res.json(rows.map(map)); }
  catch (e) { next(e); }
});

router.post('/', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.codigo || !b.nombre) return res.status(400).json({ error: 'Código y nombre son obligatorios' });
    const ins = await query(
      `INSERT INTO sindicatos (codigo, nombre, pct_empleado, pct_patronal, pct_antig_por_anio, nota, tiene_adicional_titulo, pres_base, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (codigo) DO UPDATE SET nombre=EXCLUDED.nombre, pct_empleado=EXCLUDED.pct_empleado, pct_patronal=EXCLUDED.pct_patronal,
         pct_antig_por_anio=EXCLUDED.pct_antig_por_anio, nota=EXCLUDED.nota, tiene_adicional_titulo=EXCLUDED.tiene_adicional_titulo, pres_base=EXCLUDED.pres_base, updated_by=EXCLUDED.updated_by, updated_at=now()
       RETURNING *`,
      [String(b.codigo).toUpperCase(), b.nombre, b.pctEmpleado || 0, b.pctPatronal || 0, b.pctAntigPorAnio || 1, b.nota || null, !!b.tieneAdicionalTitulo, b.presBase || 'basico', req.user.dni]
    );
    res.status(201).json(map(ins.rows[0]));
  } catch (e) { next(e); }
});

router.put('/:id', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const r = await query(
      `UPDATE sindicatos SET nombre=$1, pct_empleado=$2, pct_patronal=$3, pct_antig_por_anio=$4, nota=$5, tiene_adicional_titulo=$6, pres_base=$7, updated_by=$8, updated_at=now() WHERE id=$9 RETURNING *`,
      [b.nombre, b.pctEmpleado || 0, b.pctPatronal || 0, b.pctAntigPorAnio || 1, b.nota || null, !!b.tieneAdicionalTitulo, b.presBase || 'basico', req.user.dni, req.params.id]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'No encontrado' });
    res.json(map(r.rows[0]));
  } catch (e) { next(e); }
});

router.delete('/:id', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try { const r = await query('DELETE FROM sindicatos WHERE id=$1 RETURNING id', [req.params.id]); if (!r.rowCount) return res.status(404).json({ error: 'No encontrado' }); res.json({ ok: true }); }
  catch (e) { next(e); }
});

export default router;
