import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { idsEquipoDe } from '../lib/equipo.js';
import { periodoCerrado } from './cierres.routes.js';

const router = Router();
router.use(requireAuth);
const esGlobal = (role) => ['rrhh', 'admin'].includes(role); // ven cualquier recibo
function logAudit(actor, accion, detalle, target) { query('INSERT INTO audit_log (actor_dni, accion, detalle, target) VALUES ($1,$2,$3,$4)', [actor, accion, detalle || null, target || null]).catch(() => {}); }
// Un gerente solo ve recibos de su equipo (organigrama). Devuelve true si target es de su equipo.
async function gerenteVe(req, targetId) {
  if (req.user.role !== 'manager') return false;
  const ids = await idsEquipoDe(req.user.id);
  return ids.has(Number(targetId));
}

// GET /api/recibos — propios; rrhh/admin/manager con ?empleadoId= ven los de ese empleado
router.get('/', async (req, res, next) => {
  try {
    let empleadoId = req.user.id;
    if (req.query.empleadoId) {
      const target = Number(req.query.empleadoId);
      if (target !== req.user.id) {
        // Solo RR.HH./admin (global) o un gerente sobre su propio equipo pueden ver ajenos.
        if (!esGlobal(req.user.role) && !(await gerenteVe(req, target))) {
          return res.status(403).json({ error: 'Sin permiso para ver recibos de ese empleado' });
        }
        empleadoId = target;
      }
    }
    const esPropio = empleadoId === req.user.id;
    // El empleado solo ve sus recibos publicados; gestores ven todos los del consultado.
    const filtro = (esPropio && req.user.role === 'employee') ? 'AND publicado = true' : '';
    const { rows } = await query(
      `SELECT id, anio, mes, tipo, neto, created_at, publicado FROM recibos WHERE empleado_id = $1 ${filtro} ORDER BY anio DESC, mes DESC`,
      [empleadoId]
    );
    res.json(rows);
  } catch (e) { next(e); }
});

// GET /api/recibos/gestion — todos los recibos (rrhh/admin/manager), con filtros
router.get('/gestion', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const { anio, mes, empresa, q } = req.query;
    const cond = [], params = [];
    if (anio) { params.push(Number(anio)); cond.push(`r.anio = $${params.length}`); }
    if (mes) { params.push(Number(mes)); cond.push(`r.mes = $${params.length}`); }
    if (empresa) { params.push(empresa); cond.push(`em.nombre = $${params.length}`); }
    if (q) { params.push(`%${String(q).toLowerCase()}%`); const i = params.length; cond.push(`(lower(e.nom) LIKE $${i} OR e.leg_num LIKE $${i})`); }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    const { rows } = await query(
      `SELECT r.id, r.anio, r.mes, r.tipo, r.neto, r.created_at, r.created_by,
              e.nom, e.leg_num, em.nombre AS empresa
         FROM recibos r JOIN empleados e ON e.id = r.empleado_id
         JOIN empresas em ON em.id = e.empresa_id
         ${where}
        ORDER BY r.anio DESC, r.mes DESC, e.nom`,
      params
    );
    res.json(rows);
  } catch (e) { next(e); }
});

// GET /api/recibos/:id — detalle (propio, o cualquiera si rrhh/admin/manager)
router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM recibos WHERE id = $1', [req.params.id]);
    const rec = rows[0];
    if (!rec) return res.status(404).json({ error: 'Recibo no encontrado' });
    const esPropio = rec.empleado_id === req.user.id;
    const gestor = esGlobal(req.user.role) || (!esPropio && await gerenteVe(req, rec.empleado_id));
    if (!esPropio && !gestor) return res.status(403).json({ error: 'Sin permiso' });
    if (esPropio && req.user.role === 'employee' && !rec.publicado) return res.status(404).json({ error: 'Recibo no disponible' });
    // Log de visualización cuando el empleado consulta su propio recibo.
    if (rec.empleado_id === req.user.id) {
      query('INSERT INTO recibo_vistas (recibo_id, empleado_id) VALUES ($1,$2)', [rec.id, req.user.id]).catch(() => {});
    }
    // Enriquecer con la firma del empleador (misma que el certificado) + firmante, para el PDF.
    let firmaEmpleador = null, firmante = null;
    try {
      const fr = await query(
        `SELECT em.firma, (SELECT data->'firmante' FROM parametros_liq WHERE id=1) AS firmante
           FROM empleados e JOIN empresas em ON em.id = e.empresa_id WHERE e.id = $1`,
        [rec.empleado_id]);
      firmaEmpleador = fr.rows[0]?.firma || null;
      firmante = fr.rows[0]?.firmante || null;
    } catch { /* si falla, el recibo sale sin firma */ }
    res.json({ ...rec.data, firmaEmpleador, firmante });
  } catch (e) { next(e); }
});

// GET /api/recibos/:id/vistas — log de visualizaciones (rrhh/admin/manager)
router.get('/:id/vistas', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT v.created_at, e.nom, e.leg_num FROM recibo_vistas v JOIN empleados e ON e.id=v.empleado_id WHERE v.recibo_id=$1 ORDER BY v.created_at DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (e) { next(e); }
});

// Recalcula totales de una corrida tras borrar recibos; si queda vacía, la elimina.
async function reconciliarCorrida(id) {
  if (!id) return;
  const r = await query('SELECT COALESCE(SUM(neto),0) AS total, COUNT(*)::int AS cant FROM recibos WHERE corrida_id=$1', [id]);
  if (Number(r.rows[0].cant) === 0) await query('DELETE FROM corridas WHERE id=$1', [id]);
  else await query('UPDATE corridas SET total_neto=$1, cant=$2 WHERE id=$3', [r.rows[0].total, r.rows[0].cant, id]);
}
// DELETE /api/recibos/:id — RR.HH./admin elimina un recibo (para re-liquidar el período)
router.delete('/:id', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const row = (await query(
      `SELECT r.corrida_id, r.anio, r.mes, r.tipo, r.neto, e.nom, e.leg_num, em.nombre AS empresa
         FROM recibos r JOIN empleados e ON e.id=r.empleado_id JOIN empresas em ON em.id=e.empresa_id
        WHERE r.id=$1`, [req.params.id])).rows[0];
    if (!row) return res.status(404).json({ error: 'Recibo no encontrado' });
    if (await periodoCerrado(row.empresa, row.anio, row.mes)) return res.status(409).json({ error: `El período ${String(row.mes).padStart(2, '0')}/${row.anio} de ${row.empresa} está cerrado. Reabrilo para borrar.` });
    await query('DELETE FROM anticipo_cuotas WHERE recibo_id=$1', [req.params.id]);
    await query('DELETE FROM recibos WHERE id=$1', [req.params.id]);
    await reconciliarCorrida(row.corrida_id);
    logAudit(req.user.dni, 'recibo_eliminado', `${row.nom} (${row.leg_num}) · ${row.empresa} · ${String(row.mes).padStart(2, '0')}/${row.anio} · ${row.tipo} · neto ${row.neto}`, String(req.params.id));
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// POST /api/recibos/eliminar-lote { anio, mes, empresa? } — elimina todos los recibos del período (re-liquidar)
router.post('/eliminar-lote', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const { anio, mes, empresa, tipo } = req.body || {};
    if (!anio || !mes) return res.status(400).json({ error: 'anio y mes son obligatorios para el borrado en lote' });
    const cond = ['r.anio=$1', 'r.mes=$2'], params = [Number(anio), Number(mes)];
    if (empresa) { params.push(empresa); cond.push(`em.nombre=$${params.length}`); }
    if (tipo) { params.push(tipo); cond.push(`r.tipo=$${params.length}`); }
    const recs = (await query(`SELECT r.id, r.corrida_id, em.nombre AS empresa FROM recibos r JOIN empleados e ON e.id=r.empleado_id JOIN empresas em ON em.id=e.empresa_id WHERE ${cond.join(' AND ')}`, params)).rows;
    const ids = recs.map((x) => x.id);
    const corridaIds = [...new Set(recs.map((x) => x.corrida_id).filter(Boolean))];
    const empresasAfectadas = [...new Set(recs.map((x) => x.empresa))];
    for (const emp of empresasAfectadas) {
      if (await periodoCerrado(emp, anio, mes)) return res.status(409).json({ error: `El período ${String(mes).padStart(2, '0')}/${anio} de ${emp} está cerrado. Reabrilo para borrar.` });
    }
    if (ids.length) {
      await query('DELETE FROM anticipo_cuotas WHERE recibo_id = ANY($1)', [ids]);
      await query('DELETE FROM recibos WHERE id = ANY($1)', [ids]);
      for (const cid of corridaIds) await reconciliarCorrida(cid);
      logAudit(req.user.dni, 'recibos_eliminados_lote', `${ids.length} recibos · ${empresa || 'todas las empresas'} · ${String(mes).padStart(2, '0')}/${anio}${tipo ? ' · ' + tipo : ''}`, null);
    }
    res.json({ ok: true, eliminados: ids.length });
  } catch (e) { next(e); }
});

export default router;
