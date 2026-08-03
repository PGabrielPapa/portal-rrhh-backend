import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { idsEquipoDe } from '../lib/equipo.js';
import { reglaDe, topeExamen, REGLAS } from '../lib/licenciasReglas.js';
import { validarAdjunto, mimeSeguro } from '../lib/adjuntos.js';
import { equipoEfectivo, tieneDelegacion, notaDelegacion } from '../lib/delegaciones.js';
import { ordenarPasos, pasoActual, puedeResolver, resultadoDecision } from '../lib/workflowEngine.js';
import { avisarAprobadorPendiente, avisarSolicitante } from '../lib/notifAprob.js';

const router = Router();
router.use(requireAuth);
const gestiona = (role) => ['manager', 'rrhh', 'admin'].includes(role);
const esVacaciones = (t) => String(t || '').trim().toLowerCase() === 'vacaciones';

function diasEntre(desde, hasta) {
  const d1 = new Date(desde + 'T12:00:00'), d2 = new Date(hasta + 'T12:00:00');
  return Math.round((d2 - d1) / 86400000) + 1;
}
function diasPorAntiguedad(anios) { if (anios < 5) return 14; if (anios < 10) return 21; if (anios < 20) return 28; return 35; }

// Snapshot del flujo de aprobación configurado para 'licencias' (si existe). Devuelve
// el JSON de pasos como string, o null si no hay workflow (→ flujo clásico PATCH).
async function wfSnapLicencias() {
  try {
    const wf = (await query("SELECT pasos FROM workflows WHERE activo AND proceso='licencias' ORDER BY updated_at DESC LIMIT 1")).rows[0];
    if (wf && Array.isArray(wf.pasos) && wf.pasos.length) return JSON.stringify(wf.pasos);
  } catch (e) { /* sin workflow: flujo clásico */ }
  return null;
}

// Puesto (puesto_id) del usuario, para pasos de workflow por puesto.
async function puestoDe(userId) {
  const r = (await query('SELECT puesto_id FROM empleados WHERE id=$1', [userId])).rows[0];
  return r ? r.puesto_id : null;
}

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

// GET /licencias/mis-saldos — saldos de licencias especiales del empleado (tope, tomados y disponible).
router.get('/mis-saldos', async (req, res, next) => {
  try {
    const yr = new Date().getFullYear();
    const nt = (await query("SELECT data->>'nivelTitulo' AS nt FROM empleados WHERE id=$1", [req.user.id])).rows[0]?.nt || '';
    const prev = (await query("SELECT tipo, dias, estado FROM licencias WHERE empleado_id=$1 AND EXTRACT(YEAR FROM desde)=$2", [req.user.id, yr])).rows;
    const especiales = REGLAS.map((r) => {
      const tope = r.key === 'examen' ? topeExamen(nt) : r.tope;
      const row = { key: r.key, nombre: r.nombre, base: r.base, anual: r.anual, sinGoce: r.sinGoce, tope };
      if (r.anual) {
        let tomados = 0, pend = 0;
        for (const l of prev) { const rg = reglaDe(l.tipo); if (rg && rg.key === r.key) { if (l.estado === 'aprobada') tomados += Number(l.dias) || 0; else if (l.estado === 'pendiente') pend += Number(l.dias) || 0; } }
        row.tomados = tomados; row.pendientes = pend; row.disponible = Math.max(0, tope - tomados - pend);
      }
      return row;
    });
    res.json({ anio: yr, nivelTitulo: nt, especiales });
  } catch (e) { next(e); }
});

// GET /licencias/equipo-saldos — resumen de licencias del equipo del gerente,
// con saldo de vacaciones de cada integrante (para el Tablero del equipo).
router.get('/equipo-saldos', async (req, res, next) => {
  try {
    const ids = [...await idsEquipoDe(req.user.id)];
    if (!ids.length) return res.json([]);
    const { rows } = await query(
      `SELECT e.id, e.nom, e.leg_num, em.nombre AS empresa,
              (SELECT count(*)::int FROM licencias l WHERE l.empleado_id=e.id AND l.estado='pendiente') AS pendientes,
              (SELECT count(*)::int FROM licencias l WHERE l.empleado_id=e.id AND l.estado='aprobada' AND EXTRACT(YEAR FROM l.desde)=EXTRACT(YEAR FROM CURRENT_DATE)) AS aprobadas_anio,
              (SELECT COALESCE(SUM(l.dias),0)::int FROM licencias l WHERE l.empleado_id=e.id AND (lower(l.tipo) LIKE '%examen%' OR lower(l.tipo) LIKE '%estudio%') AND l.estado='aprobada' AND EXTRACT(YEAR FROM l.desde)=EXTRACT(YEAR FROM CURRENT_DATE)) AS examen_anio
         FROM empleados e JOIN empresas em ON em.id=e.empresa_id
        WHERE e.id = ANY($1) AND e.activo=true ORDER BY e.nom`, [ids]);
    const niveles = {};
    for (const r0 of (await query("SELECT id, data->>'nivelTitulo' AS nt FROM empleados WHERE id = ANY($1)", [ids])).rows) niveles[r0.id] = r0.nt;
    const out = [];
    for (const r of rows) {
      const v = await getVacInfo(r.id);
      out.push({ id: r.id, nom: r.nom, legNum: r.leg_num, empresa: r.empresa,
        pendientes: r.pendientes, aprobadasAnio: r.aprobadas_anio, examenAnio: r.examen_anio, examenTope: topeExamen(niveles[r.id]),
        antiguedad: v.antiguedad, corresponden: v.corresponden, tomados: v.tomadosEsteAnio,
        saldoEsteAnio: v.saldoEsteAnio, saldoAnteriores: v.saldoAnteriores, disponible: v.disponible });
    }
    res.json(out);
  } catch (e) { next(e); }
});

router.get('/mias', async (req, res, next) => {
  try { const { rows } = await query('SELECT id, empleado_id, tipo, desde, hasta, dias, motivo, estado, resuelto_por, resuelto_at, created_at, justificacion, comprobante_nombre, comprobante_mime, (comprobante_data IS NOT NULL) AS tiene_comprobante FROM licencias WHERE empleado_id = $1 AND desde >= CURRENT_DATE - INTERVAL \'2 years\' ORDER BY created_at DESC', [req.user.id]); res.json(rows); }
  catch (e) { next(e); }
});

router.get('/', async (req, res, next) => {
  try {
    if (gestiona(req.user.role) || await tieneDelegacion(req.user, 'licencias')) {
      const { estado, empresa, q } = req.query; const cond = [], params = [];
      // Gerente o delegado → acotado a su equipo (propio + delegado). RR.HH./admin ven todo.
      if (req.user.role !== 'rrhh' && req.user.role !== 'admin') { const _ids = [...await equipoEfectivo(req.user, 'licencias')]; if (!_ids.length) return res.json([]); params.push(_ids); cond.push(`e.id = ANY($${params.length})`); }
      if (estado) { params.push(estado); cond.push(`l.estado = $${params.length}`); }
      if (empresa) { params.push(empresa); cond.push(`em.nombre = $${params.length}`); }
      if (q) { params.push(`%${String(q).toLowerCase()}%`); const i = params.length; cond.push(`(lower(e.nom) LIKE $${i} OR e.leg_num LIKE $${i})`); }
      cond.push("l.desde >= CURRENT_DATE - INTERVAL '2 years'");
      const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
      const { rows } = await query(
        `SELECT l.id, l.empleado_id, l.tipo, l.desde, l.hasta, l.dias, l.motivo, l.estado, l.resuelto_por, l.resuelto_at, l.created_at, l.justificacion, l.comprobante_nombre, l.comprobante_mime, (l.comprobante_data IS NOT NULL) AS tiene_comprobante, e.nom, e.leg_num, em.nombre AS empresa FROM licencias l JOIN empleados e ON e.id=l.empleado_id JOIN empresas em ON em.id=e.empresa_id ${where} ORDER BY (l.estado='pendiente') DESC, l.created_at DESC`, params);
      return res.json(rows);
    }
    const { rows } = await query('SELECT id, empleado_id, tipo, desde, hasta, dias, motivo, estado, resuelto_por, resuelto_at, created_at, justificacion, comprobante_nombre, comprobante_mime, (comprobante_data IS NOT NULL) AS tiene_comprobante FROM licencias WHERE empleado_id=$1 AND desde >= CURRENT_DATE - INTERVAL \'2 years\' ORDER BY created_at DESC', [req.user.id]);
    res.json(rows);
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const { tipo, desde, hasta, motivo } = req.body || {};
    if (!tipo || !desde || !hasta) return res.status(400).json({ error: 'Tipo, desde y hasta son obligatorios' });
    if (hasta < desde) return res.status(400).json({ error: 'La fecha hasta debe ser posterior a desde' });
    // Imprevisibles: enfermedad PROPIA y fallecimientos los registra RR.HH.
    // (nacimiento y enfermedad de familiar a cargo sí puede solicitarlas el empleado).
    const tl = String(tipo).toLowerCase();
    const esFamiliar = tl.includes('familiar');
    if ((tl.startsWith('enfermedad') && !esFamiliar) || tl.startsWith('fallecimiento')) {
      return res.status(400).json({ error: `${tipo} es una licencia imprevisible y no puede solicitarse con anticipación; debe registrarla RR.HH. (o justificarla con comprobante).` });
    }
    const dias = diasEntre(desde, hasta);
    if (esVacaciones(tipo)) {
      const info = await getVacInfo(req.user.id);
      if (dias > info.disponible) {
        return res.status(400).json({ error: `Excede tu saldo de vacaciones: pedís ${dias} día(s) y tenés ${info.disponible} disponible(s) (saldo del año ${info.saldoEsteAnio} + saldo anterior ${info.saldoAnteriores}).` });
      }
    }
    // Topes de licencias especiales (planilla del grupo + LCT/CCT).
    const regla = reglaDe(tipo);
    if (regla) {
      if (regla.anual) {
        const yr = new Date(desde + 'T12:00:00').getFullYear();
        let tope = regla.tope;
        if (regla.key === 'examen') { const nt = (await query("SELECT data->>'nivelTitulo' AS nt FROM empleados WHERE id=$1", [req.user.id])).rows[0]?.nt; tope = topeExamen(nt); }
        const prev = (await query("SELECT tipo, dias FROM licencias WHERE empleado_id=$1 AND estado IN ('aprobada','pendiente') AND EXTRACT(YEAR FROM desde)=$2", [req.user.id, yr])).rows;
        let tomados = 0; for (const r of prev) { const rg = reglaDe(r.tipo); if (rg && rg.key === regla.key) tomados += Number(r.dias) || 0; }
        if (tomados + dias > tope) return res.status(400).json({ error: `Supera el máximo de ${tope} día(s)/año de ${regla.nombre} (${regla.base}). Ya lleva ${tomados} este año y pedís ${dias}.` });
      } else if (dias > regla.tope) {
        return res.status(400).json({ error: `El máximo para ${regla.nombre} es ${regla.tope} día(s) (${regla.base}); estás pidiendo ${dias}.` });
      }
    }
    const wfSnap = await wfSnapLicencias();
    const ins = await query(
      `INSERT INTO licencias (empleado_id, tipo, desde, hasta, dias, motivo, workflow) VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, empleado_id, tipo, desde, hasta, dias, motivo, estado, created_at, justificacion, comprobante_nombre, comprobante_mime, (comprobante_data IS NOT NULL) AS tiene_comprobante`,
      [req.user.id, tipo, desde, hasta, dias, motivo || null, wfSnap]);
    if (wfSnap) { try { avisarAprobadorPendiente({ proceso: 'licencias', paso: ordenarPasos(JSON.parse(wfSnap))[0], resumen: `${tipo}: ${desde} a ${hasta}` }); } catch (e) { /* noop */ } }
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

// PUT /api/licencias/:id — RR.HH. (o gerente de su equipo) corrige una licencia ya cargada
// (tipo, fechas, motivo). Recalcula los días. No cambia el estado ni el comprobante.
router.put('/:id', async (req, res, next) => {
  try {
    const cur = (await query('SELECT empleado_id FROM licencias WHERE id=$1', [req.params.id])).rows[0];
    if (!cur) return res.status(404).json({ error: 'Licencia no encontrada' });
    const esRRHH = ['rrhh', 'admin'].includes(req.user.role);
    if (!esRRHH) {
      if (req.user.role !== 'manager') return res.status(403).json({ error: 'No autorizado' });
      const ids = await idsEquipoDe(req.user.id);
      if (!ids.has(cur.empleado_id)) return res.status(403).json({ error: 'Esa licencia no es de tu equipo.' });
    }
    const { tipo, desde, hasta, motivo } = req.body || {};
    if (!tipo || !desde || !hasta) return res.status(400).json({ error: 'tipo, desde y hasta son obligatorios' });
    if (hasta < desde) return res.status(400).json({ error: 'La fecha hasta debe ser posterior a desde' });
    const dias = diasEntre(desde, hasta);
    await query('UPDATE licencias SET tipo=$1, desde=$2, hasta=$3, dias=$4, motivo=$5 WHERE id=$6',
      [tipo, desde, hasta, dias, motivo || null, req.params.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// POST /api/licencias/justificar — el empleado informa Y justifica (con comprobante) una
// licencia imprevisible que NO fue solicitada antes (enfermedad, fallecimiento, etc.).
router.post('/justificar', async (req, res, next) => {
  try {
    const { tipo, desde, hasta, motivo, comprobanteNombre, comprobanteMime, comprobanteData } = req.body || {};
    if (!tipo || !desde || !hasta) return res.status(400).json({ error: 'Tipo, desde y hasta son obligatorios' });
    if (!comprobanteData) return res.status(400).json({ error: 'Debés adjuntar el comprobante que justifica la licencia.' });
    { const v = validarAdjunto({ nombre: comprobanteNombre, mime: comprobanteMime, data: comprobanteData }); if (!v.ok) return res.status(400).json({ error: v.error }); }
    if (hasta < desde) return res.status(400).json({ error: 'La fecha hasta debe ser posterior a desde' });
    const dias = diasEntre(desde, hasta);
    const wfSnap = await wfSnapLicencias();
    const ins = await query(
      `INSERT INTO licencias (empleado_id, tipo, desde, hasta, dias, motivo, estado, justificacion, comprobante_nombre, comprobante_mime, comprobante_data, workflow)
       VALUES ($1,$2,$3,$4,$5,$6,'pendiente',true,$7,$8,$9,$10)
       RETURNING id, empleado_id, tipo, desde, hasta, dias, motivo, estado, created_at, justificacion, comprobante_nombre, comprobante_mime, (comprobante_data IS NOT NULL) AS tiene_comprobante`,
      [req.user.id, String(tipo).trim(), desde, hasta, dias, motivo || null,
       comprobanteNombre || 'comprobante', comprobanteMime || 'application/octet-stream', comprobanteData, wfSnap]);
    if (wfSnap) { try { avisarAprobadorPendiente({ proceso: 'licencias', paso: ordenarPasos(JSON.parse(wfSnap))[0], resumen: `${String(tipo).trim()}: ${desde} a ${hasta}` }); } catch (e) { /* noop */ } }
    res.status(201).json(ins.rows[0]);
  } catch (e) { next(e); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const estado = (req.body || {}).estado;
    if (!['aprobada', 'rechazada'].includes(estado)) return res.status(400).json({ error: 'Estado inválido' });
    if (!(gestiona(req.user.role) || await tieneDelegacion(req.user, 'licencias'))) return res.status(403).json({ error: 'No tenés permisos para resolver licencias.' });
    // Gerente o delegado: solo su equipo (propio + delegado). RR.HH./admin: cualquiera.
    if (req.user.role !== 'rrhh' && req.user.role !== 'admin') {
      const cur = (await query('SELECT empleado_id FROM licencias WHERE id=$1', [req.params.id])).rows[0];
      if (!cur) return res.status(404).json({ error: 'La licencia no existe' });
      const ids = await equipoEfectivo(req.user, 'licencias');
      if (!ids.has(cur.empleado_id)) return res.status(403).json({ error: 'Esa licencia no corresponde a tu equipo.' });
    }
    const notaL = await notaDelegacion(req.user, 'licencias');
    const resueltoPor = notaL ? `${req.user.dni} (${notaL})` : req.user.dni;
    const r = await query(`UPDATE licencias SET estado=$1, resuelto_por=$2, resuelto_at=now() WHERE id=$3 AND estado='pendiente' RETURNING id`, [estado, resueltoPor, req.params.id]);
    if (!r.rowCount) return res.status(409).json({ error: 'La licencia no existe o ya fue resuelta' });
    res.json({ ok: true, estado });
  } catch (e) { next(e); }
});

// POST /api/licencias/:id/comprobante — el empleado justifica una licencia YA solicitada adjuntando el comprobante (paso posterior)
router.post('/:id/comprobante', async (req, res, next) => {
  try {
    const { comprobanteNombre, comprobanteMime, comprobanteData } = req.body || {};
    if (!comprobanteData) return res.status(400).json({ error: 'Debés adjuntar el comprobante.' });
    { const v = validarAdjunto({ nombre: comprobanteNombre, mime: comprobanteMime, data: comprobanteData }); if (!v.ok) return res.status(400).json({ error: v.error }); }
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
    const esGlobal = req.user.role === 'rrhh' || req.user.role === 'admin';
    let ok = esGlobal || lic.empleado_id === req.user.id;
    if (!ok && (req.user.role === 'manager' || await tieneDelegacion(req.user, 'licencias'))) ok = (await equipoEfectivo(req.user, 'licencias')).has(lic.empleado_id);
    if (!ok) return res.status(403).json({ error: 'No autorizado' });
    const buf = Buffer.from(lic.comprobante_data, 'base64');
    res.setHeader('Content-Type', mimeSeguro(lic.comprobante_mime));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `attachment; filename="${(lic.comprobante_nombre || 'comprobante').replace(/[^\w.\- ]/g, '_')}"`);
    res.send(buf);
  } catch (e) { next(e); }
});

// DELETE /api/licencias/:id — borra una licencia. RR.HH./admin cualquiera; el gerente, solo las de su equipo.
router.delete('/:id', async (req, res, next) => {
  try {
    const cur = (await query('SELECT empleado_id FROM licencias WHERE id=$1', [req.params.id])).rows[0];
    if (!cur) return res.status(404).json({ error: 'Licencia no encontrada' });
    const esRRHH = ['rrhh', 'admin'].includes(req.user.role);
    if (!esRRHH) {
      if (req.user.role !== 'manager') return res.status(403).json({ error: 'No autorizado' });
      const ids = await idsEquipoDe(req.user.id);
      if (!ids.has(cur.empleado_id)) return res.status(403).json({ error: 'Esa licencia no es de tu equipo.' });
    }
    await query('DELETE FROM licencias WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// GET /api/licencias/:id/flujo — pasos del workflow, aprobaciones y paso actual.
router.get('/:id/flujo', async (req, res, next) => {
  try {
    const l = (await query('SELECT empleado_id, estado, workflow FROM licencias WHERE id=$1', [req.params.id])).rows[0];
    if (!l) return res.status(404).json({ error: 'Licencia no encontrada' });
    const pasos = Array.isArray(l.workflow) ? l.workflow : [];
    const aprob = (await query('SELECT orden, rol, etiqueta, decision, actor_nom, actor_dni, comentario, at FROM licencia_aprobaciones WHERE licencia_id=$1 ORDER BY at', [req.params.id])).rows;
    const actual = l.estado === 'pendiente' ? pasoActual(pasos, aprob) : null;
    let puede = false;
    if (actual) {
      const uPuesto = await puestoDe(req.user.id);
      const enEquipo = req.user.role === 'manager' ? (await equipoEfectivo(req.user, 'licencias')).has(l.empleado_id) : false;
      puede = puedeResolver(actual, { role: req.user.role, puestoId: uPuesto }, { enEquipo });
    }
    res.json({ estado: l.estado, tieneWorkflow: pasos.length > 0, pasos: ordenarPasos(pasos), aprobaciones: aprob, pasoActual: actual, puedeResolver: puede });
  } catch (e) { next(e); }
});

// POST /api/licencias/:id/aprobar { decision: 'aprobado'|'rechazado', comentario? }
router.post('/:id/aprobar', async (req, res, next) => {
  try {
    const b = req.body || {};
    const decision = b.decision === 'rechazado' ? 'rechazado' : (b.decision === 'aprobado' ? 'aprobado' : null);
    if (!decision) return res.status(400).json({ error: 'Decisión inválida' });
    const l = (await query('SELECT empleado_id, estado, workflow FROM licencias WHERE id=$1', [req.params.id])).rows[0];
    if (!l) return res.status(404).json({ error: 'Licencia no encontrada' });
    if (l.estado !== 'pendiente') return res.status(409).json({ error: 'La licencia ya fue resuelta' });
    const pasos = Array.isArray(l.workflow) ? l.workflow : [];
    if (!pasos.length) return res.status(409).json({ error: 'Esta licencia no tiene flujo configurado; usá la aprobación clásica.' });
    const aprob = (await query('SELECT orden, decision FROM licencia_aprobaciones WHERE licencia_id=$1', [req.params.id])).rows;
    const paso = pasoActual(pasos, aprob);
    if (!paso) return res.status(409).json({ error: 'No hay pasos pendientes' });
    const uPuesto = await puestoDe(req.user.id);
    const enEquipo = req.user.role === 'manager' ? (await equipoEfectivo(req.user, 'licencias')).has(l.empleado_id) : false;
    if (!puedeResolver(paso, { role: req.user.role, puestoId: uPuesto }, { enEquipo }))
      return res.status(403).json({ error: `Este paso lo resuelve ${paso.etiqueta || (paso.puesto ? 'un puesto específico' : 'el rol ' + paso.rol)}.` });

    await query('INSERT INTO licencia_aprobaciones (licencia_id, orden, rol, etiqueta, decision, actor_dni, actor_nom, comentario) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [req.params.id, paso.orden, paso.rol || null, paso.etiqueta || null, decision, req.user.dni, req.user.nom || req.user.dni, b.comentario || null]);

    const r = resultadoDecision(pasos, aprob, paso, decision);
    if (r.estado === 'rechazado') {
      await query("UPDATE licencias SET estado='rechazada', resuelto_por=$1, resuelto_at=now() WHERE id=$2", [req.user.dni, req.params.id]);
      avisarSolicitante({ empleadoId: l.empleado_id, proceso: 'licencias', estado: 'rechazada' });
      return res.json({ ok: true, estado: 'rechazada' });
    }
    if (r.estado === 'pendiente') { avisarAprobadorPendiente({ proceso: 'licencias', paso: r.siguiente }); return res.json({ ok: true, estado: 'pendiente', siguiente: r.siguiente }); }
    await query("UPDATE licencias SET estado='aprobada', resuelto_por=$1, resuelto_at=now() WHERE id=$2", [req.user.dni, req.params.id]);
    avisarSolicitante({ empleadoId: l.empleado_id, proceso: 'licencias', estado: 'aprobada' });
    res.json({ ok: true, estado: 'aprobada' });
  } catch (e) { next(e); }
});

export default router;
