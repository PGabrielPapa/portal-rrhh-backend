import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { idsEquipoDe } from '../lib/equipo.js';

const router = Router();
router.use(requireAuth);

const puedeAprobar = (role) => ['manager', 'rrhh', 'admin'].includes(role);

// GET /api/anticipos — propios; rrhh/manager/admin ven todos
router.get('/', async (req, res, next) => {
  try {
    if (puedeAprobar(req.user.role)) {
      const cond = [], params = [];
      if (req.user.role === 'manager') {
        const ids = [...await idsEquipoDe(req.user.id)];
        if (!ids.length) return res.json([]);
        params.push(ids); cond.push(`a.empleado_id = ANY($${params.length})`);
      }
      const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
      const { rows } = await query(
        `SELECT a.*, COALESCE(cu.pagadas,0)::int AS cuotas_pagadas, COALESCE(cu.total_pagado,0)::float AS total_pagado,
                e.nom, e.leg_num, em.nombre AS empresa, e.bruto::float AS bruto,
                COALESCE((SELECT r.neto FROM recibos r WHERE r.empleado_id=a.empleado_id ORDER BY r.anio DESC, r.mes DESC LIMIT 1), e.neto)::float AS ultimo_neto
           FROM anticipos a
           LEFT JOIN (SELECT anticipo_id, COUNT(*) AS pagadas, SUM(monto) AS total_pagado FROM anticipo_cuotas GROUP BY anticipo_id) cu ON cu.anticipo_id = a.id
           JOIN empleados e ON e.id = a.empleado_id
           JOIN empresas em ON em.id = e.empresa_id
          ${where}
          ORDER BY (a.estado='pendiente') DESC, a.created_at DESC`, params
      );
      return res.json(rows);
    }
    const { rows } = await query(`SELECT a.*, COALESCE(cu.pagadas,0)::int AS cuotas_pagadas, COALESCE(cu.total_pagado,0)::float AS total_pagado FROM anticipos a
           LEFT JOIN (SELECT anticipo_id, COUNT(*) AS pagadas, SUM(monto) AS total_pagado FROM anticipo_cuotas GROUP BY anticipo_id) cu ON cu.anticipo_id = a.id WHERE a.empleado_id = $1 ORDER BY a.created_at DESC`, [req.user.id]);
    res.json(rows);
  } catch (e) { next(e); }
});

// GET /api/anticipos/mias — SIEMPRE los propios (cualquier rol)
router.get('/mias', async (req, res, next) => {
  try {
    const { rows } = await query(`SELECT a.*, COALESCE(cu.pagadas,0)::int AS cuotas_pagadas, COALESCE(cu.total_pagado,0)::float AS total_pagado FROM anticipos a
           LEFT JOIN (SELECT anticipo_id, COUNT(*) AS pagadas, SUM(monto) AS total_pagado FROM anticipo_cuotas GROUP BY anticipo_id) cu ON cu.anticipo_id = a.id WHERE a.empleado_id = $1 ORDER BY a.created_at DESC`, [req.user.id]);
    res.json(rows);
  } catch (e) { next(e); }
});

// POST /api/anticipos — solicitar (propio)
router.post('/', async (req, res, next) => {
  try {
    const monto = parseFloat((req.body || {}).monto);
    const { motivo } = req.body || {};
    const cuotas = parseInt((req.body || {}).cuotas, 10) || 1;
    if (!(monto > 0)) return res.status(400).json({ error: 'El monto debe ser mayor a 0' });
    const ins = await query(
      'INSERT INTO anticipos (empleado_id, monto, motivo, cuotas) VALUES ($1,$2,$3,$4) RETURNING *',
      [req.user.id, monto, motivo || null, cuotas]
    );
    res.status(201).json(ins.rows[0]);
  } catch (e) { next(e); }
});

// Próximo período YYYY-MM (mes siguiente a hoy) para la primera cuota.
function proxPeriodo() {
  const d = new Date(); d.setMonth(d.getMonth() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// PATCH /api/anticipos/:id — aprobar/rechazar; al aprobar RR.HH. define cuotas y período (manager/rrhh/admin)
router.patch('/:id', requireRole('manager', 'rrhh', 'admin'), async (req, res, next) => {
  try {
    const { estado, cuotas, cuotaDesde } = req.body || {};
    if (!['aprobado', 'rechazado'].includes(estado)) return res.status(400).json({ error: 'Estado inválido' });
    if (estado === 'rechazado') {
      const r = await query(`UPDATE anticipos SET estado='rechazado', resuelto_por=$1, resuelto_at=now() WHERE id=$2 AND estado='pendiente' RETURNING id`, [req.user.dni, req.params.id]);
      if (!r.rowCount) return res.status(409).json({ error: 'El adelanto no existe o ya fue resuelto' });
      return res.json({ ok: true, estado });
    }
    const nCuotas = Math.max(1, parseInt(cuotas, 10) || 1);
    const desde = (cuotaDesde && /^\d{4}-\d{2}$/.test(cuotaDesde)) ? cuotaDesde : proxPeriodo();
    const r = await query(
      `UPDATE anticipos SET estado='aprobado', cuotas=$1, cuota_desde=$2, resuelto_por=$3, resuelto_at=now()
         WHERE id=$4 AND estado='pendiente' RETURNING *`,
      [nCuotas, desde, req.user.dni, req.params.id]
    );
    if (!r.rowCount) return res.status(409).json({ error: 'El adelanto no existe o ya fue resuelto' });
    res.json({ ok: true, estado, cuotas: nCuotas, cuotaDesde: desde });
  } catch (e) { next(e); }
});

// GET /api/anticipos/:id/cuotas — detalle de cuotas aplicadas (propio o gestor)
router.get('/:id/cuotas', async (req, res, next) => {
  try {
    const a = (await query('SELECT empleado_id FROM anticipos WHERE id=$1', [req.params.id])).rows[0];
    if (!a) return res.status(404).json({ error: 'Adelanto no encontrado' });
    if (a.empleado_id !== req.user.id && !puedeAprobar(req.user.role)) return res.status(403).json({ error: 'Sin permiso' });
    const { rows } = await query('SELECT nro, anio, mes, monto, created_at FROM anticipo_cuotas WHERE anticipo_id=$1 ORDER BY anio, mes', [req.params.id]);
    res.json(rows);
  } catch (e) { next(e); }
});

export default router;
