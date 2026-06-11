import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { calcularRecibo } from '../lib/liquidacion.js';

const router = Router();
router.use(requireAuth);

// POST /api/liquidacion/calcular  { empleadoId, anio, mes }  (rrhh/admin)
router.post('/calcular', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const { empleadoId, anio, mes } = req.body || {};
    if (!empleadoId || !anio || !mes) return res.status(400).json({ error: 'empleadoId, anio y mes son obligatorios' });

    const er = await query(
      `SELECT e.*, em.nombre AS empresa_nombre FROM empleados e JOIN empresas em ON em.id = e.empresa_id WHERE e.id = $1`,
      [empleadoId]
    );
    if (!er.rows[0]) return res.status(404).json({ error: 'Empleado no encontrado' });
    const r = er.rows[0];
    const emp = { legNum: r.leg_num, nom: r.nom, empresa: r.empresa_nombre, cuil: r.cuil, cat: r.cat, ingreso: r.ingreso, bruto: Number(r.bruto), data: r.data || {} };

    const pr = await query('SELECT data FROM parametros_liq WHERE id = 1');
    const params = pr.rows[0]?.data || {};

    res.json(calcularRecibo(emp, params, { anio: Number(anio), mes: Number(mes) }));
  } catch (e) { next(e); }
});

// POST /api/liquidacion/guardar  { empleadoId, anio, mes }  (rrhh/admin)
// Calcula y PERSISTE el recibo (upsert por empleado+período+tipo).
router.post('/guardar', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const { empleadoId, anio, mes } = req.body || {};
    if (!empleadoId || !anio || !mes) return res.status(400).json({ error: 'empleadoId, anio y mes son obligatorios' });
    const er = await query(
      `SELECT e.*, em.nombre AS empresa_nombre FROM empleados e JOIN empresas em ON em.id = e.empresa_id WHERE e.id = $1`,
      [empleadoId]
    );
    if (!er.rows[0]) return res.status(404).json({ error: 'Empleado no encontrado' });
    const r = er.rows[0];
    const emp = { legNum: r.leg_num, nom: r.nom, empresa: r.empresa_nombre, cuil: r.cuil, cat: r.cat, ingreso: r.ingreso, bruto: Number(r.bruto), data: r.data || {} };
    const pr = await query('SELECT data FROM parametros_liq WHERE id = 1');
    const recibo = calcularRecibo(emp, pr.rows[0]?.data || {}, { anio: Number(anio), mes: Number(mes) });
    const ins = await query(
      `INSERT INTO recibos (empleado_id, anio, mes, tipo, neto, data, created_by)
       VALUES ($1,$2,$3,'mensual',$4,$5,$6)
       ON CONFLICT (empleado_id, anio, mes, tipo)
       DO UPDATE SET neto = EXCLUDED.neto, data = EXCLUDED.data, created_by = EXCLUDED.created_by, created_at = now()
       RETURNING id`,
      [empleadoId, Number(anio), Number(mes), recibo.totales.neto, JSON.stringify(recibo), req.user.dni]
    );
    res.json({ ok: true, id: ins.rows[0].id, recibo });
  } catch (e) { next(e); }
});

export default router;
