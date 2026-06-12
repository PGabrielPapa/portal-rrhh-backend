import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);
const gestiona = (role) => ['manager', 'rrhh', 'admin'].includes(role);

function diasEntre(desde, hasta) {
  const d1 = new Date(desde + 'T12:00:00'), d2 = new Date(hasta + 'T12:00:00');
  return Math.round((d2 - d1) / 86400000) + 1;
}

// GET /api/licencias — propias; gestores ven todas (pendientes primero)
router.get('/', async (req, res, next) => {
  try {
    if (gestiona(req.user.role)) {
      const { estado, empresa, q } = req.query;
      const cond = [], params = [];
      // El gerente ve solo su empresa (proxy de "equipo" hasta tener organigrama).
      if (req.user.role === 'manager') { params.push(req.user.empresa_id); cond.push(`e.empresa_id = $${params.length}`); }
      if (estado) { params.push(estado); cond.push(`l.estado = $${params.length}`); }
      if (empresa) { params.push(empresa); cond.push(`em.nombre = $${params.length}`); }
      if (q) { params.push(`%${String(q).toLowerCase()}%`); const i = params.length; cond.push(`(lower(e.nom) LIKE $${i} OR e.leg_num LIKE $${i})`); }
      const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
      const { rows } = await query(
        `SELECT l.*, e.nom, e.leg_num, em.nombre AS empresa
           FROM licencias l JOIN empleados e ON e.id = l.empleado_id
           JOIN empresas em ON em.id = e.empresa_id
          ${where}
          ORDER BY (l.estado='pendiente') DESC, l.created_at DESC`,
        params
      );
      return res.json(rows);
    }
    const { rows } = await query('SELECT * FROM licencias WHERE empleado_id = $1 ORDER BY created_at DESC', [req.user.id]);
    res.json(rows);
  } catch (e) { next(e); }
});

// Días de vacaciones por antigüedad (Art. 150 LCT) + saldo
function diasPorAntiguedad(anios) {
  if (anios < 5) return 14; if (anios < 10) return 21; if (anios < 20) return 28; return 35;
}
// GET /api/licencias/vacaciones-info — del propio empleado
router.get('/vacaciones-info', async (req, res, next) => {
  try {
    const er = await query('SELECT ingreso FROM empleados WHERE id=$1', [req.user.id]);
    const ingreso = er.rows[0]?.ingreso;
    const anio = new Date().getFullYear();
    let antiguedad = 0;
    if (ingreso) { const i = new Date(ingreso); antiguedad = Math.max(0, anio - i.getFullYear()); } // antigüedad al 31/12
    const corresponden = diasPorAntiguedad(antiguedad);
    // Días de vacaciones aprobadas por año (extract del desde)
    const tr = await query(
      `SELECT EXTRACT(YEAR FROM desde)::int AS anio, COALESCE(SUM(dias),0)::int AS dias
         FROM licencias WHERE empleado_id=$1 AND lower(tipo)='vacaciones' AND estado='aprobada'
         GROUP BY 1`, [req.user.id]);
    const tomadosPorAnio = Object.fromEntries(tr.rows.map((r) => [r.anio, r.dias]));
    const tomadosEsteAnio = tomadosPorAnio[anio] || 0;
    const saldoEsteAnio = corresponden - tomadosEsteAnio;
    // Saldo de años anteriores (no usados), simple: suma de (corresponden(año) - tomados(año)) > 0
    let saldoAnteriores = 0;
    for (let y = anio - 2; y < anio; y++) {
      if (!ingreso) break;
      const antY = Math.max(0, y - new Date(ingreso).getFullYear());
      if (antY < 0) continue;
      const corrY = diasPorAntiguedad(antY);
      const tomY = tomadosPorAnio[y] || 0;
      if (new Date(ingreso).getFullYear() <= y) saldoAnteriores += Math.max(0, corrY - tomY);
    }
    res.json({ antiguedad, corresponden, tomadosEsteAnio, saldoEsteAnio, saldoAnteriores, anio });
  } catch (e) { next(e); }
});

// GET /api/licencias/mias — SIEMPRE las propias (cualquier rol)
router.get('/mias', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM licencias WHERE empleado_id = $1 ORDER BY created_at DESC', [req.user.id]);
    res.json(rows);
  } catch (e) { next(e); }
});

// POST /api/licencias — solicitar (propia)
router.post('/', async (req, res, next) => {
  try {
    const { tipo, desde, hasta, motivo } = req.body || {};
    if (!tipo || !desde || !hasta) return res.status(400).json({ error: 'Tipo, desde y hasta son obligatorios' });
    if (hasta < desde) return res.status(400).json({ error: 'La fecha hasta debe ser posterior a desde' });
    const dias = diasEntre(desde, hasta);
    const ins = await query(
      'INSERT INTO licencias (empleado_id, tipo, desde, hasta, dias, motivo) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [req.user.id, tipo, desde, hasta, dias, motivo || null]
    );
    res.status(201).json(ins.rows[0]);
  } catch (e) { next(e); }
});

// POST /api/licencias/registrar — RR.HH. carga una licencia para un empleado
// (queda APROBADA directamente). { empleadoId, tipo, desde, hasta, motivo }
router.post('/registrar', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const { empleadoId, tipo, desde, hasta, motivo } = req.body || {};
    if (!empleadoId || !tipo || !desde || !hasta) return res.status(400).json({ error: 'empleadoId, tipo, desde y hasta son obligatorios' });
    if (hasta < desde) return res.status(400).json({ error: 'La fecha hasta debe ser posterior a desde' });
    const dias = diasEntre(desde, hasta);
    const ins = await query(
      `INSERT INTO licencias (empleado_id, tipo, desde, hasta, dias, motivo, estado, resuelto_por, resuelto_at)
       VALUES ($1,$2,$3,$4,$5,$6,'aprobada',$7,now()) RETURNING id`,
      [empleadoId, tipo, desde, hasta, dias, motivo || null, req.user.dni]
    );
    res.status(201).json({ ok: true, id: ins.rows[0].id });
  } catch (e) { next(e); }
});

// PATCH /api/licencias/:id — aprobar/rechazar (gestores)
router.patch('/:id', requireRole('manager', 'rrhh', 'admin'), async (req, res, next) => {
  try {
    const estado = (req.body || {}).estado;
    if (!['aprobada', 'rechazada'].includes(estado)) return res.status(400).json({ error: 'Estado inválido' });
    const r = await query(
      `UPDATE licencias SET estado=$1, resuelto_por=$2, resuelto_at=now() WHERE id=$3 AND estado='pendiente' RETURNING id`,
      [estado, req.user.dni, req.params.id]
    );
    if (!r.rowCount) return res.status(409).json({ error: 'La licencia no existe o ya fue resuelta' });
    res.json({ ok: true, estado });
  } catch (e) { next(e); }
});

export default router;
