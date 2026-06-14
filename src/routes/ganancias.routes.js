import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { calcularRecibo } from '../lib/liquidacion.js';
import { ganTablaParaFecha, mapGanRow } from '../lib/gananciasParams.js';
import { requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

const gestiona = (role) => ['rrhh', 'admin'].includes(role);
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const hoy = () => { const d = new Date(); return { anio: d.getFullYear(), mes: d.getMonth() + 1 }; };

// Acumula remunerativo y aportes por categoría + retención, de enero a mes-1.
async function acumular(empleadoId, anio, mes) {
  const rows = (await query(
    `SELECT data FROM recibos WHERE empleado_id=$1 AND anio=$2 AND mes < $3
       AND tipo IN ('mensual','quincenal_1','quincenal_2','sac1','sac2','vacaciones')`,
    [empleadoId, Number(anio), Number(mes)])).rows;
  const a = { remun: 0, jub: 0, os: 0, sind: 0, retenido: 0 };
  for (const { data } of rows) {
    a.remun += Number(data?.totales?.totalRemun || 0);
    for (const d of (data?.descuentos || [])) {
      const c = d.concepto || '';
      if (/Ganancias/i.test(c)) a.retenido += Number(d.monto || 0);
      else if (/Jubilación/i.test(c)) a.jub += Number(d.monto || 0);
      else if (/Obra Social|ANSSAL|INSSJP/i.test(c)) a.os += Number(d.monto || 0);
      else if (/Cuota sindical/i.test(c)) a.sind += Number(d.monto || 0);
    }
  }
  return a;
}

async function f1357For(empleadoId, anio, mes, anualizada) {
  const er = await query(
    `SELECT e.*, em.nombre AS empresa_nombre FROM empleados e JOIN empresas em ON em.id = e.empresa_id WHERE e.id = $1`, [empleadoId]);
  if (!er.rows[0]) return null;
  const r = er.rows[0];
  const emp = { legNum: r.leg_num, nom: r.nom, empresa: r.empresa_nombre, cuil: r.cuil, cat: r.cat, ingreso: r.ingreso, bruto: Number(r.bruto), data: r.data || {} };
  const params = (await query('SELECT data FROM parametros_liq WHERE id = 1')).rows[0]?.data || {};
  const fams = (await query('SELECT tipo, discapacidad, vigencia_hasta FROM familiares WHERE empleado_id = $1', [empleadoId])).rows.filter((x) => !x.vigencia_hasta);
  const esConyuge = (t) => ['conyuge', 'cónyuge', 'concubino', 'concubina'].includes(String(t || '').toLowerCase());
  const esHijo = (t) => ['hijo', 'hija', 'hijastro', 'hijastra'].includes(String(t || '').toLowerCase());
  const tieneConyuge = fams.some((x) => esConyuge(x.tipo));
  const nroHijosMenores = fams.filter((x) => esHijo(x.tipo) && !x.discapacidad).length;
  const nroHijosIncapacitados = fams.filter((x) => esHijo(x.tipo) && x.discapacidad).length;

  const fechaRef = `${anio}-${String(mes).padStart(2, '0')}-15`;
  const ganTabla = await ganTablaParaFecha(fechaRef);
  const ac = await acumular(empleadoId, anio, mes);
  // Mes corriente: usa el recibo guardado si existe; si no, lo calcula al vuelo.
  const guardado = (await query(
    `SELECT data FROM recibos WHERE empleado_id=$1 AND anio=$2 AND mes=$3 AND tipo='mensual' LIMIT 1`,
    [empleadoId, Number(anio), Number(mes)])).rows[0]?.data;
  const rec = guardado || calcularRecibo(emp, params, {
    anio: Number(anio), mes: Number(mes), tipo: anualizada ? 'anual' : 'mensual',
    fechaPago: fechaRef, ganTabla,
    acumGanancias: { remGravAcum: ac.remun, aportesAcum: ac.jub + ac.os + ac.sind, retenidoAcum: ac.retenido },
    tieneConyuge, nroHijosMenores, nroHijosIncapacitados, gananciasAnualizada: anualizada,
  });
  const g = rec.ganancias || {};
  // Aportes acumulados por categoría = previos + mes corriente
  let curJub = 0, curOS = 0, curSind = 0;
  for (const d of (rec.descuentos || [])) {
    const c = d.concepto || '';
    if (/Jubilación/i.test(c)) curJub += Number(d.monto || 0);
    else if (/Obra Social|ANSSAL|INSSJP/i.test(c)) curOS += Number(d.monto || 0);
    else if (/Cuota sindical/i.test(c)) curSind += Number(d.monto || 0);
  }
  const jub = r2(ac.jub + curJub), os = r2(ac.os + curOS), sind = r2(ac.sind + curSind);
  const ret = Number(g.retencionPeriodo || 0);

  return {
    empleado: { legNum: emp.legNum, nom: emp.nom, empresa: emp.empresa, cuil: emp.cuil, cat: emp.cat },
    periodo: { anio: Number(anio), mes: Number(mes), periodoLabel: `${String(mes).padStart(2, '0')}/${anio}`, tablas: g.periodo || '', anualizada: !!g.anualizada, mesesTranscurridos: g.mesesTranscurridos || mes },
    gravadas: { remBrutaNoHab: r2(g.remGravAcum || 0), sac: 0, totalGravada: r2(g.remGravAcum || 0) },
    dedGenerales: { jubilacion: jub, obraSocial: os, cuotaSindical: sind, total: r2(g.aportesAcum || (jub + os + sind)) },
    dedPersonales: {
      mni: r2(g.mni || 0),
      cargasFamilia: { total: r2(g.cargasFamilia || 0), tieneConyuge, nHijos: nroHijosMenores, nHijosInc: nroHijosIncapacitados },
      dedEspecial: r2(g.dedEspecial || 0), dedEspecial2: r2(g.dedEspecial2 || 0), dedVoluntarias: r2(g.dedVoluntarias || 0),
      total: r2((g.mni || 0) + (g.cargasFamilia || 0) + (g.dedEspecial || 0) + (g.dedEspecial2 || 0) + (g.dedVoluntarias || 0)),
    },
    determinacion: {
      remSujeta: r2(g.remSujeta || 0), impuestoDeterminado: r2(g.impuestoDeterminado || 0),
      retenidoAnterior: r2(g.retenidoAnterior || ac.retenido),
      impuestoARetener: r2(Math.max(0, ret)), devolucion: r2(Math.max(0, -ret)),
    },
    nota: 'Cálculo acumulado (RG 4003/17). Montos de Ganancias según parámetros vigentes cargados.',
  };
}

router.get('/f1357', async (req, res, next) => {
  try {
    const def = hoy();
    const out = await f1357For(req.user.id, Number(req.query.anio) || def.anio, Number(req.query.mes) || def.mes, req.query.anual === '1');
    if (!out) return res.status(404).json({ error: 'Empleado no encontrado' });
    res.json(out);
  } catch (e) { next(e); }
});

router.get('/f1357/:empleadoId', async (req, res, next) => {
  try {
    if (!gestiona(req.user.role)) return res.status(403).json({ error: 'No autorizado' });
    const def = hoy();
    const out = await f1357For(Number(req.params.empleadoId), Number(req.query.anio) || def.anio, Number(req.query.mes) || def.mes, req.query.anual === '1');
    if (!out) return res.status(404).json({ error: 'Empleado no encontrado' });
    res.json(out);
  } catch (e) { next(e); }
});

// ── Parámetros de Ganancias por período (RR.HH./admin) ──
router.get('/periodos', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try { const { rows } = await query('SELECT * FROM ganancias_periodos ORDER BY vigencia_desde ASC'); res.json(rows.map(mapGanRow)); }
  catch (e) { next(e); }
});

router.post('/periodos', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.periodo || !b.vigenciaDesde) return res.status(400).json({ error: 'Período y vigencia desde son obligatorios' });
    const ins = await query(
      `INSERT INTO ganancias_periodos (periodo, vigencia_desde, rg, mni_anual, ded_esp_anual, ded_esp2_anual, carga_conyuge_anual, carga_hijo_anual, carga_hijo_inc_anual, escala, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (periodo) DO UPDATE SET vigencia_desde=EXCLUDED.vigencia_desde, rg=EXCLUDED.rg, mni_anual=EXCLUDED.mni_anual,
         ded_esp_anual=EXCLUDED.ded_esp_anual, ded_esp2_anual=EXCLUDED.ded_esp2_anual, carga_conyuge_anual=EXCLUDED.carga_conyuge_anual,
         carga_hijo_anual=EXCLUDED.carga_hijo_anual, carga_hijo_inc_anual=EXCLUDED.carga_hijo_inc_anual, escala=EXCLUDED.escala, updated_by=EXCLUDED.updated_by, updated_at=now()
       RETURNING *`,
      [b.periodo, b.vigenciaDesde, b.rg || null, b.mniAnual || 0, b.dedEspAnual || 0, b.dedEsp2Anual || 0,
       b.cargaConyugeAnual || 0, b.cargaHijoAnual || 0, b.cargaHijoIncAnual || 0, JSON.stringify(b.escala || []), req.user.dni]
    );
    res.status(201).json(mapGanRow(ins.rows[0]));
  } catch (e) { next(e); }
});

router.put('/periodos/:id', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const r = await query(
      `UPDATE ganancias_periodos SET periodo=$1, vigencia_desde=$2, rg=$3, mni_anual=$4, ded_esp_anual=$5, ded_esp2_anual=$6,
         carga_conyuge_anual=$7, carga_hijo_anual=$8, carga_hijo_inc_anual=$9, escala=$10, updated_by=$11, updated_at=now()
       WHERE id=$12 RETURNING *`,
      [b.periodo, b.vigenciaDesde, b.rg || null, b.mniAnual || 0, b.dedEspAnual || 0, b.dedEsp2Anual || 0,
       b.cargaConyugeAnual || 0, b.cargaHijoAnual || 0, b.cargaHijoIncAnual || 0, JSON.stringify(b.escala || []), req.user.dni, req.params.id]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'Período no encontrado' });
    res.json(mapGanRow(r.rows[0]));
  } catch (e) { next(e); }
});

router.delete('/periodos/:id', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try { const r = await query('DELETE FROM ganancias_periodos WHERE id=$1 RETURNING id', [req.params.id]); if (!r.rowCount) return res.status(404).json({ error: 'No encontrado' }); res.json({ ok: true }); }
  catch (e) { next(e); }
});

export default router;
