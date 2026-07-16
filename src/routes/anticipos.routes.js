import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { idsEquipoDe } from '../lib/equipo.js';
import { equipoEfectivo, notaDelegacion } from '../lib/delegaciones.js';
import { ordenarPasos, pasoActual, puedeResolver, resultadoDecision } from '../lib/workflowEngine.js';
import { avisarAprobadorPendiente, avisarSolicitante } from '../lib/notifAprob.js';

const router = Router();
router.use(requireAuth);

const puedeAprobar = (role) => ['manager', 'rrhh', 'admin'].includes(role);

// GET /api/anticipos — propios; rrhh/manager/admin ven todos
router.get('/', async (req, res, next) => {
  try {
    if (puedeAprobar(req.user.role)) {
      const cond = [], params = [];
      if (req.user.role === 'manager') {
        const ids = [...await equipoEfectivo(req.user, 'adelantos')]; // propio + delegado
        if (!ids.length) return res.json([]);
        params.push(ids); cond.push(`a.empleado_id = ANY($${params.length})`);
        // El gerente solo ve los adelantos del año en curso.
        cond.push("a.created_at >= date_trunc('year', CURRENT_DATE)");
      } else {
        // RR.HH./admin: solo adelantos otorgados en el último año, salvo los de más de un año
        // que todavía tengan cuotas pendientes de descuento (aprobados con pagadas < cuotas).
        cond.push("(a.created_at >= CURRENT_DATE - INTERVAL '1 year' OR (a.estado = 'aprobado' AND COALESCE(cu.pagadas, 0) < a.cuotas))");
      }
      const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
      const { rows } = await query(
        `SELECT a.*, COALESCE(cu.pagadas,0)::int AS cuotas_pagadas, COALESCE(cu.total_pagado,0)::float AS total_pagado,
                e.nom, e.leg_num, em.nombre AS empresa, e.bruto::float AS bruto,
                COALESCE((SELECT (r.neto - COALESCE((SELECT SUM((h->>'monto')::numeric) FROM jsonb_array_elements(r.data->'haberes') h WHERE h->>'concepto' ILIKE '%SAC%'), 0))
                            FROM recibos r WHERE r.empleado_id=a.empleado_id AND r.tipo IN ('mensual','quincenal_1','quincenal_2')
                            ORDER BY r.anio DESC, r.mes DESC LIMIT 1), e.neto)::float AS ultimo_neto
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
    const now = new Date(); const mesActual = now.getMonth() + 1; const anioActual = now.getFullYear();
    // No se otorgan adelantos en meses de SAC (junio/diciembre) ni el mes siguiente (julio/enero).
    if ([6, 7, 12, 1].includes(mesActual)) {
      return res.status(400).json({ error: 'Según el reglamento, no se otorgan adelantos en los meses de SAC (junio y diciembre) ni en el mes siguiente (julio y enero).' });
    }
    // Máximo un adelanto por trimestre (no rechazado).
    const q = Math.floor((mesActual - 1) / 3); const m0 = q * 3 + 1, m1 = q * 3 + 3;
    const ya = await query(
      `SELECT 1 FROM anticipos WHERE empleado_id=$1 AND estado <> 'rechazado'
         AND EXTRACT(YEAR FROM created_at)=$2 AND EXTRACT(MONTH FROM created_at) BETWEEN $3 AND $4 LIMIT 1`,
      [req.user.id, anioActual, m0, m1]);
    if (ya.rowCount) return res.status(400).json({ error: 'Ya tenés un adelanto solicitado/aprobado en este trimestre. El reglamento permite un (1) adelanto por trimestre.' });
    // Cuenta corriente abierta: adelanto aprobado aún no cancelado (cuotas pendientes) → no se otorga otro.
    const abierto = await query(
      `SELECT 1 FROM anticipos a LEFT JOIN anticipo_cuotas c ON c.anticipo_id=a.id
        WHERE a.empleado_id=$1 AND a.estado='aprobado'
        GROUP BY a.id, a.cuotas HAVING COUNT(c.id) < a.cuotas LIMIT 1`, [req.user.id]);
    if (abierto.rowCount) return res.status(400).json({ error: 'Tenés un adelanto en curso sin cancelar (cuenta corriente abierta). El reglamento no permite un nuevo adelanto hasta cancelarlo totalmente.' });
    // Snapshot del flujo de aprobación configurado para 'adelantos' (si existe).
    let wfSnap = null;
    try {
      const wf = (await query("SELECT pasos FROM workflows WHERE activo AND proceso='adelantos' ORDER BY updated_at DESC LIMIT 1")).rows[0];
      if (wf && Array.isArray(wf.pasos) && wf.pasos.length) wfSnap = JSON.stringify(wf.pasos);
    } catch (e) { /* sin workflow: flujo clásico */ }
    const ins = await query(
      'INSERT INTO anticipos (empleado_id, monto, motivo, cuotas, workflow) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [req.user.id, monto, motivo || null, cuotas, wfSnap]
    );
    if (wfSnap) { try { avisarAprobadorPendiente({ proceso: 'adelantos', paso: ordenarPasos(JSON.parse(wfSnap))[0], resumen: `Monto: ${monto}` }); } catch (e) { /* noop */ } }
    res.status(201).json(ins.rows[0]);
  } catch (e) { next(e); }
});

// Próximo período YYYY-MM (mes siguiente a hoy) para la primera cuota.
function proxPeriodo() {
  const d = new Date(); d.setMonth(d.getMonth() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Puesto (puesto_id) del usuario, para pasos de workflow por puesto.
async function puestoDe(userId) {
  const r = (await query('SELECT puesto_id FROM empleados WHERE id=$1', [userId])).rows[0];
  return r ? r.puesto_id : null;
}

// PATCH /api/anticipos/:id/recomendacion — el GERENTE da su visto bueno sobre su equipo
// (recomienda favorable/desfavorable). NO resuelve: la decisión final es de RR.HH.
router.patch('/:id/recomendacion', requireRole('manager', 'rrhh', 'admin'), async (req, res, next) => {
  try {
    const rec = (req.body || {}).recomendacion;
    if (!['favorable', 'desfavorable'].includes(rec)) return res.status(400).json({ error: 'Recomendación inválida' });
    const cur = (await query('SELECT empleado_id, estado FROM anticipos WHERE id=$1', [req.params.id])).rows[0];
    if (!cur) return res.status(404).json({ error: 'El adelanto no existe' });
    if (cur.estado !== 'pendiente') return res.status(409).json({ error: 'El adelanto ya fue resuelto por RR.HH.' });
    if (req.user.role === 'manager') {
      const ids = await equipoEfectivo(req.user, 'adelantos');
      if (!ids.has(cur.empleado_id)) return res.status(403).json({ error: 'Ese adelanto no corresponde a tu equipo.' });
    }
    const notaA = await notaDelegacion(req.user, 'adelantos');
    const recPor = notaA ? `${req.user.dni} (${notaA})` : req.user.dni;
    await query('UPDATE anticipos SET recomendacion=$1, recomendado_por=$2, recomendado_at=now() WHERE id=$3',
      [rec, recPor, req.params.id]);
    res.json({ ok: true, recomendacion: rec });
  } catch (e) { next(e); }
});

// PATCH /api/anticipos/:id — OTORGAMIENTO/RECHAZO + cuotas. Decisión final: RR.HH. (admin como superusuario).
router.patch('/:id', requireRole('rrhh', 'admin'), async (req, res, next) => {
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
    const esGlobal = req.user.role === 'rrhh' || req.user.role === 'admin';
    let ok = esGlobal || a.empleado_id === req.user.id;
    if (!ok && req.user.role === 'manager') ok = (await equipoEfectivo(req.user, 'adelantos')).has(a.empleado_id);
    if (!ok) return res.status(403).json({ error: 'Sin permiso' });
    const { rows } = await query('SELECT nro, anio, mes, monto, created_at FROM anticipo_cuotas WHERE anticipo_id=$1 ORDER BY anio, mes', [req.params.id]);
    res.json(rows);
  } catch (e) { next(e); }
});

// GET /api/anticipos/:id/flujo — pasos del workflow, aprobaciones y paso actual.
router.get('/:id/flujo', async (req, res, next) => {
  try {
    const a = (await query('SELECT empleado_id, estado, workflow FROM anticipos WHERE id=$1', [req.params.id])).rows[0];
    if (!a) return res.status(404).json({ error: 'Adelanto no encontrado' });
    const pasos = Array.isArray(a.workflow) ? a.workflow : [];
    const aprob = (await query('SELECT orden, rol, etiqueta, decision, actor_nom, actor_dni, comentario, at FROM anticipo_aprobaciones WHERE anticipo_id=$1 ORDER BY at', [req.params.id])).rows;
    const actual = a.estado === 'pendiente' ? pasoActual(pasos, aprob) : null;
    let puede = false;
    if (actual) {
      const uPuesto = await puestoDe(req.user.id);
      const enEquipo = req.user.role === 'manager' ? (await equipoEfectivo(req.user, 'adelantos')).has(a.empleado_id) : false;
      puede = puedeResolver(actual, { role: req.user.role, puestoId: uPuesto }, { enEquipo });
    }
    res.json({ estado: a.estado, tieneWorkflow: pasos.length > 0, pasos: ordenarPasos(pasos), aprobaciones: aprob, pasoActual: actual, puedeResolver: puede });
  } catch (e) { next(e); }
});

// POST /api/anticipos/:id/aprobar { decision, comentario?, cuotas?, cuotaDesde? }
router.post('/:id/aprobar', async (req, res, next) => {
  try {
    const b = req.body || {};
    const decision = b.decision === 'rechazado' ? 'rechazado' : (b.decision === 'aprobado' ? 'aprobado' : null);
    if (!decision) return res.status(400).json({ error: 'Decisión inválida' });
    const a = (await query('SELECT empleado_id, estado, workflow, cuotas FROM anticipos WHERE id=$1', [req.params.id])).rows[0];
    if (!a) return res.status(404).json({ error: 'Adelanto no encontrado' });
    if (a.estado !== 'pendiente') return res.status(409).json({ error: 'El adelanto ya fue resuelto' });
    const pasos = Array.isArray(a.workflow) ? a.workflow : [];
    if (!pasos.length) return res.status(409).json({ error: 'Este adelanto no tiene flujo configurado; usá el otorgamiento clásico de RR.HH.' });
    const aprob = (await query('SELECT orden, decision FROM anticipo_aprobaciones WHERE anticipo_id=$1', [req.params.id])).rows;
    const paso = pasoActual(pasos, aprob);
    if (!paso) return res.status(409).json({ error: 'No hay pasos pendientes' });
    const uPuesto = await puestoDe(req.user.id);
    const enEquipo = req.user.role === 'manager' ? (await equipoEfectivo(req.user, 'adelantos')).has(a.empleado_id) : false;
    if (!puedeResolver(paso, { role: req.user.role, puestoId: uPuesto }, { enEquipo }))
      return res.status(403).json({ error: `Este paso lo resuelve ${paso.etiqueta || (paso.puesto ? 'un puesto específico' : 'el rol ' + paso.rol)}.` });

    await query('INSERT INTO anticipo_aprobaciones (anticipo_id, orden, rol, etiqueta, decision, actor_dni, actor_nom, comentario) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [req.params.id, paso.orden, paso.rol || null, paso.etiqueta || null, decision, req.user.dni, req.user.nom || req.user.dni, b.comentario || null]);

    const r = resultadoDecision(pasos, aprob, paso, decision);
    if (r.estado === 'rechazado') {
      await query("UPDATE anticipos SET estado='rechazado', resuelto_por=$1, resuelto_at=now() WHERE id=$2", [req.user.dni, req.params.id]);
      avisarSolicitante({ empleadoId: a.empleado_id, proceso: 'adelantos', estado: 'rechazado' });
      return res.json({ ok: true, estado: 'rechazado' });
    }
    if (r.estado === 'pendiente') { avisarAprobadorPendiente({ proceso: 'adelantos', paso: r.siguiente }); return res.json({ ok: true, estado: 'pendiente', siguiente: r.siguiente }); }
    const nCuotas = (req.user.role === 'rrhh' || req.user.role === 'admin') ? Math.max(1, parseInt(b.cuotas, 10) || a.cuotas || 1) : (a.cuotas || 1);
    const desde = (b.cuotaDesde && /^\d{4}-\d{2}$/.test(b.cuotaDesde)) ? b.cuotaDesde : proxPeriodo();
    await query("UPDATE anticipos SET estado='aprobado', cuotas=$1, cuota_desde=$2, resuelto_por=$3, resuelto_at=now() WHERE id=$4",
      [nCuotas, desde, req.user.dni, req.params.id]);
    avisarSolicitante({ empleadoId: a.empleado_id, proceso: 'adelantos', estado: 'aprobado', resumen: `Cuotas: ${nCuotas}` });
    res.json({ ok: true, estado: 'aprobado', cuotas: nCuotas, cuotaDesde: desde });
  } catch (e) { next(e); }
});

export default router;
