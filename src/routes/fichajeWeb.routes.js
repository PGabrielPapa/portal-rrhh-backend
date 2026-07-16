import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// GET /api/fichaje/mias — marcas del empleado (por defecto, las de hoy).
router.get('/mias', async (req, res, next) => {
  try {
    const desde = String(req.query.desde || new Date().toISOString().slice(0, 10)) + ' 00:00:00';
    const { rows } = await query(
      'SELECT id, ts, tipo, lat, lng, precision_m FROM fichadas_web WHERE empleado_id=$1 AND ts >= $2 ORDER BY ts DESC', [req.user.id, desde]);
    // sugerir el próximo tipo (alterna a partir de la última marca del día)
    const ult = rows[0];
    const proximo = ult && ult.tipo === 'entrada' ? 'salida' : 'entrada';
    res.json({ marcas: rows, proximo });
  } catch (e) { next(e); }
});

// POST /api/fichaje — el empleado registra una marca (entrada/salida) con geolocalización opcional.
router.post('/', async (req, res, next) => {
  try {
    const b = req.body || {};
    let tipo = b.tipo === 'salida' ? 'salida' : (b.tipo === 'entrada' ? 'entrada' : null);
    if (!tipo) {
      const ult = (await query("SELECT tipo FROM fichadas_web WHERE empleado_id=$1 AND ts::date=CURRENT_DATE ORDER BY ts DESC LIMIT 1", [req.user.id])).rows[0];
      tipo = ult && ult.tipo === 'entrada' ? 'salida' : 'entrada';
    }
    const lat = b.lat != null ? Number(b.lat) : null;
    const lng = b.lng != null ? Number(b.lng) : null;
    const prec = b.precision != null ? Number(b.precision) : null;
    const r = await query(
      'INSERT INTO fichadas_web (empleado_id, tipo, lat, lng, precision_m) VALUES ($1,$2,$3,$4,$5) RETURNING id, ts, tipo',
      [req.user.id, tipo, lat, lng, prec]);
    res.status(201).json({ ok: true, ...r.rows[0] });
  } catch (e) { next(e); }
});

// GET /api/fichaje — consulta para RR.HH. (por fecha y/o empleado). No mezcla con Pro-Soft.
router.get('/', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const dia = String(req.query.dia || new Date().toISOString().slice(0, 10));
    const cond = ['w.ts::date = $1'], args = [dia];
    if (req.query.empleadoId) { args.push(req.query.empleadoId); cond.push(`w.empleado_id = $${args.length}`); }
    const { rows } = await query(
      `SELECT w.id, w.ts, w.tipo, w.lat, w.lng, w.precision_m, e.nom, e.leg_num, em.nombre AS empresa
         FROM fichadas_web w JOIN empleados e ON e.id=w.empleado_id JOIN empresas em ON em.id=e.empresa_id
        WHERE ${cond.join(' AND ')} ORDER BY em.nombre, e.nom, w.ts`, args);
    res.json(rows);
  } catch (e) { next(e); }
});

export default router;
