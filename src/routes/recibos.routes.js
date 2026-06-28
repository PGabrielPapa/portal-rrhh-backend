import { Router } from 'express';
import { query } from '../db.js';
import { enviarMail, mailConfigurado } from '../lib/mailer.js';
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
      `SELECT id, anio, mes, tipo, neto, created_at, publicado, acuse_at FROM recibos WHERE empleado_id = $1 ${filtro} ORDER BY anio DESC, mes DESC`,
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
      `SELECT r.id, r.anio, r.mes, r.tipo, r.neto, r.created_at, r.created_by, r.publicado, r.pagado, r.acuse_at,
              EXISTS (SELECT 1 FROM recibo_vistas v WHERE v.recibo_id = r.id) AS visto,
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
// PATCH /api/recibos/:id/pagar { pagado } — marca/desmarca como pagado
router.patch('/:id/pagar', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const pagado = !!(req.body && req.body.pagado);
    const r = await query('UPDATE recibos SET pagado=$1, pagado_at=$2, pagado_por=$3 WHERE id=$4 RETURNING id',
      [pagado, pagado ? new Date() : null, pagado ? req.user.dni : null, req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Recibo no encontrado' });
    res.json({ ok: true, pagado });
  } catch (e) { next(e); }
});

// POST /api/recibos/:id/avisar — notifica al empleado que su recibo está disponible
router.post('/:id/avisar', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const row = (await query('SELECT empleado_id, anio, mes, tipo, publicado FROM recibos WHERE id=$1', [req.params.id])).rows[0];
    if (!row) return res.status(404).json({ error: 'Recibo no encontrado' });
    if (!row.publicado) return res.status(409).json({ error: 'El recibo no está publicado todavía' });
    const MESES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
    const cuerpo = `Tu recibo de ${MESES[row.mes - 1]} ${row.anio} (${row.tipo}) está disponible en "Mis recibos".`;
    await query(`INSERT INTO mensajes (empleado_id, titulo, cuerpo, autor, direccion, estado) VALUES ($1,$2,$3,$4,'a_empleado','nuevo')`,
      [row.empleado_id, 'Recibo disponible', cuerpo, req.user.dni]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});
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

// Acuse de recibo del empleado (Ley 27.555): el propio empleado confirma la recepción.
router.post('/:id/acuse', async (req, res, next) => {
  try {
    const r = (await query('SELECT empleado_id, acuse_at FROM recibos WHERE id=$1', [req.params.id])).rows[0];
    if (!r) return res.status(404).json({ error: 'Recibo no encontrado' });
    if (r.empleado_id !== req.user.id) return res.status(403).json({ error: 'Solo el titular puede dar el acuse' });
    if (r.acuse_at) return res.json({ ok: true, ya: true, acuseAt: r.acuse_at });
    const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').toString().split(',')[0].trim();
    const nombre = (await query('SELECT nom FROM empleados WHERE id=$1', [req.user.id])).rows[0]?.nom || '';
    const up = await query('UPDATE recibos SET acuse_at=now(), acuse_ip=$2, acuse_nombre=$3 WHERE id=$1 RETURNING acuse_at', [req.params.id, ip, nombre]);
    res.json({ ok: true, acuseAt: up.rows[0].acuse_at });
  } catch (e) { next(e); }
});

// Arma el HTML del recibo y resuelve el destino (mail laboral -> personal -> general).
function _htmlRecibo(r) {
  const $ = (n) => '$ ' + Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2 });
  const MESES = ['', 'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  const fila = (c, m) => `<tr><td style="padding:2px 8px">${c}</td><td style="padding:2px 8px;text-align:right;font-family:monospace">${$(m)}</td></tr>`;
  const hab = (r.data?.haberes || []).map((h) => fila(h.concepto, h.monto)).join('');
  const des = (r.data?.descuentos || []).map((d) => fila(d.concepto, -Number(d.monto || 0))).join('');
  return `<div style="font-family:sans-serif;max-width:640px">
      <h2>Recibo de haberes — ${MESES[r.mes]} ${r.anio}</h2>
      <p>${r.nom} · ${r.empresa} · ${r.tipo}</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <tr><th colspan="2" style="text-align:left;background:#f1f5f9;padding:4px 8px">Haberes</th></tr>${hab}
        <tr><th colspan="2" style="text-align:left;background:#f1f5f9;padding:4px 8px">Descuentos</th></tr>${des}
        <tr><td style="padding:6px 8px;font-weight:700;border-top:2px solid #ccc">Neto</td><td style="padding:6px 8px;text-align:right;font-weight:700;border-top:2px solid #ccc;font-family:monospace">${$(r.neto)}</td></tr>
      </table>
      <p style="color:#666;font-size:12px">Comprobante informativo. Podés ver y dar el acuse en el portal de RR.HH.</p>
    </div>`;
}
function _destinoMail(r) { const ed = r.edata || {}; return (ed.email_laboral || ed.email_personal || r.email || '').trim(); }

// Envío MASIVO: manda los recibos publicados de un período, cada uno a su mail (laboral->personal->general).
router.post('/enviar-mail-lote', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const { anio, mes, empresa, tipo } = req.body || {};
    if (!anio || !mes) return res.status(400).json({ error: 'anio y mes son obligatorios' });
    const cond = ['r.anio=$1', 'r.mes=$2', 'r.publicado=true']; const args = [Number(anio), Number(mes)];
    if (empresa) { args.push(empresa); cond.push(`em.nombre=$${args.length}`); }
    if (tipo) { args.push(tipo); cond.push(`r.tipo=$${args.length}`); }
    const recs = (await query(
      `SELECT r.id, r.anio, r.mes, r.tipo, r.neto, r.data, e.nom, e.email, e.data AS edata, em.nombre AS empresa
         FROM recibos r JOIN empleados e ON e.id=r.empleado_id JOIN empresas em ON em.id=e.empresa_id
        WHERE ${cond.join(' AND ')} ORDER BY em.nombre, e.nom`, args)).rows;
    if (!recs.length) return res.status(400).json({ error: 'No hay recibos publicados para ese período/filtro' });
    if (!mailConfigurado()) return res.status(400).json({ error: 'SMTP no configurado en el servidor' });
    let enviados = 0; const sinMail = []; const errores = [];
    for (const r of recs) {
      const to = _destinoMail(r);
      if (!to) { sinMail.push(`${r.nom}`); continue; }
      try {
        await enviarMail({ to, subject: `Recibo de haberes ${String(r.mes).padStart(2, '0')}/${r.anio} — ${r.empresa}`, html: _htmlRecibo(r) });
        enviados++;
      } catch (e) { errores.push(`${r.nom}: ${e.message}`); }
    }
    res.json({ ok: true, total: recs.length, enviados, sinMail, errores });
  } catch (e) { next(e); }
});

// Enviar el recibo por correo al empleado (RR.HH./admin).
router.post('/:id/enviar-mail', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const r = (await query(
      `SELECT r.anio, r.mes, r.tipo, r.neto, r.data, e.nom, e.email, e.data AS edata, em.nombre AS empresa
         FROM recibos r JOIN empleados e ON e.id=r.empleado_id JOIN empresas em ON em.id=e.empresa_id WHERE r.id=$1`, [req.params.id])).rows[0];
    if (!r) return res.status(404).json({ error: 'Recibo no encontrado' });
    const to = (req.body?.to || _destinoMail(r)).trim();
    if (!to) return res.status(400).json({ error: 'El empleado no tiene mail laboral, personal ni general cargado' });
    await enviarMail({ to, subject: `Recibo de haberes ${String(r.mes).padStart(2, '0')}/${r.anio} — ${r.empresa}`, html: _htmlRecibo(r) });
    res.json({ ok: true, to });
  } catch (e) { next(e); }
});

export default router;
