import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
const router = Router();
router.use(requireAuth);
const gestiona = (r) => ['rrhh', 'admin'].includes(r);
const armarDom = (b) => {
  const partes = [b.calle, b.nro].filter(Boolean);
  if (b.piso) partes.push(`Piso ${b.piso}`); if (b.depto) partes.push(`Dto ${b.depto}`);
  const ciudad = `${b.loc || ''}${b.prov ? ', ' + b.prov : ''}${b.cp ? ' (' + b.cp + ')' : ''}`;
  return `${partes.join(' ')}${ciudad ? ' — ' + ciudad : ''}`;
};

router.get('/mias', async (req, res, next) => {
  try { const { rows } = await query('SELECT * FROM cambios_domicilio WHERE empleado_id=$1 ORDER BY created_at DESC', [req.user.id]); res.json(rows); }
  catch (e) { next(e); }
});

router.get('/', async (req, res, next) => {
  try {
    if (!gestiona(req.user.role)) { const { rows } = await query('SELECT * FROM cambios_domicilio WHERE empleado_id=$1 ORDER BY created_at DESC', [req.user.id]); return res.json(rows); }
    const { estado, q } = req.query; const cond = [], params = [];
    if (estado) { params.push(estado); cond.push(`c.estado=$${params.length}`); }
    if (q) { params.push(`%${String(q).toLowerCase()}%`); const i = params.length; cond.push(`(lower(e.nom) LIKE $${i} OR e.leg_num LIKE $${i})`); }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    const { rows } = await query(`SELECT c.*, e.nom, e.leg_num, em.nombre AS empresa FROM cambios_domicilio c JOIN empleados e ON e.id=c.empleado_id JOIN empresas em ON em.id=e.empresa_id ${where} ORDER BY (c.estado='pendiente') DESC, c.created_at DESC`, params);
    res.json(rows);
  } catch (e) { next(e); }
});

// Informar cambio (empleado)
router.post('/', async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.calle || !b.nro || !b.loc) return res.status(400).json({ error: 'Calle, número y localidad son obligatorios' });
    const er = await query('SELECT data FROM empleados WHERE id=$1', [req.user.id]);
    const d = er.rows[0]?.data || {};
    const domAnterior = armarDom({ calle: d.dom_calle, nro: d.dom_nro, piso: d.dom_piso, depto: d.dom_depto, loc: d.dom_loc, prov: d.dom_prov, cp: d.dom_cp });
    const r = await query(
      `INSERT INTO cambios_domicilio (empleado_id, calle, nro, piso, depto, loc, prov, cp, dom_anterior, dom_nuevo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [req.user.id, b.calle, b.nro, b.piso || null, b.depto || null, b.loc, b.prov || null, b.cp || null, domAnterior, armarDom(b)]);
    res.status(201).json(r.rows[0]);
  } catch (e) { next(e); }
});

// Aprobar / rechazar (rrhh/admin). Al aprobar, actualiza el domicilio del empleado.
router.patch('/:id', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const estado = (req.body || {}).estado;
    if (!['aprobado', 'rechazado'].includes(estado)) return res.status(400).json({ error: 'Estado inválido' });
    const cr = await query(`UPDATE cambios_domicilio SET estado=$1, resuelto_por=$2, resuelto_at=now() WHERE id=$3 AND estado='pendiente' RETURNING *`, [estado, req.user.dni, req.params.id]);
    const c = cr.rows[0];
    if (!c) return res.status(409).json({ error: 'No existe o ya fue resuelto' });
    if (estado === 'aprobado') {
      await query(
        `UPDATE empleados SET data = data || $1::jsonb WHERE id = $2`,
        [JSON.stringify({ dom_calle: c.calle, dom_nro: c.nro, dom_piso: c.piso, dom_depto: c.depto, dom_loc: c.loc, dom_prov: c.prov, dom_cp: c.cp }), c.empleado_id]);
    }
    res.json({ ok: true, estado });
  } catch (e) { next(e); }
});

export default router;
