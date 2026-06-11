import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

const puedeAprobar = (role) => ['manager', 'rrhh', 'admin'].includes(role);

// GET /api/anticipos — propios; rrhh/manager/admin ven todos
router.get('/', async (req, res, next) => {
  try {
    if (puedeAprobar(req.user.role)) {
      const { rows } = await query(
        `SELECT a.*, e.nom, e.leg_num, em.nombre AS empresa
           FROM anticipos a JOIN empleados e ON e.id = a.empleado_id
           JOIN empresas em ON em.id = e.empresa_id
          ORDER BY (a.estado='pendiente') DESC, a.created_at DESC`
      );
      return res.json(rows);
    }
    const { rows } = await query('SELECT * FROM anticipos WHERE empleado_id = $1 ORDER BY created_at DESC', [req.user.id]);
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

// PATCH /api/anticipos/:id — aprobar/rechazar (manager/rrhh/admin)
router.patch('/:id', requireRole('manager', 'rrhh', 'admin'), async (req, res, next) => {
  try {
    const estado = (req.body || {}).estado;
    if (!['aprobado', 'rechazado'].includes(estado)) return res.status(400).json({ error: 'Estado inválido' });
    const r = await query(
      `UPDATE anticipos SET estado=$1, resuelto_por=$2, resuelto_at=now() WHERE id=$3 AND estado='pendiente' RETURNING id`,
      [estado, req.user.dni, req.params.id]
    );
    if (!r.rowCount) return res.status(409).json({ error: 'El adelanto no existe o ya fue resuelto' });
    res.json({ ok: true, estado });
  } catch (e) { next(e); }
});

export default router;
