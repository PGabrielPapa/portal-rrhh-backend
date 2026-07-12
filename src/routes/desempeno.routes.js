import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);
router.use(requireRole('rrhh', 'admin', 'manager'));

const map = (r) => ({ id: r.id, empleadoId: r.empleado_id, anio: r.anio, desempeno: r.desempeno, potencial: r.potencial,
  objetivos: r.objetivos || [], competencias: r.competencias || [], nota: r.nota, updatedBy: r.updated_by, updatedAt: r.updated_at,
  nom: r.nom, legNum: r.leg_num, empresa: r.empresa });

// GET /api/desempeno?anio= — todas las fichas del año (con datos del empleado).
router.get('/', async (req, res, next) => {
  try {
    const anio = Number(req.query.anio) || new Date().getFullYear();
    const { rows } = await query(
      `SELECT d.*, e.nom, e.leg_num, em.nombre AS empresa
         FROM desempeno d JOIN empleados e ON e.id=d.empleado_id JOIN empresas em ON em.id=e.empresa_id
        WHERE d.anio=$1 ORDER BY em.nombre, e.nom`, [anio]);
    res.json(rows.map(map));
  } catch (e) { next(e); }
});

// GET /api/desempeno/9box?anio= — grilla 9-box con empleados por celda.
router.get('/9box', async (req, res, next) => {
  try {
    const anio = Number(req.query.anio) || new Date().getFullYear();
    const { rows } = await query(
      `SELECT d.empleado_id, d.desempeno, d.potencial, e.nom, e.leg_num
         FROM desempeno d JOIN empleados e ON e.id=d.empleado_id
        WHERE d.anio=$1 AND d.desempeno IS NOT NULL AND d.potencial IS NOT NULL`, [anio]);
    const celdas = {};
    for (let pot = 3; pot >= 1; pot--) for (let des = 1; des <= 3; des++) celdas[`${pot}-${des}`] = [];
    for (const r of rows) { const k = `${r.potencial}-${r.desempeno}`; if (celdas[k]) celdas[k].push({ empleadoId: r.empleado_id, nom: r.nom, legNum: r.leg_num }); }
    res.json({ anio, celdas });
  } catch (e) { next(e); }
});

// GET /api/desempeno/:empleadoId?anio=
router.get('/:empleadoId', async (req, res, next) => {
  try {
    const anio = Number(req.query.anio) || new Date().getFullYear();
    const r = (await query('SELECT * FROM desempeno WHERE empleado_id=$1 AND anio=$2', [req.params.empleadoId, anio])).rows[0];
    res.json(r ? map(r) : { empleadoId: Number(req.params.empleadoId), anio, objetivos: [], competencias: [] });
  } catch (e) { next(e); }
});

// PUT /api/desempeno/:empleadoId — upsert de la ficha del año.
router.put('/:empleadoId', async (req, res, next) => {
  try {
    const b = req.body || {};
    const anio = Number(b.anio) || new Date().getFullYear();
    const d = b.desempeno != null && b.desempeno !== '' ? Number(b.desempeno) : null;
    const p = b.potencial != null && b.potencial !== '' ? Number(b.potencial) : null;
    await query(
      `INSERT INTO desempeno (empleado_id, anio, desempeno, potencial, objetivos, competencias, nota, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (empleado_id, anio) DO UPDATE SET desempeno=EXCLUDED.desempeno, potencial=EXCLUDED.potencial,
         objetivos=EXCLUDED.objetivos, competencias=EXCLUDED.competencias, nota=EXCLUDED.nota, updated_by=EXCLUDED.updated_by, updated_at=now()`,
      [req.params.empleadoId, anio, d, p, JSON.stringify(Array.isArray(b.objetivos) ? b.objetivos : []), JSON.stringify(Array.isArray(b.competencias) ? b.competencias : []), b.nota || null, req.user.dni]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
