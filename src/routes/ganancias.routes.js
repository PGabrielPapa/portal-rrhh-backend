import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { calcularRecibo, factorNoHabitual, TIPOS_SAC, TIPOS_NO_HABITUAL_B, calcularGananciasAcum } from '../lib/liquidacion.js';
import { ganTablaParaFecha, mapGanRow } from '../lib/gananciasParams.js';
import { calcularDeduccionesSiradig, cargasDesdeSiradig } from '../lib/siradigTopes.js';
import { requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

const gestiona = (role) => ['rrhh', 'admin'].includes(role);
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const hoy = () => { const d = new Date(); return { anio: d.getFullYear(), mes: d.getMonth() + 1 }; };

// Acumula remunerativo y aportes por categoría + retención, de enero a mes-1.
async function acumular(empleadoId, anio, mes) {
  const rows = (await query(
    `SELECT mes, tipo, data FROM recibos WHERE empleado_id=$1 AND anio=$2 AND mes < $3
       AND tipo IN ('mensual','quincenal_1','quincenal_2','vacaciones','complementaria','sac1','sac2')`,
    [empleadoId, Number(anio), Number(mes)])).rows;
  // Componentes RG 4003: A (habitual), B (no habituales, prorrateadas y totales),
  // C (SAC realmente percibido). jub/os/sind sólo de la parte habitual (para mostrar).
  const a = { habitual: 0, noHabPro: 0, noHabFull: 0, aporHabitual: 0, aporNoHabPro: 0,
    aporNoHabFull: 0, sacReal: 0, aporSacReal: 0, retenidoAcum: 0, jub: 0, os: 0, sind: 0 };
  for (const row of rows) {
    const data = row.data;
    const remun = Number(data?.totales?.totalRemun || 0);
    let aportes = 0, jub = 0, os = 0, sind = 0;
    for (const d of (data?.descuentos || [])) {
      const c = d.concepto || '';
      if (/Ganancias/i.test(c)) a.retenidoAcum += Number(d.monto || 0);
      else if (/Jubilación/i.test(c)) { jub += Number(d.monto || 0); aportes += Number(d.monto || 0); }
      else if (/Obra Social|ANSSAL|INSSJP/i.test(c)) { os += Number(d.monto || 0); aportes += Number(d.monto || 0); }
      else if (/Cuota sindical/i.test(c)) { sind += Number(d.monto || 0); aportes += Number(d.monto || 0); }
    }
    if (TIPOS_SAC.includes(row.tipo)) {
      a.sacReal += remun; a.aporSacReal += aportes;
    } else if (TIPOS_NO_HABITUAL_B.includes(row.tipo)) {
      const f = factorNoHabitual(row.mes, Number(mes));
      a.noHabPro += remun * f; a.noHabFull += remun; a.aporNoHabPro += aportes * f; a.aporNoHabFull += aportes;
    } else {
      a.habitual += remun; a.aporHabitual += aportes; a.jub += jub; a.os += os; a.sind += sind;
    }
  }
  // Carga inicial (saldos de apertura): acumulados del período fiscal previos al sistema u otro empleador.
  const ap = (await query('SELECT * FROM ganancias_apertura WHERE empleado_id=$1 AND anio=$2', [empleadoId, Number(anio)])).rows[0];
  if (ap) {
    a.habitual += Number(ap.gravado || 0);
    a.aporHabitual += Number(ap.aportes || 0);
    a.retenidoAcum += Number(ap.retenido || 0);
    a.sacReal += Number(ap.sac_gravado || 0);
    a.aporSacReal += Number(ap.sac_aportes || 0);
    a.jub += Number(ap.aportes || 0); // para que el total de deducciones generales mostrado incluya la apertura
  }
  return a;
}

// Agrega el detalle SiRADIG por concepto (sumando meses) para las vistas consolidadas.
function aggSiradig(f) {
  const det = f?.dedPersonales?.siradig?.detalle || [];
  const m = {};
  for (const d of det) { if (!d.clasificado || !d.computable) continue; const k = d.conceptoLabel || 'Otras deducciones'; m[k] = (m[k] || 0) + d.computable; }
  return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([label, computable]) => ({ label, computable: r2(computable) }));
}

async function f1357For(empleadoId, anio, mes, anualizada) {
  const er = await query(
    `SELECT e.*, em.nombre AS empresa_nombre FROM empleados e JOIN empresas em ON em.id = e.empresa_id WHERE e.id = $1`, [empleadoId]);
  if (!er.rows[0]) return null;
  const r = er.rows[0];
  const emp = { legNum: r.leg_num, nom: r.nom, empresa: r.empresa_nombre, cuil: r.cuil, cat: r.cat, ingreso: r.ingreso, bruto: Number(r.bruto), data: r.data || {} };
  const params = (await query('SELECT data FROM parametros_liq WHERE id = 1')).rows[0]?.data || {};
  // Cargas de familia: SOLO las declaradas por el empleado en el SiRADIG (F.572); NO se usa la tabla familiares.
  const sir = (await query('SELECT cargas_familia, deducciones FROM siradig_presentaciones WHERE empleado_id=$1 AND anio=$2', [empleadoId, Number(anio)])).rows[0] || null;
  const _cf = cargasDesdeSiradig(sir?.cargas_familia || [], Number(mes));
  const tieneConyuge = _cf.tieneConyuge;
  const nroHijosMenores = _cf.nHijos;
  const nroHijosIncapacitados = _cf.nHijosInc;

  const fechaRef = `${anio}-${String(mes).padStart(2, '0')}-15`;
  const ganTabla = await ganTablaParaFecha(fechaRef);
  const ac = await acumular(empleadoId, anio, mes);
  // Mes corriente: usa el recibo guardado si existe; si no, lo calcula al vuelo.
  const guardado = (await query(
    `SELECT data FROM recibos WHERE empleado_id=$1 AND anio=$2 AND mes=$3 AND tipo='mensual' LIMIT 1`,
    [empleadoId, Number(anio), Number(mes)])).rows[0]?.data;
  const rec = guardado || calcularRecibo(emp, params, {
    anio: Number(anio), mes: Number(mes), tipo: anualizada ? 'anual' : 'mensual',
    fechaPago: fechaRef, ganTabla, acumGanancias: ac,
    tieneConyuge, nroHijosMenores, nroHijosIncapacitados, gananciasAnualizada: anualizada,
  });
  // Aportes habituales del MES corriente (mensual).
  let curJub = 0, curOS = 0, curSind = 0;
  for (const d of (rec.descuentos || [])) {
    const c = d.concepto || '';
    if (/Jubilación/i.test(c)) curJub += Number(d.monto || 0);
    else if (/Obra Social|ANSSAL|INSSJP/i.test(c)) curOS += Number(d.monto || 0);
    else if (/Cuota sindical/i.test(c)) curSind += Number(d.monto || 0);
  }
  const curRemun = Number(rec.totales?.totalRemun || 0);
  const jub = r2(ac.jub + curJub), os = r2(ac.os + curOS), sind = r2(ac.sind + curSind);

  // F.1357 SIEMPRE recalculado con el núcleo RG 4003 (A + B + SAC 1/12).
  const comp = {
    habitual: Number(ac.habitual || 0) + curRemun,
    noHabPro: Number(ac.noHabPro || 0), noHabFull: Number(ac.noHabFull || 0),
    aporHabitual: Number(ac.aporHabitual || 0) + (curJub + curOS + curSind),
    aporNoHabPro: Number(ac.aporNoHabPro || 0), aporNoHabFull: Number(ac.aporNoHabFull || 0),
    sacReal: Number(ac.sacReal || 0), aporSacReal: Number(ac.aporSacReal || 0),
    retenidoAcum: Number(ac.retenidoAcum || 0),
    tieneConyuge, nroHijosMenores, nroHijosIncapacitados,
    ganTabla, mes: Number(mes), anualizada,
  };
  // SiRADIG: deducciones declaradas (ya traídas arriba), con topes RG 4003 sobre el acumulado fiscal.
  const gan0 = calcularGananciasAcum(comp); // base (sin SiRADIG) para el tope del 5% de ganancia neta
  let sirCalc = null;
  if (sir) {
    sirCalc = calcularDeduccionesSiradig({
      deducciones: sir.deducciones || [], mes: Number(mes), anualizada,
      gravadoTotal: gan0.gravadoTotal, aportesTotal: gan0.aportesAcum,
      topes: params.topesSiradig || null, mapaTipos: params.siradigTipos || null,
    });
    comp.dedSiradigAcum = sirCalc.totalComputable;
  }
  const gan = calcularGananciasAcum(comp);

  return {
    empleado: { legNum: emp.legNum, nom: emp.nom, empresa: emp.empresa, cuil: emp.cuil, cat: emp.cat },
    periodo: { anio: Number(anio), mes: Number(mes), periodoLabel: `${String(mes).padStart(2, '0')}/${anio}`, tablas: ganTabla?.periodo || '', anualizada: !!anualizada, mesesTranscurridos: gan.mesesTranscurridos },
    gravadas: { remBrutaNoHab: gan.gravadoBase, sac: gan.sacProvision, totalGravada: gan.gravadoTotal },
    dedGenerales: { jubilacion: jub, obraSocial: os, cuotaSindical: sind, sacDeduccion: gan.sacDeduccion, total: gan.aportesAcum },
    dedPersonales: {
      mni: gan.mni,
      cargasFamilia: { total: gan.cargasFamilia, tieneConyuge, nHijos: nroHijosMenores, nHijosInc: nroHijosIncapacitados },
      dedEspecial: gan.dedEspecial, dedEspecial2: gan.dedEspecial2, dedVoluntarias: gan.dedVoluntarias,
      dedSiradig: gan.dedSiradig,
      siradig: sirCalc ? { declarado: sirCalc.totalDeclarado, computable: sirCalc.totalComputable, sinClasificar: sirCalc.sinClasificar, gananciaNeta5: sirCalc.gananciaNeta, cap5: sirCalc.cap5, detalle: sirCalc.detalle } : null,
      total: r2(gan.mni + gan.cargasFamilia + gan.dedEspecial + gan.dedEspecial2 + gan.dedVoluntarias + gan.dedSiradig),
    },
    determinacion: {
      remSujeta: gan.remSujeta, impuestoDeterminado: gan.impuestoDeterminado,
      retenidoAnterior: gan.retenidoAnterior, impuestoARetener: r2(Math.max(0, gan.retencionPeriodo)), devolucion: r2(Math.max(0, -gan.retencionPeriodo)),
    },
    nota: 'RG 4003 (Anexo II): A) habitual; B) no habituales devengadas a diciembre; C) SAC = 1/12 mensual (reconcilia en la liquidación anual). Deducciones (art. 30) y escala (art. 94) vigentes del período.',
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
    await query(
      `INSERT INTO ganancias_periodos_hist (periodo_id, periodo, vigencia_desde, rg, mni_anual, ded_esp_anual, ded_esp2_anual, carga_conyuge_anual, carga_hijo_anual, carga_hijo_inc_anual, escala, updated_by, updated_at, snapshot_by)
       SELECT id, periodo, vigencia_desde, rg, mni_anual, ded_esp_anual, ded_esp2_anual, carga_conyuge_anual, carga_hijo_anual, carga_hijo_inc_anual, escala, updated_by, updated_at, $2 FROM ganancias_periodos WHERE periodo=$1`,
      [b.periodo, req.user.dni]
    );
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
    await query(
      `INSERT INTO ganancias_periodos_hist (periodo_id, periodo, vigencia_desde, rg, mni_anual, ded_esp_anual, ded_esp2_anual, carga_conyuge_anual, carga_hijo_anual, carga_hijo_inc_anual, escala, updated_by, updated_at, snapshot_by)
       SELECT id, periodo, vigencia_desde, rg, mni_anual, ded_esp_anual, ded_esp2_anual, carga_conyuge_anual, carga_hijo_anual, carga_hijo_inc_anual, escala, updated_by, updated_at, $2 FROM ganancias_periodos WHERE id=$1`,
      [req.params.id, req.user.dni]
    );
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

// GET /api/ganancias/periodos/:id/historial — versiones previas de los parámetros (para re-liquidar)
router.get('/periodos/:id/historial', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM ganancias_periodos_hist WHERE periodo_id=$1 ORDER BY snapshot_at DESC', [req.params.id]);
    res.json(rows.map((r) => ({
      id: r.periodo_id, histId: r.id, periodo: r.periodo, vigenciaDesde: r.vigencia_desde, rg: r.rg,
      mniAnual: Number(r.mni_anual), dedEspAnual: Number(r.ded_esp_anual), dedEsp2Anual: Number(r.ded_esp2_anual),
      cargaConyugeAnual: Number(r.carga_conyuge_anual), cargaHijoAnual: Number(r.carga_hijo_anual), cargaHijoIncAnual: Number(r.carga_hijo_inc_anual),
      escala: r.escala || [], updatedBy: r.updated_by, updatedAt: r.updated_at, snapshotBy: r.snapshot_by, snapshotAt: r.snapshot_at,
    })));
  } catch (e) { next(e); }
});

// Impuesto anual según escala progresiva (Art. 94).
function impuestoEscala(base, escala) {
  if (base <= 0 || !escala?.length) return 0;
  for (const t of escala) { const hasta = t.hasta == null ? Infinity : t.hasta; if (base > t.desde && base <= hasta) return t.fijo + (base - t.desde) * t.alicuota / 100; }
  const last = escala[escala.length - 1]; return last.fijo + (base - last.desde) * last.alicuota / 100;
}

// GET /api/ganancias/anual?anio=&empresa=  — liquidación anual del impuesto (ajuste a imputar en abril)
router.get('/anual', async (req, res, next) => {
  try {
    if (!gestiona(req.user.role)) return res.status(403).json({ error: 'No autorizado' });
    const anio = Number(req.query.anio) || new Date().getFullYear() - 1;
    const empresa = req.query.empresa;
    const ganTabla = await ganTablaParaFecha(`${anio}-12-31`);
    if (!ganTabla) return res.status(400).json({ error: 'No hay tabla de Ganancias para ese año' });

    const cond = ['r.anio = $1', `r.tipo IN ('mensual','quincenal_1','quincenal_2','sac1','sac2','vacaciones','complementaria','final')`], pr = [anio];
    if (empresa) { pr.push(empresa); cond.push(`em.nombre = $${pr.length}`); }
    const rows = (await query(
      `SELECT r.empleado_id, r.data, e.nom, e.leg_num, e.cuil, e.data AS edata, em.nombre AS empresa
         FROM recibos r JOIN empleados e ON e.id=r.empleado_id JOIN empresas em ON em.id=e.empresa_id
        WHERE ${cond.join(' AND ')}`, pr)).rows;
    // Agrupar por empleado
    const porEmp = {};
    for (const r of rows) {
      const t = r.data?.totales || {}, d = r.data?.descuentos || [];
      const e = porEmp[r.empleado_id] || (porEmp[r.empleado_id] = { nom: r.nom, legNum: r.leg_num, cuil: r.cuil, empresa: r.empresa, edata: r.edata || {}, remun: 0, aportes: 0, retenido: 0 });
      e.remun += Number(t.totalRemun || 0);
      for (const x of d) {
        if (/Ganancias/i.test(x.concepto)) e.retenido += Number(x.monto || 0);
        else if (/Jubilación|Obra Social|ANSSAL|INSSJP|Cuota sindical/i.test(x.concepto)) e.aportes += Number(x.monto || 0);
      }
    }
    // Familiares por empleado (cargas)
    const items = [];
    for (const [empId, e] of Object.entries(porEmp)) {
      const sircf = (await query('SELECT cargas_familia FROM siradig_presentaciones WHERE empleado_id=$1 AND anio=$2', [empId, Number(anio)])).rows[0];
      const cf = cargasDesdeSiradig(sircf?.cargas_familia || [], 12);
      const cargas = (cf.tieneConyuge ? Number(ganTabla.cargaConyugeAnual || 0) : 0)
        + cf.nHijos * Number(ganTabla.cargaHijoAnual || 0)
        + cf.nHijosInc * Number(ganTabla.cargaHijoIncAnual || 0);
      const remSujeta = Math.max(0, e.remun - e.aportes - Number(ganTabla.mniAnual || 0) - Number(ganTabla.dedEspAnual || 0) - Number(ganTabla.dedEsp2Anual || 0) - cargas);
      const impuestoDet = r2(impuestoEscala(remSujeta, ganTabla.escala));
      const diferencia = r2(impuestoDet - e.retenido);
      items.push({ empleadoId: Number(empId), nom: e.nom, legNum: e.legNum, cuil: e.cuil, empresa: e.empresa,
        remunAnual: r2(e.remun), aportesAnual: r2(e.aportes), cargas: r2(cargas), remSujeta: r2(remSujeta),
        impuestoDeterminado: impuestoDet, retenidoAnual: r2(e.retenido), diferencia,
        accion: diferencia > 0.5 ? 'retener' : diferencia < -0.5 ? 'devolver' : 'sin ajuste' });
    }
    items.sort((a, b) => a.empresa.localeCompare(b.empresa) || String(a.legNum).localeCompare(String(b.legNum)));
    const tot = items.reduce((a, x) => ({ retener: a.retener + Math.max(0, x.diferencia), devolver: a.devolver + Math.max(0, -x.diferencia) }), { retener: 0, devolver: 0 });
    res.json({ anio, tablaPeriodo: ganTabla.periodo || '', items, totales: { cant: items.length, aRetener: r2(tot.retener), aDevolver: r2(tot.devolver) } });
  } catch (e) { next(e); }
});

// GET /api/ganancias/verificacion?anio=&mes=  — chequeo previo a la liquidación:
// confirma que la tabla de Ganancias vigente corresponde al semestre del período
// (S1 ene-jun / S2 jul-dic) y devuelve los valores para que RR.HH. los controle.
router.get('/verificacion', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const d = hoy();
    const anio = Number(req.query.anio) || d.anio;
    const mes = Number(req.query.mes) || d.mes;
    const sem = mes <= 6 ? 1 : 2;
    const periodoEsperado = `${anio}-S${sem}`;
    const fechaRef = `${anio}-${String(mes).padStart(2, '0')}-15`;
    const g = await ganTablaParaFecha(fechaRef);
    const escala = Array.isArray(g && g.escala) ? g.escala : [];
    const semOk = !!g && String(g.periodo) === periodoEsperado;          // semestre correcto
    const dedOk = !!g && Number(g.mniAnual) > 0 && Number(g.dedEspAnual) > 0; // tabla de deducciones (art. 30)
    const escOk = escala.length >= 2 && escala.some((t) => Number(t.alicuota) > 0); // escala del impuesto (art. 94)
    const ok = semOk && dedOk && escOk;
    const ult = escala[escala.length - 1] || {};
    const faltan = [];
    if (!dedOk) faltan.push('deducciones (art. 30)');
    if (!escOk) faltan.push('escala del impuesto (art. 94)');
    const lbl = `${String(mes).padStart(2, '0')}/${anio}`;
    let mensaje;
    if (!g) mensaje = 'No hay tabla de Ganancias cargada. Cargá deducciones (art. 30) y escala (art. 94) antes de liquidar.';
    else if (!semOk) mensaje = `Atención: la tabla vigente (${g.periodo}) no corresponde al semestre del período (${periodoEsperado}). Actualizá deducciones y escala (RG 4003) antes de liquidar.`;
    else if (faltan.length) mensaje = `La tabla ${g.periodo} está incompleta: faltan ${faltan.join(' y ')}.`;
    else mensaje = `Deducciones (art. 30) y escala (art. 94) vigentes ${g.periodo} — correctas para el período ${lbl}.`;
    res.json({
      ok, semOk, dedOk, escOk,
      anio, mes, periodoEsperado,
      periodoVigente: g ? g.periodo : null,
      vigenciaDesde: g ? g.vigenciaDesde : null,
      rg: g ? g.rg : null,
      valores: g ? {
        mni: r2(g.mniAnual), dedEsp: r2(g.dedEspAnual), dedEsp2: r2(g.dedEsp2Anual),
        conyuge: r2(g.cargaConyugeAnual), hijo: r2(g.cargaHijoAnual), hijoInc: r2(g.cargaHijoIncAnual),
      } : null,
      escala: g ? {
        tramos: escala.length,
        primerTramoHasta: escala[0] ? escala[0].hasta : null,
        alicuotaMax: ult.alicuota != null ? ult.alicuota : null,
        fijoMax: ult.fijo != null ? r2(ult.fijo) : null,
        excedenteMax: ult.desde != null ? r2(ult.desde) : null,
      } : null,
      mensaje,
    });
  } catch (e) { next(e); }
});

// POST /api/ganancias/simular — simulador de Ganancias 4ª (RG 4003).
// modo: 'mensual' (retención de un mes) | 'anual' (proyección 12 meses + liq. anual) |
//       'final' (liquidación final por egreso). Caso hipotético; no liquida ni persiste.
router.post('/simular', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const modo = ['mensual', 'anual', 'final'].includes(b.modo) ? b.modo : 'anual';
    const anio = Number(b.anio) || hoy().anio;
    const remBruto = Number(b.remBruto) || 0;
    const tieneConyuge = !!b.tieneConyuge;
    const nroHijosMenores = Number(b.hijos) || 0;
    const nroHijosIncapacitados = Number(b.hijosInc) || 0;
    const noHabMonto = Number(b.noHabMonto) || 0;          // Apartado B (gratificación/ajuste)
    const noHabMes = Number(b.noHabMes) || 0;              // mes de pago (1-12); 0 = sin no habitual
    const dedVoluntariasAnual = Number(b.dedVoluntariasAnual) || 0;

    const params = (await query('SELECT data FROM parametros_liq WHERE id=1')).rows[0]?.data || {};
    const pctAportes = (Number(params.pctJubilacion) || 0) + (Number(params.pctObraSocial) || 0)
      + (Number(params.pctAnssal) || 0) + (Number(params.pctPamiEmp) || 0);
    const aporMes = remBruto * pctAportes / 100;
    const aporNoHab = noHabMonto * pctAportes / 100;

    // Construye el comp acumulado del mes m (remuneración constante) con SAC 1/12 y B prorrateado.
    async function compMes(m, retAcum) {
      const ganTabla = await ganTablaParaFecha(`${anio}-${String(m).padStart(2, '0')}-15`);
      const pagada = noHabMes && m >= noHabMes;
      const fB = pagada ? factorNoHabitual(noHabMes, m) : 0;
      return {
        habitual: remBruto * m,
        noHabPro: noHabMonto * fB, noHabFull: pagada ? noHabMonto : 0,
        aporHabitual: aporMes * m,
        aporNoHabPro: aporNoHab * fB, aporNoHabFull: pagada ? aporNoHab : 0,
        sacReal: 0, aporSacReal: 0, retenidoAcum: retAcum,
        tieneConyuge, nroHijosMenores, nroHijosIncapacitados, dedVoluntariasAnual,
        ganTabla, mes: m, anualizada: false,
      };
    }

    // ── Liquidación final (egreso) ──
    if (modo === 'final') {
      const ingreso = b.ingreso || `${anio - 3}-01-01`;
      const fechaEgreso = b.fechaEgreso || `${anio}-${String(hoy().mes).padStart(2, '0')}-28`;
      const mesEgreso = Number(String(fechaEgreso).slice(5, 7)) || hoy().mes;
      const ganTabla = await ganTablaParaFecha(`${anio}-12-15`);
      // Retención ya practicada en los meses previos al egreso (remuneración constante).
      let retPrev = 0;
      for (let m = 1; m < mesEgreso; m++) { const g = calcularGananciasAcum(await compMes(m, retPrev)); retPrev += g.retencionPeriodo; }
      const mPrev = Math.max(0, mesEgreso - 1);
      const acum = {
        habitual: remBruto * mPrev, noHabPro: 0, noHabFull: 0, aporHabitual: aporMes * mPrev,
        aporNoHabPro: 0, aporNoHabFull: 0, sacReal: 0, aporSacReal: 0, retenidoAcum: r2(retPrev),
      };
      const emp = { nom: '(simulación)', legNum: '—', empresa: '—', cuil: '', ingreso, bruto: remBruto, cat: 'FC', data: { basico: remBruto, cod_sindicato: 'FC' } };
      const rec = calcularRecibo(emp, params, {
        anio, mes: mesEgreso, tipo: 'final', fechaEgreso, motivoBaja: b.motivoBaja || 'sin_causa',
        mejorRem: remBruto, diasVacNoGozadas: Number(b.diasVacNoGozadas) || 0, ganTabla, acumGanancias: acum,
        tieneConyuge, nroHijosMenores, nroHijosIncapacitados,
      });
      return res.json({
        modo: 'final', anio, remBruto, fechaEgreso, ingreso, motivoBaja: b.motivoBaja || 'sin_causa',
        mesEgreso, retenidoPrevio: r2(retPrev), tablaPeriodo: ganTabla ? ganTabla.periodo : null,
        recibo: { haberes: rec.haberes, descuentos: rec.descuentos, totales: rec.totales, ganancias: rec.ganancias, detalle: rec.detalle },
      });
    }

    // ── Mensual / Anual ──
    const hasta = modo === 'mensual' ? Math.min(12, Math.max(1, Number(b.mes) || hoy().mes)) : 12;
    const meses = [];
    let retAcum = 0, detalleMes = null;
    for (let m = 1; m <= hasta; m++) {
      const comp = await compMes(m, retAcum);
      const g = calcularGananciasAcum(comp);
      meses.push({ mes: m, gravadoBase: g.gravadoBase, sacProvision: g.sacProvision, gravadoTotal: g.gravadoTotal,
        aportes: g.aportesAcum, deducciones: r2(g.mni + g.dedEspecial + g.dedEspecial2 + g.cargasFamilia),
        remSujeta: g.remSujeta, impuestoDeterminado: g.impuestoDeterminado, retencionMes: r2(g.retencionPeriodo) });
      if (modo === 'mensual' && m === hasta) {
        detalleMes = { mes: m, gravadoBase: g.gravadoBase, sacProvision: g.sacProvision, gravadoTotal: g.gravadoTotal,
          aportesBase: g.aportesBase, sacDeduccion: g.sacDeduccion, aportes: g.aportesAcum,
          mni: g.mni, dedEspecial: g.dedEspecial, dedEspecial2: g.dedEspecial2, cargasFamilia: g.cargasFamilia,
          remSujeta: g.remSujeta, impuestoDeterminado: g.impuestoDeterminado, retenidoAnterior: g.retenidoAnterior, retencionMes: r2(g.retencionPeriodo) };
      }
      retAcum += g.retencionPeriodo;
    }

    if (modo === 'mensual') {
      const tabla = await ganTablaParaFecha(`${anio}-${String(hasta).padStart(2, '0')}-15`);
      return res.json({ modo: 'mensual', anio, mes: hasta, remBruto, pctAportes, aporMes: r2(aporMes), tablaPeriodo: tabla ? tabla.periodo : null, detalle: detalleMes });
    }

    // Anual: liquidación anual (SAC real ≈ una remuneración; no habituales en su totalidad).
    const ganTablaDic = await ganTablaParaFecha(`${anio}-12-15`);
    const ga = calcularGananciasAcum({
      habitual: remBruto * 12, noHabPro: 0, noHabFull: noHabMonto, aporHabitual: aporMes * 12,
      aporNoHabPro: 0, aporNoHabFull: aporNoHab, sacReal: remBruto, aporSacReal: aporMes,
      retenidoAcum: retAcum, tieneConyuge, nroHijosMenores, nroHijosIncapacitados, dedVoluntariasAnual,
      ganTabla: ganTablaDic, mes: 12, anualizada: true,
    });
    res.json({
      modo: 'anual', anio, remBruto, pctAportes, aporMes: r2(aporMes), tablaPeriodo: ganTablaDic ? ganTablaDic.periodo : null,
      meses, totalRetenidoMensual: r2(retAcum),
      anual: { gravadoTotal: ga.gravadoTotal, impuestoDeterminado: ga.impuestoDeterminado,
        retenidoEnElAnio: r2(retAcum), ajusteFinal: ga.retencionPeriodo, sacReal: remBruto },
    });
  } catch (e) { next(e); }
});

// ── Liquidación FINAL ANUAL de Ganancias (RG 4003): impuesto anual vs. retenido => ajuste a imputar ──
router.get('/final-anual', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const anio = Number(req.query.anio) || hoy().anio;
    const empresaId = req.query.empresaId ? Number(req.query.empresaId) : null;
    const cond = ['e.activo = true']; const args = [];
    if (empresaId) { args.push(empresaId); cond.push(`e.empresa_id = $${args.length}`); }
    const emps = (await query(`SELECT e.id FROM empleados e WHERE ${cond.join(' AND ')} ORDER BY e.nom`, args)).rows;
    const filas = [];
    for (const e of emps) {
      const f = await f1357For(e.id, anio, 12, true); // anualizada
      if (!f) continue;
      const impuesto = f.determinacion.impuestoDeterminado;
      const retenido = f.determinacion.retenidoAnterior;
      const aRetener = f.determinacion.impuestoARetener;   // saldo a favor del fisco
      const aDevolver = f.determinacion.devolucion;        // saldo a favor del empleado
      if (impuesto === 0 && retenido === 0) continue;       // no alcanzado, no listar
      filas.push({ empleadoId: e.id, legNum: f.empleado.legNum, nom: f.empleado.nom, empresa: f.empleado.empresa, cuil: f.empleado.cuil,
        gravado: f.gravadas.totalGravada, dedGenerales: f.dedGenerales.total, dedPersonales: f.dedPersonales.total, dedSiradig: f.dedPersonales.dedSiradig || 0, siradigDetalle: aggSiradig(f),
        impuesto, retenido, aRetener, aDevolver, siradigSinClasificar: f.dedPersonales.siradig?.sinClasificar || 0 });
    }
    const tot = filas.reduce((a, r) => ({ impuesto: a.impuesto + r.impuesto, retenido: a.retenido + r.retenido, aRetener: a.aRetener + r.aRetener, aDevolver: a.aDevolver + r.aDevolver }), { impuesto: 0, retenido: 0, aRetener: 0, aDevolver: 0 });
    res.json({ anio, filas, totales: Object.fromEntries(Object.entries(tot).map(([k, v]) => [k, r2(v)])) });
  } catch (e) { next(e); }
});

// ── Informe de control de Ganancias (consolidado por empleado, estilo Tango "informe de control") ──
router.get('/control', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const def = hoy();
    const anio = Number(req.query.anio) || def.anio, mes = Number(req.query.mes) || def.mes;
    const anual = req.query.anual === '1';
    const empresaId = req.query.empresaId ? Number(req.query.empresaId) : null;
    const cond = ['e.activo = true']; const args = [];
    if (empresaId) { args.push(empresaId); cond.push(`e.empresa_id = $${args.length}`); }
    const emps = (await query(`SELECT e.id FROM empleados e WHERE ${cond.join(' AND ')} ORDER BY e.nom`, args)).rows;
    const filas = [];
    for (const e of emps) {
      const f = await f1357For(e.id, anio, mes, anual);
      if (!f) continue;
      filas.push({
        empleadoId: e.id, legNum: f.empleado.legNum, nom: f.empleado.nom, empresa: f.empleado.empresa, cuil: f.empleado.cuil,
        gravado: f.gravadas.totalGravada, dedGenerales: f.dedGenerales.total, dedPersonales: f.dedPersonales.total,
        dedSiradig: f.dedPersonales.dedSiradig || 0, siradigSinClasificar: f.dedPersonales.siradig?.sinClasificar || 0, siradigDetalle: aggSiradig(f),
        remSujeta: f.determinacion.remSujeta, impuesto: f.determinacion.impuestoDeterminado,
        retenidoAnterior: f.determinacion.retenidoAnterior, aRetener: f.determinacion.impuestoARetener, devolucion: f.determinacion.devolucion,
      });
    }
    const tot = filas.reduce((a, r) => ({
      gravado: a.gravado + r.gravado, dedGenerales: a.dedGenerales + r.dedGenerales, dedPersonales: a.dedPersonales + r.dedPersonales,
      dedSiradig: a.dedSiradig + r.dedSiradig, impuesto: a.impuesto + r.impuesto, aRetener: a.aRetener + r.aRetener, devolucion: a.devolucion + r.devolucion,
    }), { gravado: 0, dedGenerales: 0, dedPersonales: 0, dedSiradig: 0, impuesto: 0, aRetener: 0, devolucion: 0 });
    res.json({ periodo: { anio, mes, anual }, filas, totales: Object.fromEntries(Object.entries(tot).map(([k, v]) => [k, r2(v)])) });
  } catch (e) { next(e); }
});

// ── Carga inicial de acumulados de Ganancias (ABM) ──
router.get('/apertura', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const anio = Number(req.query.anio) || hoy().anio;
    const { rows } = await query(
      `SELECT a.*, e.nom AS empleado_nom, e.leg_num FROM ganancias_apertura a
         JOIN empleados e ON e.id=a.empleado_id WHERE a.anio=$1 ORDER BY e.nom`, [anio]);
    res.json(rows.map((r) => ({ id: r.id, empleadoId: r.empleado_id, empleadoNom: r.empleado_nom, legNum: r.leg_num,
      anio: r.anio, hastaMes: r.hasta_mes, gravado: Number(r.gravado), aportes: Number(r.aportes), retenido: Number(r.retenido),
      sacGravado: Number(r.sac_gravado), sacAportes: Number(r.sac_aportes), origen: r.origen, obs: r.obs, updatedBy: r.updated_by, updatedAt: r.updated_at })));
  } catch (e) { next(e); }
});

router.get('/apertura/:empleadoId', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const anio = Number(req.query.anio) || hoy().anio;
    const r = (await query('SELECT * FROM ganancias_apertura WHERE empleado_id=$1 AND anio=$2', [req.params.empleadoId, anio])).rows[0];
    if (!r) return res.json(null);
    res.json({ id: r.id, empleadoId: r.empleado_id, anio: r.anio, hastaMes: r.hasta_mes, gravado: Number(r.gravado), aportes: Number(r.aportes), retenido: Number(r.retenido), sacGravado: Number(r.sac_gravado), sacAportes: Number(r.sac_aportes), origen: r.origen, obs: r.obs });
  } catch (e) { next(e); }
});

router.put('/apertura/:empleadoId', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const anio = Number(b.anio) || hoy().anio;
    const who = req.user?.email || String(req.user?.id || '');
    const r = await query(
      `INSERT INTO ganancias_apertura (empleado_id, anio, hasta_mes, gravado, aportes, retenido, sac_gravado, sac_aportes, origen, obs, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (empleado_id, anio) DO UPDATE SET hasta_mes=EXCLUDED.hasta_mes, gravado=EXCLUDED.gravado, aportes=EXCLUDED.aportes,
         retenido=EXCLUDED.retenido, sac_gravado=EXCLUDED.sac_gravado, sac_aportes=EXCLUDED.sac_aportes, origen=EXCLUDED.origen, obs=EXCLUDED.obs, updated_by=EXCLUDED.updated_by, updated_at=now()
       RETURNING id`,
      [req.params.empleadoId, anio, Number(b.hastaMes) || 0, r2(b.gravado), r2(b.aportes), r2(b.retenido), r2(b.sacGravado), r2(b.sacAportes), b.origen || 'CARGA_INICIAL', b.obs || null, who]);
    res.json({ ok: true, id: r.rows[0].id });
  } catch (e) { next(e); }
});

router.delete('/apertura/:empleadoId', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try { await query('DELETE FROM ganancias_apertura WHERE empleado_id=$1 AND anio=$2', [req.params.empleadoId, Number(req.query.anio) || hoy().anio]); res.json({ ok: true }); }
  catch (e) { next(e); }
});

export default router;
