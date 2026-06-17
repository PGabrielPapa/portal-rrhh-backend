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

// ── Período anual de evaluación (lo abre RR.HH., típicamente en octubre) ──
router.get('/periodo', async (req, res, next) => {
  try { const { rows } = await query("SELECT anio, abierto, abierto_at, cerrado_at FROM evaluacion_periodos WHERE tipo='anual' ORDER BY anio DESC LIMIT 1"); res.json(rows[0] || null); }
  catch (e) { next(e); }
});
router.post('/periodo', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const anio = Number((req.body || {}).anio) || new Date().getFullYear();
    await query(`INSERT INTO evaluacion_periodos (anio, tipo, abierto, abierto_por, abierto_at) VALUES ($1,'anual',true,$2,now())
       ON CONFLICT (anio) DO UPDATE SET abierto=true, abierto_por=$2, abierto_at=now(), cerrado_por=NULL, cerrado_at=NULL`, [anio, req.user.dni]);
    res.json({ ok: true, anio, abierto: true });
  } catch (e) { next(e); }
});
router.patch('/periodo/:anio/cerrar', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const r = await query("UPDATE evaluacion_periodos SET abierto=false, cerrado_por=$1, cerrado_at=now() WHERE anio=$2 RETURNING anio", [req.user.dni, req.params.anio]);
    if (!r.rowCount) return res.status(404).json({ error: 'Período no encontrado' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── Pendientes del gerente: período anual abierto + recordatorios de período de prueba (60/120/170 días) ──
router.get('/pendientes', requireRole('manager', 'rrhh', 'admin'), async (req, res, next) => {
  try {
    const ids = [...await idsEquipoDe(req.user.id)];
    const anual = (await query("SELECT anio, abierto FROM evaluacion_periodos WHERE tipo='anual' AND abierto=true ORDER BY anio DESC LIMIT 1")).rows[0] || null;
    if (!ids.length) return res.json({ anual, equipoCount: 0, prueba: [] });
    const emps = (await query("SELECT id, nom, leg_num, ingreso FROM empleados WHERE id = ANY($1) AND activo=true AND ingreso IS NOT NULL", [ids])).rows;
    const evs = (await query("SELECT empleado_id, periodo FROM evaluaciones WHERE empleado_id = ANY($1) AND tipo ILIKE '%prueba%'", [ids])).rows;
    const hoy = new Date(); const hitos = [60, 120, 170]; const prueba = [];
    for (const e of emps) {
      const dias = Math.floor((hoy - new Date(String(e.ingreso).slice(0, 10) + 'T00:00:00')) / 86400000);
      for (const h of hitos) {
        if (dias >= h) {
          const evaluado = evs.some((v) => v.empleado_id === e.id && String(v.periodo || '').includes(String(h)));
          if (!evaluado) prueba.push({ id: e.id, nom: e.nom, legNum: e.leg_num, ingreso: e.ingreso, dias, hito: h });
        }
      }
    }
    prueba.sort((a, b) => b.dias - a.dias);
    res.json({ anual, equipoCount: emps.length, prueba });
  } catch (e) { next(e); }
});

export default router;
