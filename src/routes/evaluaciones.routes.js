import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { idsEquipoDe } from '../lib/equipo.js';

const router = Router();
router.use(requireAuth);
const gestiona = (r) => ['manager', 'rrhh', 'admin'].includes(r);

router.get('/', async (req, res, next) => {
  try {
    if (!gestiona(req.user.role)) {
      const { rows } = await query('SELECT * FROM evaluaciones WHERE empleado_id = $1 ORDER BY created_at DESC', [req.user.id]);
      return res.json(rows);
    }
    const { empresa, q } = req.query; const cond = [], params = [];
    if (req.user.role === 'manager') { const _ids = [...await idsEquipoDe(req.user.id)]; if (!_ids.length) return res.json([]); params.push(_ids); cond.push(`e.id = ANY($${params.length})`); }
    if (empresa) { params.push(empresa); cond.push(`em.nombre = $${params.length}`); }
    if (q) { params.push(`%${String(q).toLowerCase()}%`); const i = params.length; cond.push(`(lower(e.nom) LIKE $${i} OR e.leg_num LIKE $${i})`); }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    const { rows } = await query(
      `SELECT v.*, e.nom, e.leg_num, em.nombre AS empresa FROM evaluaciones v
         JOIN empleados e ON e.id = v.empleado_id JOIN empresas em ON em.id = e.empresa_id
         ${where} ORDER BY v.created_at DESC`, params);
    res.json(rows);
  } catch (e) { next(e); }
});

// GET /api/evaluaciones/mias — SIEMPRE las propias (cualquier rol)
router.get('/mias', async (req, res, next) => {
  try { const { rows } = await query('SELECT * FROM evaluaciones WHERE empleado_id = $1 ORDER BY created_at DESC', [req.user.id]); res.json(rows); }
  catch (e) { next(e); }
});

router.post('/', requireRole('manager', 'rrhh', 'admin'), async (req, res, next) => {
  try {
    const { empleadoId, periodo, tipo, calificacion, comentarios, datos } = req.body || {};
    if (!empleadoId || !periodo) return res.status(400).json({ error: 'empleado y período son obligatorios' });
    // Un gerente solo evalúa a su equipo (organigrama). RR.HH./admin, a cualquiera.
    if (req.user.role === 'manager') {
      const ids = await idsEquipoDe(req.user.id);
      if (!ids.has(Number(empleadoId))) return res.status(403).json({ error: 'Solo podés evaluar a integrantes de tu equipo.' });
    }
    // Promedio de la matriz de competencias (1-5) si viene cargada
    let promedio = null, calif = calificacion || null;
    if (datos && datos.items) {
      const vals = [];
      for (const cat of Object.values(datos.items)) for (const v of Object.values(cat)) { const n = Number(v); if (n > 0) vals.push(n); }
      if (vals.length) {
        promedio = Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100;
        const lbl = { 1: 'Muy Deficiente', 2: 'Deficiente', 3: 'Satisfactorio', 4: 'Bueno', 5: 'Excelente' };
        calif = calif || lbl[Math.round(promedio)] || null;
      }
    }
    const r = await query(
      'INSERT INTO evaluaciones (empleado_id, periodo, tipo, calificacion, comentarios, datos, promedio, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
      [empleadoId, periodo, tipo || null, calif, comentarios || null, JSON.stringify(datos || {}), promedio, req.user.dni]);
    res.status(201).json({ ok: true, id: r.rows[0].id });
  } catch (e) { next(e); }
});

export default router;
