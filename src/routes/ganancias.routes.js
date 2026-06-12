import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { calcularF1357 } from '../lib/liquidacion.js';

const router = Router();
router.use(requireAuth);

const gestiona = (role) => ['rrhh', 'admin'].includes(role);

async function f1357For(empleadoId, anio, mes) {
  const er = await query(
    `SELECT e.*, em.nombre AS empresa_nombre FROM empleados e JOIN empresas em ON em.id = e.empresa_id WHERE e.id = $1`,
    [empleadoId]
  );
  if (!er.rows[0]) return null;
  const r = er.rows[0];
  const emp = { legNum: r.leg_num, nom: r.nom, empresa: r.empresa_nombre, cuil: r.cuil, cat: r.cat, ingreso: r.ingreso, bruto: Number(r.bruto), data: r.data || {} };
  const pr = await query('SELECT data FROM parametros_liq WHERE id = 1');
  const fr = await query('SELECT tipo, discapacidad, vigencia_hasta FROM familiares WHERE empleado_id = $1', [empleadoId]);
  return calcularF1357(emp, pr.rows[0]?.data || {}, fr.rows, { anio, mes });
}

const hoy = () => { const d = new Date(); return { anio: d.getFullYear(), mes: d.getMonth() + 1 }; };

// GET /api/ganancias/f1357?anio=&mes=  — F.1357 del propio empleado
router.get('/f1357', async (req, res, next) => {
  try {
    const def = hoy();
    const anio = Number(req.query.anio) || def.anio;
    const mes = Number(req.query.mes) || def.mes;
    const out = await f1357For(req.user.id, anio, mes);
    if (!out) return res.status(404).json({ error: 'Empleado no encontrado' });
    res.json(out);
  } catch (e) { next(e); }
});

// GET /api/ganancias/f1357/:empleadoId?anio=&mes=  — F.1357 de un empleado (RR.HH./admin)
router.get('/f1357/:empleadoId', async (req, res, next) => {
  try {
    if (!gestiona(req.user.role)) return res.status(403).json({ error: 'No autorizado' });
    const def = hoy();
    const anio = Number(req.query.anio) || def.anio;
    const mes = Number(req.query.mes) || def.mes;
    const out = await f1357For(Number(req.params.empleadoId), anio, mes);
    if (!out) return res.status(404).json({ error: 'Empleado no encontrado' });
    res.json(out);
  } catch (e) { next(e); }
});

export default router;
