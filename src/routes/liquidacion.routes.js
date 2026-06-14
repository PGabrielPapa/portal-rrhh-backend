import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { calcularRecibo } from '../lib/liquidacion.js';
import { ganTablaParaFecha } from '../lib/gananciasParams.js';

const router = Router();
router.use(requireAuth);

async function registrarCuotas(cuotas, anio, mes, reciboId, corridaId) {
  for (const c of (cuotas || [])) {
    await query(
      `INSERT INTO anticipo_cuotas (anticipo_id, recibo_id, corrida_id, anio, mes, nro, monto)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (anticipo_id, anio, mes)
       DO UPDATE SET recibo_id=EXCLUDED.recibo_id, corrida_id=EXCLUDED.corrida_id, nro=EXCLUDED.nro, monto=EXCLUDED.monto`,
      [c.anticipoId, reciboId || null, corridaId || null, Number(anio), Number(mes), c.nro || null, c.monto]
    );
  }
}

// Acumulado de Ganancias enero→mes-1: remunerativo, aportes y retención ya practicada.
async function acumGananciasDe(empleadoId, anio, mes) {
  const rows = (await query(
    `SELECT data FROM recibos WHERE empleado_id=$1 AND anio=$2 AND mes < $3
       AND tipo IN ('mensual','quincenal_1','quincenal_2','sac1','sac2','vacaciones')`,
    [empleadoId, Number(anio), Number(mes)])).rows;
  let remGravAcum = 0, aportesAcum = 0, retenidoAcum = 0;
  for (const { data } of rows) {
    const t = data?.totales || {};
    remGravAcum += Number(t.totalRemun || 0);
    // aportes = descuentos que no son Ganancias ni embargos/anticipos (aproximación: usar ganancias.aportesAcum del detalle si está)
    const g = data?.ganancias;
    if (g) { aportesAcum += 0; } // el acumulado de aportes se reconstruye abajo
    for (const d of (data?.descuentos || [])) {
      if (/Ganancias/i.test(d.concepto)) retenidoAcum += Number(d.monto || 0);
      else if (/Jubilación|Obra Social|ANSSAL|INSSJP|Cuota sindical/i.test(d.concepto)) aportesAcum += Number(d.monto || 0);
    }
  }
  return { remGravAcum: r2(remGravAcum), aportesAcum: r2(aportesAcum), retenidoAcum: r2(retenidoAcum) };
}

async function getEmp(id) {
  const er = await query(`SELECT e.*, em.nombre AS empresa_nombre FROM empleados e JOIN empresas em ON em.id=e.empresa_id WHERE e.id=$1`, [id]);
  if (!er.rows[0]) return null;
  const r = er.rows[0];
  return { id: r.id, legNum: r.leg_num, nom: r.nom, empresa: r.empresa_nombre, cuil: r.cuil, cat: r.cat, ingreso: r.ingreso, bruto: Number(r.bruto), data: r.data || {} };
}
async function getParams() { const pr = await query('SELECT data FROM parametros_liq WHERE id = 1'); return pr.rows[0]?.data || {}; }

// Cuotas de anticipos aprobados a descontar en (anio, mes). Determinístico por período.
function r2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }
async function cuotasAnticiposDe(empleadoId, anio, mes) {
  const rows = (await query(
    `SELECT id, monto, cuotas, cuota_desde, motivo, resuelto_at FROM anticipos
      WHERE empleado_id=$1 AND estado='aprobado' AND cuotas > 0`, [empleadoId])).rows;
  const out = [];
  for (const a of rows) {
    let desde = a.cuota_desde;
    if (!desde) { const d = a.resuelto_at ? new Date(a.resuelto_at) : new Date(); d.setMonth(d.getMonth() + 1); desde = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; }
    const [y0, m0] = desde.split('-').map(Number);
    const idx = (Number(anio) - y0) * 12 + (Number(mes) - m0);
    if (idx >= 0 && idx < a.cuotas) {
      const base = r2(Number(a.monto) / a.cuotas);
      const monto = (idx === a.cuotas - 1) ? r2(Number(a.monto) - base * (a.cuotas - 1)) : base;
      out.push({ anticipoId: a.id, nro: idx + 1, cuotas: a.cuotas, monto, motivo: a.motivo || '' });
    }
  }
  return out;
}

// ── Individual: calcular (no persiste) ──
router.post('/calcular', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const { empleadoId, anio, mes, tipo, ...extra } = req.body || {};
    if (!empleadoId || !anio || !mes) return res.status(400).json({ error: 'empleadoId, anio y mes son obligatorios' });
    const emp = await getEmp(empleadoId);
    if (!emp) return res.status(404).json({ error: 'Empleado no encontrado' });
    const t = tipo || 'mensual';
    const cuotas = (t === 'mensual' || t === 'quincenal_1' || t === 'quincenal_2') ? await cuotasAnticiposDe(empleadoId, anio, mes) : [];
    const acumGan = await acumGananciasDe(empleadoId, anio, mes);
    const ganTabla = await ganTablaParaFecha(extra.fechaPago || `${anio}-${String(mes).padStart(2, '0')}-15`);
    res.json(calcularRecibo(emp, await getParams(), { anio: Number(anio), mes: Number(mes), tipo: t, cuotasAnticipos: cuotas, acumGanancias: acumGan, ganTabla, ...extra }));
  } catch (e) { next(e); }
});

// ── Individual: guardar (recibo suelto, no publicado) ──
router.post('/guardar', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const { empleadoId, anio, mes, tipo = 'mensual', ...extra } = req.body || {};
    if (!empleadoId || !anio || !mes) return res.status(400).json({ error: 'empleadoId, anio y mes son obligatorios' });
    const emp = await getEmp(empleadoId);
    if (!emp) return res.status(404).json({ error: 'Empleado no encontrado' });
    const cuotas = (tipo === 'mensual' || tipo === 'quincenal_1' || tipo === 'quincenal_2') ? await cuotasAnticiposDe(empleadoId, anio, mes) : [];
    const acumGan = await acumGananciasDe(empleadoId, anio, mes);
    const ganTabla = await ganTablaParaFecha(extra.fechaPago || `${anio}-${String(mes).padStart(2, '0')}-15`);
    const recibo = calcularRecibo(emp, await getParams(), { anio: Number(anio), mes: Number(mes), tipo, cuotasAnticipos: cuotas, acumGanancias: acumGan, ganTabla, ...extra });
    const ins = await query(
      `INSERT INTO recibos (empleado_id, anio, mes, tipo, neto, data, created_by, publicado)
       VALUES ($1,$2,$3,$4,$5,$6,$7,true)
       ON CONFLICT (empleado_id, anio, mes, tipo)
       DO UPDATE SET neto=EXCLUDED.neto, data=EXCLUDED.data, created_by=EXCLUDED.created_by, publicado=true, created_at=now()
       RETURNING id`,
      [empleadoId, Number(anio), Number(mes), tipo, recibo.totales.neto, JSON.stringify(recibo), req.user.dni]
    );
    await registrarCuotas(cuotas, anio, mes, ins.rows[0].id, null);
    res.json({ ok: true, id: ins.rows[0].id, recibo });
  } catch (e) { next(e); }
});

// ════════════ CORRIDA (planilla por período) ════════════

// POST /api/liquidacion/corrida { anio, mes, tipo, empresa? } — calcula y guarda recibos (borrador, no publicados)
router.post('/corrida', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const { anio, mes, tipo = 'mensual', empresa, fechaPago } = req.body || {};
    if (!anio || !mes) return res.status(400).json({ error: 'anio y mes son obligatorios' });
    const cond = ['e.activo = true'], pr = [];
    if (empresa) { pr.push(empresa); cond.push(`em.nombre = $${pr.length}`); }
    const emps = (await query(
      `SELECT e.id FROM empleados e JOIN empresas em ON em.id=e.empresa_id WHERE ${cond.join(' AND ')}`, pr)).rows;
    if (!emps.length) return res.status(400).json({ error: 'No hay empleados activos para ese filtro' });

    const params = await getParams();
    const ganTabla = await ganTablaParaFecha(fechaPago || `${anio}-${String(mes).padStart(2, '0')}-15`);
    const cr = await query(
      `INSERT INTO corridas (anio, mes, tipo, empresa, estado, creado_por) VALUES ($1,$2,$3,$4,'borrador',$5) RETURNING id`,
      [Number(anio), Number(mes), tipo, empresa || null, req.user.dni]
    );
    const corridaId = cr.rows[0].id;
    let totalNeto = 0, cant = 0;
    for (const { id } of emps) {
      const emp = await getEmp(id);
      const cuotas = (tipo === 'mensual' || tipo === 'quincenal_1' || tipo === 'quincenal_2') ? await cuotasAnticiposDe(id, anio, mes) : [];
      const acumGan = await acumGananciasDe(id, anio, mes);
      const recibo = calcularRecibo(emp, params, { anio: Number(anio), mes: Number(mes), tipo, fechaPago, cuotasAnticipos: cuotas, acumGanancias: acumGan, ganTabla });
      totalNeto += recibo.totales.neto; cant++;
      const rr = await query(
        `INSERT INTO recibos (empleado_id, anio, mes, tipo, neto, data, created_by, corrida_id, publicado)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,false)
         ON CONFLICT (empleado_id, anio, mes, tipo)
         DO UPDATE SET neto=EXCLUDED.neto, data=EXCLUDED.data, created_by=EXCLUDED.created_by, corrida_id=EXCLUDED.corrida_id, publicado=false, created_at=now()
         RETURNING id`,
        [id, Number(anio), Number(mes), tipo, recibo.totales.neto, JSON.stringify(recibo), req.user.dni, corridaId]
      );
      await registrarCuotas(cuotas, anio, mes, rr.rows[0].id, corridaId);
    }
    await query('UPDATE corridas SET total_neto=$1, cant=$2 WHERE id=$3', [totalNeto, cant, corridaId]);
    res.status(201).json({ ok: true, id: corridaId, cant, totalNeto });
  } catch (e) { next(e); }
});

// GET /api/liquidacion/corridas — lista de corridas
router.get('/corridas', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM corridas ORDER BY created_at DESC LIMIT 100');
    res.json(rows);
  } catch (e) { next(e); }
});

// GET /api/liquidacion/corrida/:id — planilla (cabecera + recibos)
router.get('/corrida/:id', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const c = (await query('SELECT * FROM corridas WHERE id=$1', [req.params.id])).rows[0];
    if (!c) return res.status(404).json({ error: 'Corrida no encontrada' });
    const items = (await query(
      `SELECT r.id, r.neto, r.data, e.nom, e.leg_num, em.nombre AS empresa
         FROM recibos r JOIN empleados e ON e.id=r.empleado_id JOIN empresas em ON em.id=e.empresa_id
        WHERE r.corrida_id=$1 ORDER BY em.nombre ASC, e.leg_num ASC`, [req.params.id])).rows;
    res.json({
      corrida: c,
      items: items.map((r) => ({
        id: r.id, nom: r.nom, legNum: r.leg_num, empresa: r.empresa,
        neto: Number(r.neto),
        totalRemun: r.data?.totales?.totalRemun || 0, totalNoRem: r.data?.totales?.totalNoRem || 0,
        totalHaberes: r.data?.totales?.totalHaberes || 0,
        totalDescuentos: r.data?.totales?.totalDescuentos || 0,
        costoTotal: r.data?.costoEmpleador?.costoTotal || 0,
        haberes: r.data?.haberes || [], descuentos: r.data?.descuentos || [],
      })),
    });
  } catch (e) { next(e); }
});

// POST /api/liquidacion/corrida/:id/aprobar
router.post('/corrida/:id/aprobar', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const r = await query(`UPDATE corridas SET estado='aprobada', aprobado_por=$1, aprobado_at=now() WHERE id=$2 AND estado='borrador' RETURNING id`, [req.user.dni, req.params.id]);
    if (!r.rowCount) return res.status(409).json({ error: 'La corrida no existe o no está en borrador' });
    res.json({ ok: true, estado: 'aprobada' });
  } catch (e) { next(e); }
});

// POST /api/liquidacion/corrida/:id/publicar — recibos visibles para los empleados
router.post('/corrida/:id/publicar', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const c = (await query('SELECT estado FROM corridas WHERE id=$1', [req.params.id])).rows[0];
    if (!c) return res.status(404).json({ error: 'Corrida no encontrada' });
    if (c.estado !== 'aprobada') return res.status(409).json({ error: 'La corrida debe estar aprobada antes de publicar' });
    await query('UPDATE recibos SET publicado=true WHERE corrida_id=$1', [req.params.id]);
    await query(`UPDATE corridas SET estado='publicada', publicado_at=now() WHERE id=$1`, [req.params.id]);
    res.json({ ok: true, estado: 'publicada' });
  } catch (e) { next(e); }
});

// DELETE /api/liquidacion/corrida/:id — elimina la corrida y sus recibos (si no está publicada)
router.delete('/corrida/:id', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const c = (await query('SELECT estado FROM corridas WHERE id=$1', [req.params.id])).rows[0];
    if (!c) return res.status(404).json({ error: 'Corrida no encontrada' });
    if (c.estado === 'publicada') return res.status(409).json({ error: 'No se puede borrar una corrida publicada' });
    await query('DELETE FROM anticipo_cuotas WHERE corrida_id=$1', [req.params.id]);
    await query('DELETE FROM recibos WHERE corrida_id=$1', [req.params.id]);
    await query('DELETE FROM corridas WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// GET /api/liquidacion/corrida/:id/reporte — totales por empresa y concepto
router.get('/corrida/:id/reporte', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const rows = (await query('SELECT r.data, em.nombre AS empresa FROM recibos r JOIN empleados e ON e.id=r.empleado_id JOIN empresas em ON em.id=e.empresa_id WHERE r.corrida_id=$1', [req.params.id])).rows;
    const porEmpresa = {}; const conceptos = {}; let neto = 0, remun = 0, noRem = 0, desc = 0, costo = 0;
    for (const { data, empresa } of rows) {
      const t = data?.totales || {}, ce = data?.costoEmpleador || {};
      porEmpresa[empresa] = porEmpresa[empresa] || { cant: 0, neto: 0, remun: 0, costo: 0 };
      porEmpresa[empresa].cant++; porEmpresa[empresa].neto += t.neto || 0; porEmpresa[empresa].remun += t.totalRemun || 0; porEmpresa[empresa].costo += ce.costoTotal || 0;
      neto += t.neto || 0; remun += t.totalRemun || 0; noRem += t.totalNoRem || 0; desc += t.totalDescuentos || 0; costo += ce.costoTotal || 0;
      for (const dd of (data?.descuentos || [])) conceptos[dd.concepto] = (conceptos[dd.concepto] || 0) + dd.monto;
    }
    res.json({ totales: { cant: rows.length, neto, remun, noRem, desc, costo }, porEmpresa, conceptos });
  } catch (e) { next(e); }
});

// GET /api/liquidacion/corrida/:id/banco — archivo de acreditación (CSV)
router.get('/corrida/:id/banco', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const rows = (await query(
      `SELECT e.leg_num, e.nom, e.cuil, r.neto,
              (SELECT json_agg(json_build_object('cbu', c.cbu, 'pct', c.porcentaje)) FROM cbus c WHERE c.empleado_id=e.id AND c.activo=true) AS cbus
         FROM recibos r JOIN empleados e ON e.id=r.empleado_id
        WHERE r.corrida_id=$1 ORDER BY e.nom`, [req.params.id])).rows;
    const lineas = ['Legajo,Nombre,CUIL,CBU,Porcentaje,Importe'];
    for (const r of rows) {
      const cbus = r.cbus && r.cbus.length ? r.cbus : [{ cbu: '', pct: 100 }];
      for (const c of cbus) {
        const imp = (Number(r.neto) * Number(c.pct || 100) / 100).toFixed(2);
        lineas.push(`${r.leg_num},"${r.nom}",${r.cuil || ''},${c.cbu || ''},${c.pct || 100},${imp}`);
      }
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="acreditacion_corrida_${req.params.id}.csv"`);
    res.send('﻿' + lineas.join('\r\n'));
  } catch (e) { next(e); }
});

export default router;
