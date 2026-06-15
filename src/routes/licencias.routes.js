import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { idsEquipoDe } from '../lib/equipo.js';

const router = Router();
router.use(requireAuth);
const gestiona = (role) => ['manager', 'rrhh', 'admin'].includes(role);
const esVacaciones = (t) => String(t || '').trim().toLowerCase() === 'vacaciones';

function diasEntre(desde, hasta) {
  const d1 = new Date(desde + 'T12:00:00'), d2 = new Date(hasta + 'T12:00:00');
  return Math.round((d2 - d1) / 86400000) + 1;
}
function diasPorAntiguedad(anios) { if (anios < 5) return 14; if (anios < 10) return 21; if (anios < 20) return 28; return 35; }

// Info de vacaciones del empleado: corresponden por antigüedad + saldo + disponible.
async function getVacInfo(empleadoId) {
  const er = await query('SELECT ingreso FROM empleados WHERE id=$1', [empleadoId]);
  const ingreso = er.rows[0]?.ingreso;
  const anio = new Date().getFullYear();
  const ingAnio = ingreso ? new Date(ingreso).getFullYear() : anio;
  const antiguedad = Math.max(0, anio - ingAnio);
  const corresponden = diasPorAntiguedad(antiguedad);
  // El saldo se consume con las vacaciones GOZADAS (aprobadas), no con las pendientes.
  const tr = await query(
    `SELECT EXTRACT(YEAR FROM desde)::int AS y, COALESCE(SUM(dias),0)::int AS dias
       FROM licencias WHERE empleado_id=$1 AND lower(tipo)='vacaciones' AND estado='aprobada'
       GROUP BY 1`, [empleadoId]);
  const porAnio = Object.fromEntries(tr.rows.map((r) => [r.y, r.dias]));
  const tomadosEsteAnio = porAnio[anio] || 0;
  const saldoEsteAnio = corresponden - tomadosEsteAnio;
  let saldoAnteriores = 0;
  for (let y = anio - 2; y < anio; y++) {
    if (ingAnio > y) continue;
    saldoAnteriores += Math.max(0, diasPorAntiguedad(Math.max(0, y - ingAnio)) - (porAnio[y] || 0));
  }
  const disponible = saldoEsteAnio + saldoAnteriores;
  return { antiguedad, corresponden, tomadosEsteAnio, saldoEsteAnio, saldoAnteriores, disponible, anio };
}

router.get('/vacaciones-info', async (req, res, next) => {
  try { res.json(await getVacInfo(req.user.id)); } catch (e) { next(e); }
});

router.get('/mias', async (req, res, next) => {
  try { const { rows } = await query('SELECT id, empleado_id, tipo, desde, hasta, dias, motivo, estado, resuelto_por, resuelto_at, created_at, justificacion, comprobante_nombre, comprobante_mime, (comprobante_data IS NOT NULL) AS tiene_comprobante FROM licencias WHERE empleado_id = $1 ORDER BY created_at DESC', [req.user.id]); res.json(rows); }
  catch (e) { next(e); }
});

router.get('/', async (req, res, next) => {
  try {
    if (gestiona(req.user.role)) {
      const { estado, empresa, q } = req.query; const cond = [], params = [];
      if (req.user.role === 'manager') { const _ids = [...await idsEquipoDe(req.user.id)]; if (!_ids.length) return res.json([]); params.push(_ids); cond.push(`e.id = ANY($${params.length})`); }
      if (estado) { params.push(estado); cond.push(`l.estado = $${params.length}`); }
      if (empresa) { params.push(empresa); cond.push(`em.nombre = $${params.length}`); }
      if (q) { params.push(`%${String(q).toLowerCase()}%`); const i = params.length; cond.push(`(lower(e.nom) LIKE $${i} OR e.leg_num LIKE $${i})`); }
      const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
      const { rows } = await query(
        `SELECT l.id, l.empleado_id, l.tipo, l.desde, l.hasta, l.dias, l.motivo, l.estado, l.resuelto_por, l.resuelto_at, l.created_at, l.justificacion, l.comprobante_nombre, l.comprobante_mime, (l.comprobante_data IS NOT NULL) AS tiene_comprobante, e.nom, e.leg_num, em.nombre AS empresa FROM licencias l JOIN empleados e ON e.id=l.empleado_id JOIN empresas em ON em.id=e.empresa_id ${where} ORDER BY (l.estado='pendiente') DESC, l.created_at DESC`, params);
      return res.json(rows);
    }
    const { rows } = await query('SELECT id, empleado_id, tipo, desde, hasta, dias, motivo, estado, resuelto_por, resuelto_at, created_at, justificacion, comprobante_nombre, comprobante_mime, (comprobante_data IS NOT NULL) AS tiene_comprobante FROM licencias WHERE empleado_id=$1 ORDER BY created_at DESC', [req.user.id]);
    res.json(rows);
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const { tipo, desde, hasta, motivo } = req.body || {};
    if (!tipo || !desde || !hasta) return res.status(400).json({ error: 'Tipo, desde y hasta son obligatorios' });
    if (hasta < desde) return res.status(400).json({ error: 'La fecha hasta debe ser posterior a desde' });
    // Imprevisibles: no se solicitan con anticipación (RR.HH. las registra).
    if (['enfermedad', 'fallecimiento familiar', 'nacimiento'].includes(String(tipo).toLowerCase())) {
      return res.status(400).json({ error: `${tipo} es una licencia imprevisible y no puede solicitarse con anticipación; debe registrarla RR.HH.` });
    }
    const dias = diasEntre(desde, hasta);
    if (esVacaciones(tipo)) {
      const info = await getVacInfo(req.user.id);
      if (dias > info.disponible) {
        return res.status(400).json({ error: `Excede tu saldo de vacaciones: pedís ${dias} día(s) y tenés ${info.disponible} disponible(s) (saldo del año ${info.saldoEsteAnio} + saldo anterior ${info.saldoAnteriores}).` });
      }
    }
    const ins = await query(
      `INSERT INTO licencias (empleado_id, tipo, desde, hasta, dias, motivo) VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, empleado_id, tipo, desde, hasta, dias, motivo, estado, created_at, justificacion, comprobante_nombre, comprobante_mime, (comprobante_data IS NOT NULL) AS tiene_comprobante`,
      [req.user.id, tipo, desde, hasta, dias, motivo || null]);
    res.status(201).json(ins.rows[0]);
  } catch (e) { next(e); }
});

// POST /api/licencias/registrar — RR.HH. carga una licencia para un empleado (aprobada)
router.post('/registrar', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const { empleadoId, tipo, desde, hasta, motivo } = req.body || {};
    if (!empleadoId || !tipo || !desde || !hasta) return res.status(400).json({ error: 'empleadoId, tipo, desde y hasta son obligatorios' });
    if (hasta < desde) return res.status(400).json({ error: 'La fecha hasta debe ser posterior a desde' });
    const dias = diasEntre(desde, hasta);
    const ins = await query(
      `INSERT INTO licencias (empleado_id, tipo, desde, hasta, dias, motivo, estado, resuelto_por, resuelto_at)
       VALUES ($1,$2,$3,$4,$5,$6,'aprobada',$7,now()) RETURNING id`,
      [empleadoId, tipo, desde, hasta, dias, motivo || null, req.user.dni]);
    res.status(201).json({ ok: true, id: ins.rows[0].id });
  } catch (e) { next(e); }
});

router.patch('/:id', requireRole('manager', 'rrhh', 'admin'), async (req, res, next) => {
  try {
    const estado = (req.body || {}).estado;
    if (!['aprobada', 'rechazada'].includes(estado)) return res.status(400).json({ error: 'Estado inválido' });
    // P1 — Un gerente solo resuelve licencias de SU equipo (organigrama). RR.HH./admin, cualquiera.
    if (req.user.role === 'manager') {
      const cur = (await query('SELECT empleado_id FROM licencias WHERE id=$1', [req.params.id])).rows[0];
      if (!cur) return res.status(404).json({ error: 'La licencia no existe' });
      const ids = await idsEquipoDe(req.user.id);
      if (!ids.has(cur.empleado_id)) return res.status(403).json({ error: 'Esa licencia no corresponde a tu equipo.' });
    }
    const r = await query(`UPDATE licencias SET estado=$1, resuelto_por=$2, resuelto_at=now() WHERE id=$3 AND estado='pendiente' RETURNING id`, [estado, req.user.dni, req.params.id]);
    if (!r.rowCount) return res.status(409).json({ error: 'La licencia no existe o ya fue resuelta' });
    res.json({ ok: true, estado });
  } catch (e) { next(e); }
});

// POST /api/licencias/:id/comprobante — el empleado justifica una licencia YA solicitada adjuntando el comprobante (paso posterior)
router.post('/:id/comprobante', async (req, res, next) => {
  try {
    const { comprobanteNombre, comprobanteMime, comprobanteData } = req.body || {};
    if (!comprobanteData) return res.status(400).json({ error: 'Debés adjuntar el comprobante.' });
    const r = await query(
      `UPDATE licencias SET comprobante_nombre=$1, comprobante_mime=$2, comprobante_data=$3, justificacion=true
         WHERE id=$4 AND empleado_id=$5
       RETURNING id, empleado_id, tipo, desde, hasta, dias, motivo, estado, created_at, justificacion, comprobante_nombre, comprobante_mime, true AS tiene_comprobante`,
      [comprobanteNombre || 'comprobante', comprobanteMime || 'application/octet-stream', comprobanteData, req.params.id, req.user.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Licencia no encontrada' });
    res.json(r.rows[0]);
  } catch (e) { next(e); }
});

// GET /api/licencias/:id/comprobante — descarga del comprobante (dueño o gestor)
router.get('/:id/comprobante', async (req, res, next) => {
  try {
    const { rows } = await query(
      'SELECT empleado_id, comprobante_nombre, comprobante_mime, comprobante_data FROM licencias WHERE id=$1', [req.params.id]);
    const lic = rows[0];
    if (!lic || !lic.comprobante_data) return res.status(404).json({ error: 'No hay comprobante para esta licencia' });
    const esGestor = gestiona(req.user.role);
    if (!esGestor && lic.empleado_id !== req.user.id) return res.status(403).json({ error: 'No autorizado' });
    const buf = Buffer.from(lic.comprobante_data, 'base64');
    res.setHeader('Content-Type', lic.comprobante_mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${(lic.comprobante_nombre || 'comprobante').replace(/[^\w.\- ]/g, '_')}"`);
    res.send(buf);
  } catch (e) { next(e); }
});

export default router;
