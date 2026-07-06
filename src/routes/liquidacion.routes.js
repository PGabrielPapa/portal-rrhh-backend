import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { calcularRecibo, factorNoHabitual, TIPOS_SAC, TIPOS_NO_HABITUAL_B } from '../lib/liquidacion.js';
import { ganTablaParaFecha } from '../lib/gananciasParams.js';
import { periodoCerrado } from './cierres.routes.js';
import { idsEquipoDe } from '../lib/equipo.js';

import { embargosOpts } from './embargos.routes.js';
import { novedadesOpts } from './novedades.routes.js';
import { esSinGoce } from '../lib/licenciasReglas.js';
import { valoresLegalesVigentes, verificarValoresLegales, autoActualizarValores } from './valoresLegales.routes.js';
import { paramsParaFecha } from './parametros.routes.js';
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
    `SELECT mes, tipo, data FROM recibos WHERE empleado_id=$1 AND anio=$2 AND mes < $3
       AND tipo IN ('mensual','quincenal_1','quincenal_2','vacaciones','complementaria','sac1','sac2')`,
    [empleadoId, Number(anio), Number(mes)])).rows;
  // Componentes RG 4003 (Anexo II): A habitual, B no habituales, C SAC real.
  const a = { habitual: 0, noHabPro: 0, noHabFull: 0, aporHabitual: 0, aporNoHabPro: 0,
    aporNoHabFull: 0, sacReal: 0, aporSacReal: 0, retenidoAcum: 0 };
  for (const row of rows) {
    const data = row.data;
    const remun = Number(data?.totales?.totalRemun || 0);
    let aportes = 0;
    for (const d of (data?.descuentos || [])) {
      if (/Ganancias/i.test(d.concepto)) a.retenidoAcum += Number(d.monto || 0);
      else if (/Jubilación|Obra Social|ANSSAL|INSSJP|Cuota sindical/i.test(d.concepto)) aportes += Number(d.monto || 0);
    }
    if (TIPOS_SAC.includes(row.tipo)) { a.sacReal += remun; a.aporSacReal += aportes; }
    else if (TIPOS_NO_HABITUAL_B.includes(row.tipo)) {
      const f = factorNoHabitual(row.mes, Number(mes));
      a.noHabPro += remun * f; a.noHabFull += remun; a.aporNoHabPro += aportes * f; a.aporNoHabFull += aportes;
    } else { a.habitual += remun; a.aporHabitual += aportes; }
  }
  for (const k of Object.keys(a)) a[k] = r2(a[k]);
  return a;
}

// Mapa de pres_base por código de sindicato (para la base del presentismo, como la vanilla).
async function presBaseMap() {
  try { const { rows } = await query('SELECT codigo, pres_base FROM sindicatos'); const m = {}; for (const r of rows) m[String(r.codigo).toUpperCase()] = r.pres_base; return m; }
  catch { return {}; }
}
const presBaseDe = (m, emp) => m[String(emp?.data?.cod_sindicato || '').toUpperCase()] || 'basico';
async function sindMap() {
  try { const { rows } = await query('SELECT codigo, pres_base, pct_presentismo, pct_antig_por_anio, titulo_secundario, titulo_universitario FROM sindicatos'); const m = {}; for (const r of rows) m[String(r.codigo).toUpperCase()] = { presBase: r.pres_base, pctPresentismo: Number(r.pct_presentismo) || 0, pctAntigPorAnio: Number(r.pct_antig_por_anio) || 0, tituloSecundario: Number(r.titulo_secundario) || 0, tituloUniversitario: Number(r.titulo_universitario) || 0 }; return m; } catch { return {}; }
}
const sindDe = (m, emp) => m[String(emp?.data?.cod_sindicato || '').toUpperCase()] || null;

// Mapa de convenios → tablas de la versión vigente (para el básico por categoría de CCT).
async function convMap() {
  try {
    const { rows } = await query('SELECT DISTINCT ON (codigo) codigo, data FROM convenio_versiones WHERE vigencia <= CURRENT_DATE ORDER BY codigo, vigencia DESC, created_at DESC');
    const m = {}; for (const r of rows) m[String(r.codigo).toUpperCase()] = (r.data && r.data.tablas) || []; return m;
  } catch { return {}; }
}
// Básico del convenio según la categoría elegida (valor 'titulo||cat'). 0 si no aplica.
function convBasicoDe(m, emp) {
  const code = String(emp?.data?.cod_convenio || '').toUpperCase();
  const sel = String(emp?.data?.categoria_convenio || '');
  if (!code || !sel || !m[code]) return 0;
  const [titulo, cat] = sel.split('||');
  for (const t of m[code]) { if (String(t.titulo) === titulo) { for (const c of (t.cats || [])) { if (String(c.cat) === cat) return Number(c.basico) || 0; } } }
  return 0;
}

async function getEmp(id) {
  const er = await query(`SELECT e.*, em.nombre AS empresa_nombre, em.cuit AS empresa_cuit, em.data AS empresa_data FROM empleados e JOIN empresas em ON em.id=e.empresa_id WHERE e.id=$1`, [id]);
  if (!er.rows[0]) return null;
  const r = er.rows[0];
  return { id: r.id, legNum: r.leg_num, nom: r.nom, empresa: r.empresa_nombre, empresaCuit: r.empresa_cuit || null, empresaData: r.empresa_data || {}, cuil: r.cuil, cat: r.cat, ingreso: r.ingreso, bruto: Number(r.bruto), data: r.data || {} };
}
async function getParams() { const pr = await query('SELECT data FROM parametros_liq WHERE id = 1'); return pr.rows[0]?.data || {}; }
// Antes de cada cálculo se superponen los VALORES LEGALES vigentes del período (tope SIPA, SMVM, SCVO, FFEP).
async function getParamsConValores(anio, mes) {
  const params = { ...(await paramsParaFecha(`${anio}-${String(mes).padStart(2, '0')}-15`)) };
  const v = await valoresLegalesVigentes(`${anio}-${String(mes).padStart(2, '0')}-15`);
  if (v) {
    if (v.topeSipaMax > 0) params.topeAportesMax = v.topeSipaMax;
    if (v.topeSipaMin > 0) params.topeAportesMin = v.topeSipaMin;
    if (v.smvm > 0) { params.smvmMensual = v.smvm; params.smvm = v.smvm; }
    if (v.scvoPercapita > 0) params.scvoPercapita = v.scvoPercapita;
    if (v.ffep > 0) params.ffep = v.ffep;
  }
  return params;
}

// ── Ajuste por neto negativo: helpers de persistencia (se recupera el mes siguiente) ──
const _esMensual = (t) => t === 'mensual' || t === 'quincenal_1' || t === 'quincenal_2';
const _esSAC = (t) => t === 'sac1' || t === 'sac2';
// Mejor remuneración mensual del semestre (para el SAC), tomada de los recibos guardados.
async function mejorRemSemestre(empleadoId, anio, tipoSAC) {
  const desde = tipoSAC === 'sac2' ? 7 : 1, hasta = tipoSAC === 'sac2' ? 12 : 6;
  const r = await query("SELECT data FROM recibos WHERE empleado_id=$1 AND anio=$2 AND mes BETWEEN $3 AND $4 AND tipo IN ('mensual','quincenal_1','quincenal_2')", [empleadoId, Number(anio), desde, hasta]);
  let max = 0;
  for (const x of r.rows) { const v = Number(x.data?.totales?.totalRemun || 0); if (v > max) max = v; }
  return max;
}
async function ajustePendiente(empleadoId, anio, mes) {
  const r = await query('SELECT COALESCE(SUM(monto),0) AS m FROM ajustes_neto WHERE empleado_id=$1 AND recuperado=false AND (anio*100+mes) < ($2*100+$3)', [empleadoId, Number(anio), Number(mes)]);
  return Number(r.rows[0].m) || 0;
}
// Días de licencia SIN goce de haberes (aprobadas) que caen dentro del mes → descuento en la liquidación.
async function licenciasSinGoceOpts(empleadoId, anio, mes) {
  try {
    const { rows } = await query(
      `SELECT desde, hasta, tipo FROM licencias
        WHERE empleado_id=$1 AND estado='aprobada'
          AND EXTRACT(YEAR FROM desde) <= $2 AND EXTRACT(YEAR FROM hasta) >= $2`, [empleadoId, Number(anio)]);
    const mStart = new Date(Number(anio), Number(mes) - 1, 1);
    const mEnd = new Date(Number(anio), Number(mes), 0);
    const diasEnMes = (r) => { const d = new Date(r.desde), h = new Date(r.hasta); const a = d > mStart ? d : mStart; const b = h < mEnd ? h : mEnd; return b >= a ? Math.floor((b - a) / 86400000) + 1 : 0; };
    let sinGoce = 0, enfermedad = 0;
    for (const r of rows) {
      const tl = String(r.tipo || '').toLowerCase();
      if (esSinGoce(r.tipo)) sinGoce += diasEnMes(r);
      else if (tl.startsWith('enfermedad') && !tl.includes('familiar')) enfermedad += diasEnMes(r); // enfermedad propia (art. 208)
    }
    const out = {};
    if (sinGoce > 0) out.diasLicenciaSinGoce = sinGoce;
    if (enfermedad > 0) out.diasEnfermedad = enfermedad;
    return out;
  } catch { return {}; }
}

// Promedio mensual de remuneraciones variables del último semestre (art. 155 inc. c y art. 208 LCT).
const RE_VARIABLE = /hora.?extra|complemento variable|feriado|comisi|premio|productividad|destajo|incentivo/i;
async function promedioVariablesMes(empleadoId, anio, mes) {
  try {
    const ini = Number(anio) * 12 + Number(mes) - 6;   // 6 meses hacia atrás
    const fin = Number(anio) * 12 + Number(mes);        // exclusivo: el mes en curso no promedia
    const { rows } = await query(
      `SELECT anio, mes, data FROM recibos
        WHERE empleado_id=$1 AND tipo IN ('mensual','quincenal_1','quincenal_2')
          AND (anio * 12 + mes) >= $2 AND (anio * 12 + mes) < $3`, [empleadoId, ini, fin]);
    if (!rows.length) return {};
    const porMes = {};
    for (const r of rows) {
      const hs = (r.data && r.data.haberes) || [];
      let v = 0; for (const h of hs) if (RE_VARIABLE.test(String(h.concepto || ''))) v += Number(h.monto) || 0;
      const k = r.anio * 12 + r.mes; porMes[k] = (porMes[k] || 0) + v;
    }
    const meses = Object.keys(porMes).length;
    if (!meses) return {};
    const prom = Object.values(porMes).reduce((a, b) => a + b, 0) / meses;
    return prom > 0 ? { promedioVariablesMes: Math.round(prom * 100) / 100 } : {};
  } catch { return {}; }
}
async function resetAjusteNeto(empleadoId, anio, mes) { // idempotencia al re-liquidar el período
  await query('UPDATE ajustes_neto SET recuperado=false, recuperado_anio=NULL, recuperado_mes=NULL WHERE empleado_id=$1 AND recuperado_anio=$2 AND recuperado_mes=$3', [empleadoId, Number(anio), Number(mes)]);
  await query('DELETE FROM ajustes_neto WHERE empleado_id=$1 AND anio=$2 AND mes=$3', [empleadoId, Number(anio), Number(mes)]);
}
async function commitAjusteNeto(empleadoId, anio, mes, recibo) {
  const rec = Number(recibo?.detalle?.ajusteNetoRecuperado) || 0;
  if (rec > 0) await query('UPDATE ajustes_neto SET recuperado=true, recuperado_anio=$2, recuperado_mes=$3 WHERE empleado_id=$1 AND recuperado=false AND (anio*100+mes) < ($2*100+$3)', [empleadoId, Number(anio), Number(mes)]);
  const gen = Number(recibo?.detalle?.ajusteNetoNegativo) || 0;
  if (gen > 0) await query('INSERT INTO ajustes_neto (empleado_id, anio, mes, monto) VALUES ($1,$2,$3,$4)', [empleadoId, Number(anio), Number(mes), gen]);
}

const round2c = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const aniosAntig = (ing, anio, mes) => { if (!ing) return 0; const d = new Date(ing); const ref = new Date(anio, mes - 1, 1); let a = ref.getFullYear() - d.getFullYear(); if (ref.getMonth() < d.getMonth()) a--; return Math.max(0, a); };

// GET /api/liquidacion/costo-equipo — costo laboral de los empleados a cargo (organigrama).
// Calcula una liquidación MENSUAL del período pedido (o el actual) para cada integrante.
router.get('/costo-equipo', requireRole('manager', 'rrhh', 'admin'), async (req, res, next) => {
  try {
    const set = await idsEquipoDe(req.user.id);
    set.add(req.user.id);   // el gerente del área también es parte del costo laboral de su equipo
    const ids = [...set];
    const now = new Date();
    const anio = Number(req.query.anio) || now.getFullYear();
    const mes = Number(req.query.mes) || (now.getMonth() + 1);
    if (!ids.length) return res.json({ periodo: { anio, mes }, items: [], totales: { cant: 0, remun: 0, contrib: 0, costo: 0, neto: 0 } });
    const params = await getParams();
    const num = (x) => Number(x) || 0;
    // Escala unificada vigente: básico por categoría + tramo.
    const escRow = (await query('SELECT data FROM escala_versiones ORDER BY vigencia DESC, created_at DESC LIMIT 1')).rows[0];
    const categorias = escRow?.data?.categorias || [];
    const basicoEscala = (cat, tramo) => {
      const c = categorias.find((x) => String(x.cat).toUpperCase() === String(cat || '').toUpperCase());
      const v = c && c.tramos ? c.tramos[tramo] : undefined;
      return num(v);
    };
    // % de contribuciones patronales (sobre la remuneración) + SCVO per cápita fijo.
    const pctContrib = (num(params.pctJubPatronal) + num(params.pctOsPatronal) + num(params.pctPamiPatronal) + num(params.pctDesempleo) + num(params.pctArt) + num(params.pctSindicatoPatronal)) / 100;
    const scvo = num(params.scvoPercapita);
    const pctAntig = num(params.pctAntiguedadPorAnio);
    const esFC = (emp) => { const cs = String(emp.data?.cod_sindicato || '').toUpperCase(); return !cs || cs === 'FC'; };

    const { rows } = await query(
      `SELECT e.id, e.leg_num, e.nom, e.cuil, e.cat, e.tramo, e.ingreso, e.bruto, e.data, em.nombre AS empresa
         FROM empleados e JOIN empresas em ON em.id=e.empresa_id
        WHERE e.id = ANY($1) AND e.activo=true ORDER BY em.nombre, e.nom`, [ids]);
    const items = []; let tBasico = 0, tAntig = 0, tRem = 0, tContrib = 0, tCosto = 0;
    for (const r of rows) {
      const emp = { id: r.id, cat: r.cat, tramo: r.tramo, data: r.data || {} };
      const anios = aniosAntig(r.ingreso, anio, mes);
      // Básico de la escala unificada (si no está la categoría/tramo, cae al básico cargado del empleado).
      let basico = basicoEscala(r.cat, r.tramo);
      if (!basico) basico = num(r.data?.basico) || num(r.data?.sueldo) || 0;
      const antiguedad = esFC(emp) ? 0 : basico * anios * pctAntig / 100;
      const remun = basico + antiguedad;                 // básico escala + adicional antigüedad
      const contrib = remun * pctContrib + scvo;          // contribuciones patronales sobre esa suma
      const costo = remun + contrib;
      tBasico += basico; tAntig += antiguedad; tRem += remun; tContrib += contrib; tCosto += costo;
      const nom = String(r.nom || '');
      const apellido = nom.split(',')[0]?.trim() || nom;
      const nombre = nom.split(',')[1]?.trim() || '';
      items.push({ id: r.id, legNum: r.leg_num, apellido, nombre, empresa: r.empresa,
        tarea: r.data?.tarea || r.data?.desc_categoria || [r.cat, r.tramo].filter(Boolean).join(' '),
        ingreso: r.ingreso, antiguedad: anios,
        basico: round2c(basico), adicAntiguedad: round2c(antiguedad),
        remun: round2c(remun), contrib: round2c(contrib), costo: round2c(costo) });
    }
    res.json({ periodo: { anio, mes }, items, totales: { cant: items.length, basico: round2c(tBasico), adicAntiguedad: round2c(tAntig), remun: round2c(tRem), contrib: round2c(tContrib), costo: round2c(tCosto) } });
  } catch (e) { next(e); }
});

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
    const sind = sindDe(await sindMap(), emp); const presBase = sind?.presBase || 'basico';
    const convBasico = convBasicoDe(await convMap(), emp);
    const emb = (t === 'mensual' || t === 'quincenal_1' || t === 'quincenal_2') ? await embargosOpts(empleadoId, extra.fechaPago) : {};
    const nov = _esMensual(t) ? { ...await novedadesOpts(empleadoId, anio, mes), ...await licenciasSinGoceOpts(empleadoId, anio, mes) } : {};
    const varProm = (t === 'vacaciones' || _esMensual(t)) ? await promedioVariablesMes(empleadoId, anio, mes) : {};
    const sacBase = _esSAC(t) ? await mejorRemSemestre(empleadoId, anio, t) : 0;
    const ajPend = _esMensual(t) ? await ajustePendiente(empleadoId, anio, mes) : 0;
    res.json(calcularRecibo(emp, await getParamsConValores(anio, mes), { anio: Number(anio), mes: Number(mes), tipo: t, cuotasAnticipos: cuotas, acumGanancias: acumGan, ganTabla, presBase, sind, convBasico, ajusteNetoRecuperar: ajPend, mejorRemSAC: sacBase, ...nov, ...varProm, ...emb, ...extra }));
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
    const sind = sindDe(await sindMap(), emp); const presBase = sind?.presBase || 'basico';
    const convBasico = convBasicoDe(await convMap(), emp);
    const emb = (tipo === 'mensual' || tipo === 'quincenal_1' || tipo === 'quincenal_2') ? await embargosOpts(empleadoId, extra.fechaPago) : {};
    const nov = _esMensual(tipo) ? { ...await novedadesOpts(empleadoId, anio, mes), ...await licenciasSinGoceOpts(empleadoId, anio, mes) } : {};
    const varProm = (tipo === 'vacaciones' || _esMensual(tipo)) ? await promedioVariablesMes(empleadoId, anio, mes) : {};
    const sacBase = _esSAC(tipo) ? await mejorRemSemestre(empleadoId, anio, tipo) : 0;
    let ajPend = 0;
    if (_esMensual(tipo)) { await resetAjusteNeto(empleadoId, anio, mes); ajPend = await ajustePendiente(empleadoId, anio, mes); }
    const recibo = calcularRecibo(emp, await getParamsConValores(anio, mes), { anio: Number(anio), mes: Number(mes), tipo, cuotasAnticipos: cuotas, acumGanancias: acumGan, ganTabla, presBase, sind, convBasico, ajusteNetoRecuperar: ajPend, mejorRemSAC: sacBase, ...nov, ...varProm, ...emb, ...extra });
    const ins = await query(
      `INSERT INTO recibos (empleado_id, anio, mes, tipo, neto, data, created_by, publicado)
       VALUES ($1,$2,$3,$4,$5,$6,$7,true)
       ON CONFLICT (empleado_id, anio, mes, tipo)
       DO UPDATE SET neto=EXCLUDED.neto, data=EXCLUDED.data, created_by=EXCLUDED.created_by, publicado=true, created_at=now()
       RETURNING id`,
      [empleadoId, Number(anio), Number(mes), tipo, recibo.totales.neto, JSON.stringify(recibo), req.user.dni]
    );
    await registrarCuotas(cuotas, anio, mes, ins.rows[0].id, null);
    if (_esMensual(tipo)) await commitAjusteNeto(empleadoId, anio, mes, recibo);
    res.json({ ok: true, id: ins.rows[0].id, recibo });
  } catch (e) { next(e); }
});

// ════════════ CONTROLES PRE-CIERRE ════════════
// Verifica la corrida de un período: netos negativos, aportes ≠ 17%, sueldos sobre tope SIPA,
// variaciones bruscas vs. mes anterior y empleados activos sin recibo.
router.get('/controles', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const d = new Date();
    const anio = Number(req.query.anio) || d.getFullYear();
    const mes = Number(req.query.mes) || (d.getMonth() + 1);
    const tipos = ['mensual', 'quincenal_1', 'quincenal_2'];
    const empresa = req.query.empresa || null;
    const umbral = req.query.umbral != null ? Number(req.query.umbral) : 30; // % variación neto

    const params = await getParams();
    const vl = await valoresLegalesVigentes(`${anio}-${String(mes).padStart(2, '0')}-15`);
    const topeMax = (vl && vl.topeSipaMax > 0) ? vl.topeSipaMax : (Number(params.topeAportesMax) || Infinity);
    const baseMin = (vl && vl.topeSipaMin > 0) ? vl.topeSipaMin : (Number(params.topeAportesMin) || 0);
    const pctEsperado = (Number(params.pctJubilacion) || 0) + (Number(params.pctObraSocial) || 0) + (Number(params.pctAnssal) || 0) + (Number(params.pctPamiEmp) || 0);

    const cond = ['r.anio=$1', 'r.mes=$2', `r.tipo = ANY($3)`]; const args = [anio, mes, tipos];
    if (empresa) { args.push(empresa); cond.push(`em.nombre = $${args.length}`); }
    const recs = (await query(
      `SELECT r.empleado_id, r.tipo, r.neto, r.data, e.nom, e.leg_num, em.nombre AS empresa
         FROM recibos r JOIN empleados e ON e.id=r.empleado_id JOIN empresas em ON em.id=e.empresa_id
        WHERE ${cond.join(' AND ')}`, args)).rows;

    // Neto del mes anterior por empleado (para variación)
    const pm = mes === 1 ? 12 : mes - 1, pa = mes === 1 ? anio - 1 : anio;
    const prevRows = (await query(`SELECT empleado_id, SUM(neto) AS neto FROM recibos WHERE anio=$1 AND mes=$2 AND tipo = ANY($3) GROUP BY empleado_id`, [pa, pm, tipos])).rows;
    const prevNeto = new Map(prevRows.map((x) => [x.empleado_id, Number(x.neto)]));

    const issues = [];
    const add = (sev, empleadoId, nom, leg, tipo, detalle) => issues.push({ severidad: sev, empleadoId, nom, legNum: leg, tipo, detalle });
    const conRecibo = new Set();
    for (const r of recs) {
      conRecibo.add(r.empleado_id);
      const data = r.data || {};
      const remun = Number(data.totales?.totalRemun || 0);
      const neto = Number(r.neto || 0);
      if (neto < 0) add('error', r.empleado_id, r.nom, r.leg_num, 'Neto', `Neto negativo ($${neto.toFixed(2)}) — debería estar pisado en cero`);
      const ajGen = Number(data.detalle?.ajusteNetoNegativo || 0);
      if (ajGen > 0) add('info', r.empleado_id, r.nom, r.leg_num, 'Neto cero', `Neto llevado a cero con ajuste no remunerativo de $${ajGen.toFixed(2)} (se recupera el mes siguiente)`);
      const ajRec = Number(data.detalle?.ajusteNetoRecuperado || 0);
      if (ajRec > 0) add('info', r.empleado_id, r.nom, r.leg_num, 'Recupero', `Recupero de ajuste de período anterior: $${ajRec.toFixed(2)}`);
      // Aportes personales vs % esperado
      const aportes = (data.descuentos || []).filter((x) => /Jubilaci|Obra Social|ANSSAL|INSSJP/i.test(x.concepto)).reduce((a, x) => a + Number(x.monto || 0), 0);
      const base = Math.min(remun, topeMax);
      if (base > 0 && pctEsperado > 0) {
        const pctReal = aportes / base * 100;
        if (Math.abs(pctReal - pctEsperado) > 0.3) add('warn', r.empleado_id, r.nom, r.leg_num, 'Aportes', `Aportes ${pctReal.toFixed(2)}% (esperado ${pctEsperado.toFixed(2)}%)`);
      }
      if (remun > topeMax && topeMax !== Infinity) add('info', r.empleado_id, r.nom, r.leg_num, 'Tope SIPA', `Remuneración $${remun.toFixed(2)} supera el tope SIPA ($${topeMax.toFixed(2)}); aporte topeado`);
      if (remun > 0 && baseMin > 0 && remun < baseMin) add('info', r.empleado_id, r.nom, r.leg_num, 'Base mínima', `Remuneración por debajo de la base mínima ($${baseMin.toFixed(2)})`);
      // Variación vs mes anterior
      const prev = prevNeto.get(r.empleado_id);
      if (prev && prev > 0) { const v = (neto - prev) / prev * 100; if (Math.abs(v) > umbral) add('warn', r.empleado_id, r.nom, r.leg_num, 'Variación', `Neto varió ${v > 0 ? '+' : ''}${v.toFixed(1)}% vs ${String(pm).padStart(2, '0')}/${pa}`); }
    }
    // Empleados activos sin recibo en el período
    const condE = ['e.activo=true']; const argE = [];
    if (empresa) { argE.push(empresa); condE.push(`em.nombre = $${argE.length}`); }
    const activos = (await query(`SELECT e.id, e.nom, e.leg_num FROM empleados e JOIN empresas em ON em.id=e.empresa_id WHERE ${condE.join(' AND ')}`, argE)).rows;
    for (const e of activos) if (!conRecibo.has(e.id)) add('warn', e.id, e.nom, e.leg_num, 'Sin recibo', 'Empleado activo sin recibo en el período');

    const resumen = { recibos: recs.length, errores: issues.filter((x) => x.severidad === 'error').length, warnings: issues.filter((x) => x.severidad === 'warn').length, info: issues.filter((x) => x.severidad === 'info').length };
    res.json({ periodo: { anio, mes }, resumen, issues });
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

    if (empresa && await periodoCerrado(empresa, anio, mes)) return res.status(409).json({ error: `El período ${String(mes).padStart(2,'0')}/${anio} de ${empresa} está cerrado` });
    try { await autoActualizarValores(); } catch (e) { /* no bloquea la corrida */ }
    const verVal = await verificarValoresLegales(anio, mes);
    if (verVal.faltan) return res.status(409).json({ error: verVal.mensaje });
    const params = await getParamsConValores(anio, mes);
    const ganTabla = await ganTablaParaFecha(fechaPago || `${anio}-${String(mes).padStart(2, '0')}-15`);
    const sMap = await sindMap();
    const cMap = await convMap();
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
      const _sd = sindDe(sMap, emp); const _cb = convBasicoDe(cMap, emp);
      const _emb = (tipo === 'mensual' || tipo === 'quincenal_1' || tipo === 'quincenal_2') ? await embargosOpts(id, fechaPago) : {};
      const _nov = _esMensual(tipo) ? { ...await novedadesOpts(id, anio, mes), ...await licenciasSinGoceOpts(id, anio, mes) } : {};
      const _varProm = (tipo === 'vacaciones' || _esMensual(tipo)) ? await promedioVariablesMes(id, anio, mes) : {};
      const _sacBase = _esSAC(tipo) ? await mejorRemSemestre(id, anio, tipo) : 0;
      let _ajPend = 0;
      if (_esMensual(tipo)) { await resetAjusteNeto(id, anio, mes); _ajPend = await ajustePendiente(id, anio, mes); }
      const recibo = calcularRecibo(emp, params, { anio: Number(anio), mes: Number(mes), tipo, fechaPago, cuotasAnticipos: cuotas, acumGanancias: acumGan, ganTabla, presBase: _sd?.presBase || 'basico', sind: _sd, convBasico: _cb, ajusteNetoRecuperar: _ajPend, mejorRemSAC: _sacBase, ..._nov, ..._varProm, ..._emb });
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
      if (_esMensual(tipo)) await commitAjusteNeto(id, anio, mes, recibo);
    }
    await query('UPDATE corridas SET total_neto=$1, cant=$2 WHERE id=$3', [totalNeto, cant, corridaId]);
    res.status(201).json({ ok: true, id: corridaId, cant, totalNeto, avisoValores: verVal.desactualizado ? verVal.mensaje : null });
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

const BANCOS = [
  { v: 'generico', label: 'Genérico (CSV)', formato: 'CSV' },
  { v: 'galicia', label: 'Banco Galicia', formato: 'CSV' },
  { v: 'santander', label: 'Santander', formato: 'CSV' },
  { v: 'bbva', label: 'BBVA', formato: 'CSV' },
  { v: 'bna', label: 'Banco Nación (Datanet)', formato: 'TXT' },
  { v: 'macro', label: 'Banco Macro', formato: 'TXT' },
  { v: 'provincia', label: 'Banco Provincia (Bapro)', formato: 'TXT' },
  { v: 'icbc', label: 'ICBC', formato: 'TXT' },
  { v: 'supervielle', label: 'Supervielle', formato: 'TXT' },
];
const sinAcentos = (x) => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const padB = (v, n, ch, right) => { v = String(v == null ? '' : v).slice(0, n); return right ? v.padStart(n, ch) : v.padEnd(n, ch); };

// Asegura el catálogo de diseños en la base (siembra desde BANCOS la primera vez).
async function ensureDisenos() {
  const c = await query('SELECT COUNT(*)::int AS n FROM banco_disenos');
  if (c.rows[0].n === 0) {
    for (const b of BANCOS) await query(
      `INSERT INTO banco_disenos (codigo, label, formato, version, descripcion) VALUES ($1,$2,$3,1,$4) ON CONFLICT (codigo) DO NOTHING`,
      [b.v, b.label, b.formato, `Diseño de registro inicial — ${b.label} (${b.formato})`]);
  }
}

// GET /api/liquidacion/bancos — catálogo de diseños (con versión y fecha de actualización)
router.get('/bancos', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    await ensureDisenos();
    const { rows } = await query('SELECT codigo AS v, label, formato, version, descripcion, actualizado_at, actualizado_por FROM banco_disenos ORDER BY label');
    res.json(rows);
  } catch (e) { next(e); }
});

// GET /api/liquidacion/bancos/:codigo/verificar — ¿el diseño cambió desde la última generación?
router.get('/bancos/:codigo/verificar', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    await ensureDisenos();
    const d = (await query('SELECT codigo, label, formato, version, descripcion, actualizado_at, actualizado_por FROM banco_disenos WHERE codigo=$1', [req.params.codigo])).rows[0];
    if (!d) return res.status(404).json({ error: 'Banco no encontrado' });
    const last = (await query('SELECT version_diseno, created_at FROM banco_generaciones WHERE banco=$1 ORDER BY created_at DESC LIMIT 1', [req.params.codigo])).rows[0] || null;
    res.json({
      ...d,
      ultimaVersion: last ? last.version_diseno : null,
      ultimaFecha: last ? last.created_at : null,
      primeraVez: !last,
      actualizado: last ? (d.version > last.version_diseno) : false,
    });
  } catch (e) { next(e); }
});

// PATCH /api/liquidacion/bancos/:codigo — registrar una actualización del diseño (incrementa versión)
router.patch('/bancos/:codigo', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    await ensureDisenos();
    const { label, formato, descripcion } = req.body || {};
    if (formato && !['CSV', 'TXT'].includes(formato)) return res.status(400).json({ error: 'Formato inválido (CSV o TXT)' });
    const r = await query(
      `UPDATE banco_disenos SET label=COALESCE($1,label), formato=COALESCE($2,formato), descripcion=COALESCE($3,descripcion),
              version=version+1, actualizado_por=$4, actualizado_at=now() WHERE codigo=$5 RETURNING *`,
      [label || null, formato || null, descripcion || null, req.user.dni, req.params.codigo]);
    if (!r.rowCount) return res.status(404).json({ error: 'Banco no encontrado' });
    res.json(r.rows[0]);
  } catch (e) { next(e); }
});

// GET /api/liquidacion/corrida/:id/banco?banco=&fecha=&leyenda= — archivo de acreditación (CSV o TXT posicional)
router.get('/corrida/:id/banco', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const banco = String(req.query.banco || 'generico');
    const fecha = String(req.query.fecha || new Date().toISOString().slice(0, 10));
    const leyenda = sinAcentos(req.query.leyenda || 'HABERES').toUpperCase();
    const rows = (await query(
      `SELECT e.leg_num, e.nom, e.cuil, r.neto,
              (SELECT json_agg(json_build_object('cbu', c.cbu, 'pct', c.porcentaje)) FROM cbus c WHERE c.empleado_id=e.id AND c.activo=true) AS cbus
         FROM recibos r JOIN empleados e ON e.id=r.empleado_id
        WHERE r.corrida_id=$1 ORDER BY e.nom`, [req.params.id])).rows;
    const recs = [];
    for (const r of rows) {
      const cbus = r.cbus && r.cbus.length ? r.cbus : [{ cbu: '', pct: 100 }];
      for (const c of cbus) recs.push({ leg: r.leg_num, nom: r.nom, cuil: String(r.cuil || '').replace(/\D/g, ''), cbu: String(c.cbu || '').replace(/\D/g, ''), centavos: Math.round(Number(r.neto) * Number(c.pct || 100) / 100 * 100) });
    }
    await ensureDisenos();
    const dis = (await query('SELECT formato, version FROM banco_disenos WHERE codigo=$1', [banco])).rows[0];
    const cfg = dis ? { v: banco, formato: dis.formato } : (BANCOS.find((b) => b.v === banco) || BANCOS[0]);
    let body, ext, mime;
    if (cfg.formato === 'TXT') {
      const fechaTxt = fecha.replace(/-/g, '');
      const lineas = recs.map((x) => padB(x.cbu, 22, '0', true) + padB(x.cuil, 11, '0', true) + padB(x.centavos, 15, '0', true) + padB(sinAcentos(x.nom), 30, ' ', false) + padB(leyenda, 20, ' ', false) + fechaTxt);
      body = lineas.join('\r\n'); ext = 'txt'; mime = 'text/plain; charset=utf-8';
    } else {
      const lineas = ['Legajo,Nombre,CUIL,CBU,Importe,Leyenda,Fecha'];
      for (const x of recs) lineas.push(`${x.leg},"${sinAcentos(x.nom)}",${x.cuil},${x.cbu},${(x.centavos / 100).toFixed(2)},${leyenda},${fecha}`);
      body = '\uFEFF' + lineas.join('\r\n'); ext = 'csv'; mime = 'text/csv; charset=utf-8';
    }
    if (dis) await query('INSERT INTO banco_generaciones (banco, version_diseno, corrida_id, created_by) VALUES ($1,$2,$3,$4)', [banco, dis.version, Number(req.params.id), req.user.dni]).catch(() => {});
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `attachment; filename="acreditacion_${banco}_corrida_${req.params.id}.${ext}"`);
    res.send(body);
  } catch (e) { next(e); }
});

// POST /api/liquidacion/simular { anio, mes, empresa?, incrementoPct } — simulación de costo (no persiste)
router.post('/simular', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const { anio, mes, empresa, incrementoPct } = req.body || {};
    if (!anio || !mes) return res.status(400).json({ error: 'anio y mes son obligatorios' });
    const pct = Number(incrementoPct) || 0;
    const f = 1 + pct / 100;
    const cond = ['e.activo = true'], pr = [];
    if (empresa) { pr.push(empresa); cond.push(`em.nombre = $${pr.length}`); }
    const emps = (await query(
      `SELECT e.*, em.nombre AS empresa_nombre FROM empleados e JOIN empresas em ON em.id=e.empresa_id WHERE ${cond.join(' AND ')} ORDER BY em.nombre, e.leg_num`, pr)).rows;
    const params = await getParams();
    const items = []; const tot = { costoActual: 0, costoSim: 0, netoActual: 0, netoSim: 0 };
    for (const r of emps) {
      const base = { legNum: r.leg_num, nom: r.nom, empresa: r.empresa_nombre, cuil: r.cuil, cat: r.cat, ingreso: r.ingreso, bruto: Number(r.bruto), data: r.data || {} };
      const d = base.data;
      const scale = (x) => x == null ? x : Number(x) * f;
      const simData = { ...d, basico: scale(d.basico), sueldo: scale(d.sueldo), complemento: scale(d.complemento), norem: scale(d.norem) };
      const empSim = { ...base, bruto: base.bruto * f, data: simData };
      const recA = calcularRecibo(base, params, { anio: Number(anio), mes: Number(mes), tipo: 'mensual' });
      const recS = calcularRecibo(empSim, params, { anio: Number(anio), mes: Number(mes), tipo: 'mensual' });
      tot.costoActual += recA.costoEmpleador.costoTotal; tot.costoSim += recS.costoEmpleador.costoTotal;
      tot.netoActual += recA.totales.neto; tot.netoSim += recS.totales.neto;
      items.push({ legNum: r.leg_num, nom: r.nom, empresa: r.empresa_nombre,
        netoActual: recA.totales.neto, netoSim: recS.totales.neto,
        costoActual: recA.costoEmpleador.costoTotal, costoSim: recS.costoEmpleador.costoTotal });
    }
    const r2n = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
    res.json({
      incrementoPct: pct, cant: items.length, items,
      totales: { netoActual: r2n(tot.netoActual), netoSim: r2n(tot.netoSim),
        costoActual: r2n(tot.costoActual), costoSim: r2n(tot.costoSim),
        deltaCosto: r2n(tot.costoSim - tot.costoActual), deltaNeto: r2n(tot.netoSim - tot.netoActual) },
    });
  } catch (e) { next(e); }
});

// POST /api/liquidacion/simular-gratificacion { empresa?, concepto, tipo:'rem'|'norem', modo:'fijo'|'pctBruto', valor }
router.post('/simular-gratificacion', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const { empresa, concepto = 'Gratificación', tipo = 'rem', modo = 'fijo', valor } = req.body || {};
    const v = Number(valor) || 0;
    if (v <= 0) return res.status(400).json({ error: 'El valor debe ser mayor a 0' });
    const cond = ['e.activo = true'], pr = [];
    if (empresa) { pr.push(empresa); cond.push(`em.nombre = $${pr.length}`); }
    const emps = (await query(
      `SELECT e.leg_num, e.nom, e.bruto, e.cuil, em.nombre AS empresa, e.data FROM empleados e JOIN empresas em ON em.id=e.empresa_id WHERE ${cond.join(' AND ')} ORDER BY em.nombre, e.leg_num`, pr)).rows;
    const p = await getParams();
    const n = (x) => Number(x) || 0;
    const pctAportes = n(p.pctJubilacion) + n(p.pctObraSocial) + n(p.pctAnssal) + n(p.pctPamiEmp);
    const pctContrib = n(p.pctJubPatronal) + n(p.pctOsPatronal) + n(p.pctPamiPatronal) + n(p.pctDesempleo) + n(p.pctArt);
    const esRem = tipo === 'rem';
    const r2n = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
    const items = []; const tot = { importe: 0, aportes: 0, neto: 0, contrib: 0, incidSac: 0, costo: 0 };
    for (const e of emps) {
      const bruto = Number(e.bruto) || 0;
      const importe = modo === 'pctBruto' ? bruto * v / 100 : v;
      if (importe <= 0) continue;
      const aportes = esRem ? importe * pctAportes / 100 : 0;
      const contrib = esRem ? importe * pctContrib / 100 : 0;
      const neto = importe - aportes;
      const incidSac = esRem ? importe / 12 : 0;
      const costo = importe + contrib;
      items.push({ legNum: e.leg_num, nom: e.nom, empresa: e.empresa, bruto, importe: r2n(importe), aportes: r2n(aportes), neto: r2n(neto), contrib: r2n(contrib), incidSac: r2n(incidSac), costo: r2n(costo) });
      tot.importe += importe; tot.aportes += aportes; tot.neto += neto; tot.contrib += contrib; tot.incidSac += incidSac; tot.costo += costo;
    }
    res.json({
      concepto, tipo, modo, valor: v, cant: items.length, items,
      totales: { importe: r2n(tot.importe), aportes: r2n(tot.aportes), neto: r2n(tot.neto), contrib: r2n(tot.contrib), incidSac: r2n(tot.incidSac), costo: r2n(tot.costo) },
    });
  } catch (e) { next(e); }
});

const SUPUESTOS_BAJA = [
  { v: 'renuncia', lbl: 'Renuncia (Art. 240)' },
  { v: 'sin_causa', lbl: 'Despido sin causa (Art. 245)' },
  { v: 'fuerza_mayor', lbl: 'Fuerza mayor / falta de trabajo (Art. 247)' },
  { v: 'con_causa', lbl: 'Despido con justa causa (Art. 242)' },
  { v: 'mutuo', lbl: 'Mutuo acuerdo (Art. 241)' },
  { v: 'jubilacion', lbl: 'Jubilación / Retiro (Art. 252)' },
  { v: 'fallecimiento', lbl: 'Fallecimiento (Art. 248)' },
  { v: 'prueba', lbl: 'Período de prueba (Art. 92 bis)' },
];

// POST /api/liquidacion/simular-final { empleadoId, fechaEgreso, diasVacNoGozadas?, supuesto? }
router.post('/simular-final', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const { empleadoId, fechaEgreso, diasVacNoGozadas } = req.body || {};
    if (!empleadoId || !fechaEgreso) return res.status(400).json({ error: 'empleadoId y fechaEgreso son obligatorios' });
    const emp = await getEmp(empleadoId);
    if (!emp) return res.status(404).json({ error: 'Empleado no encontrado' });
    const params = await getParams();
    const fe = new Date(fechaEgreso + 'T12:00:00');
    const escenarios = SUPUESTOS_BAJA.map((sup) => {
      const rec = calcularRecibo(emp, params, { anio: fe.getFullYear(), mes: fe.getMonth() + 1, tipo: 'final', fechaEgreso, motivoBaja: sup.v, diasVacNoGozadas: Number(diasVacNoGozadas) || 0 });
      return { supuesto: sup.v, label: sup.lbl, neto: rec.totales.neto, totalHaberes: rec.totales.totalHaberes, haberes: rec.haberes, detalle: rec.detalle };
    });
    res.json({ empleado: { legNum: emp.legNum, nom: emp.nom, empresa: emp.empresa, ingreso: emp.ingreso }, escenarios });
  } catch (e) { next(e); }
});

// POST /api/liquidacion/simular-final-masivo { empresa?, fechaEgreso, diasVacNoGozadas? }
// Liquidación final de TODO el plantel (o de una empresa) comparando los 7 supuestos de baja.
router.post('/simular-final-masivo', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const { empresa, fechaEgreso, diasVacNoGozadas, supuesto } = req.body || {};
    if (!fechaEgreso) return res.status(400).json({ error: 'fechaEgreso es obligatoria' });
    const lista = supuesto ? SUPUESTOS_BAJA.filter((sp) => sp.v === supuesto) : SUPUESTOS_BAJA;
    if (!lista.length) return res.status(400).json({ error: 'supuesto inválido' });
    const cond = ['e.activo = true'], pr = [];
    if (empresa) { pr.push(empresa); cond.push(`em.nombre = $${pr.length}`); }
    const emps = (await query(`SELECT e.*, em.nombre AS empresa_nombre FROM empleados e JOIN empresas em ON em.id=e.empresa_id WHERE ${cond.join(' AND ')} ORDER BY em.nombre, e.leg_num`, pr)).rows;
    const params = await getParams();
    const fe = new Date(fechaEgreso + 'T12:00:00');
    const dvac = Number(diasVacNoGozadas) || 0;
    const r2n = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
    const tot = {}; lista.forEach((sp) => { tot[sp.v] = 0; });
    const items = emps.map((r) => {
      const base = { legNum: r.leg_num, nom: r.nom, empresa: r.empresa_nombre, cuil: r.cuil, cat: r.cat, ingreso: r.ingreso, bruto: Number(r.bruto), data: r.data || {} };
      const netos = {};
      for (const sp of lista) {
        const rec = calcularRecibo(base, params, { anio: fe.getFullYear(), mes: fe.getMonth() + 1, tipo: 'final', fechaEgreso, motivoBaja: sp.v, diasVacNoGozadas: dvac });
        netos[sp.v] = r2n(rec.totales.neto); tot[sp.v] += rec.totales.neto;
      }
      return { legNum: r.leg_num, nom: r.nom, empresa: r.empresa_nombre, ingreso: r.ingreso, netos };
    });
    Object.keys(tot).forEach((k) => { tot[k] = r2n(tot[k]); });
    res.json({ supuestos: lista, cant: items.length, items, totales: tot });
  } catch (e) { next(e); }
});

export default router;
