// ─────────────────────────────────────────────────────────────────────────────
// Libro de asiento de sueldos — réplica del Excel mensual "Asiento <empresa>"
// que hoy se arma a mano a partir de la exportación del sistema anterior.
//
// Reproduce las 14 hojas con las mismas columnas y el mismo criterio de filas:
//   AP LIQUI · ASTO SUELDO · Remun · CATEGORIAS · Contribuciones ·
//   TABLA PLAN CTAS · TABLA ALICUOTAS · RETENCIONES SUSS SUFRIDAS · TABLA OS ·
//   DETALLE GANANCIAS · Detalle Liq OS · Tabla Aportes ROS-CORD-MEND ·
//   Tabla Aportes Personal UOM · ANTICIPOS SUELDOS
//
// Criterio: cada hoja devuelve { key, titulo, columnas, filas, nota, faltan }.
// Lo que el sistema todavía no puede calcular NO se inventa: la celda va vacía
// y el motivo se reporta en `faltantes` para que la pantalla lo muestre.
// ─────────────────────────────────────────────────────────────────────────────
import { query } from '../db.js';
import { migrarAsiento } from '../db/migrateAsiento.js';
import { migrarAsientoAux } from '../db/migrateAsientoAux.js';

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const num = (n) => Number(n) || 0;

// ── Clasificación de líneas del recibo en las columnas del Excel ─────────────
// El orden importa: la primera expresión que matchea se queda con la línea.
const HABERES_REM = [
  ['COMP_FUNCION', /complement\w*\s+(de\s+)?funci/i],
  ['COMISIONES',   /comisi/i],
  ['HS_EXT_Y_A',   /hora[s]?\s*extra|\b(50|100)\s*%|nocturnidad|adicional\s+por\s+hora/i],
  ['PRESENTISM',   /presentismo|asistencia\s+(perfecta|puntual)/i],
  ['VACACION',     /vacacion/i],
  ['LICENCIAS',    /licencia|enfermedad|accidente|maternidad|art[íi]culo\s*208/i],
  ['SAC',          /\bsac\b|aguinaldo/i],
  ['REDUCCION',    /reducci[óo]n/i],
  ['R_ASIGNADA',   /sueldo\s+b[áa]sico|b[áa]sico|jornal|sueldo\s+asignado|remuneraci[óo]n\s+asignada|antig[üu]edad/i],
];
const HABERES_NOREM = [
  ['INDEMNIZ_Y', /indemniz|preaviso|integraci[óo]n\s+mes|vacaciones\s+no\s+gozadas/i],
  ['ACUERDO',    /acuerdo|no\s+remunerativ|suma\s+fija|gratificaci/i],
];
const DESCUENTOS = [
  ['APO_JUB',    /jubilaci/i],
  ['LEY_19032',  /19\.?032|inssjp|pami/i],
  ['ANSSAL',     /anssal/i],
  ['O_S_ADHE',   /adherente/i],
  ['O_S_ADIC',   /obra\s+social\s+adicional|adicional\s+de\s+obra\s+social|plan\s+superador/i],
  ['AJ_O_SOCIA', /ajuste\s+.*obra\s+social|aporte\s+extraordinario/i],
  ['O_SOCIAL',   /obra\s+social/i],
  ['FAECYS',     /faecys/i],
  ['SEG_VIDA_Y', /seguro\s+de\s+vida|sepelio|la\s+estrella/i],
  ['SINDICATO',  /sindical|sindicato|cuota\s+gremial|solidarid/i],
  ['IMP_GCIAS',  /ganancias/i],
  ['ANT_SDO_PR', /anticipo|adelanto|pr[ée]stamo/i],
  ['EMBARGO',    /embargo|cuota\s+alimentar/i],
];
const CONTRIBUCIONES = [
  ['CONT_SIJP',      /jubilaci[óo]n\s+patronal|sipa|asistencia\s+laboral/i],
  ['CONT_19032',     /inssjp|pami/i],
  ['CONT_FNE',       /fondo\s+nacional\s+de\s+empleo/i],
  ['CONT_AFAM',      /asignaciones\s+familiares/i],
  ['CONT_ANSSAL',    /anssal/i],
  ['CONT_OS',        /obra\s+social/i],
  ['CONT_ART',       /\bart\b|riesgos\s+del\s+trabajo|ffep/i],
  ['CONT_SIND',      /sindical|sindicato/i],
  ['CONT_SCVO',      /scvo|seguro\s+de\s+vida\s+oblig/i],
  ['CONT_ESTRELLA',  /estrella/i],
  ['CONT_FCESE',     /fondo\s+de\s+cese/i],
];

const primerMatch = (defs, texto) => (defs.find(([, re]) => re.test(texto)) || [])[0];

// ── Columnas de cada hoja (mismos rótulos que el Excel) ──────────────────────
export const COLS_REMUN = [
  'CENTRO DE COSTOS', 'CENTRO DE OPERACIONES', 'LEGAJO', 'AP_YNOMBRE',
  'R_ASIGNADA', 'COMP.FUNCION', 'COMISIONES', 'HS_EXT_Y_A', 'PRESENTISM',
  'VACACION', 'LICENCIAS', 'SAC', 'OTROS_REM', 'REDUCCION',
  'APO_JUB', 'LEY_19032', 'O_SOCIAL', 'O_S_ADHE', 'ANSSAL', 'SINDICATO',
  'FAECYS', 'AJ_O_SOCIA', 'SEG_VIDA_Y', 'O_S_ADIC', 'IMP_GCIAS', 'ANT_SDO_PR',
  'OTRAS_DED', 'INDEMNIZ_Y', 'ACUERDO', 'APO_OS_S_A', 'APO_SINDIC',
  'APO_FAECYS', 'OTROSNR', 'NETO',
];
const KEY_REMUN = {
  'R_ASIGNADA': 'R_ASIGNADA', 'COMP.FUNCION': 'COMP_FUNCION', 'COMISIONES': 'COMISIONES',
  'HS_EXT_Y_A': 'HS_EXT_Y_A', 'PRESENTISM': 'PRESENTISM', 'VACACION': 'VACACION',
  'LICENCIAS': 'LICENCIAS', 'SAC': 'SAC', 'OTROS_REM': 'OTROS_REM', 'REDUCCION': 'REDUCCION',
  'APO_JUB': 'APO_JUB', 'LEY_19032': 'LEY_19032', 'O_SOCIAL': 'O_SOCIAL', 'O_S_ADHE': 'O_S_ADHE',
  'ANSSAL': 'ANSSAL', 'SINDICATO': 'SINDICATO', 'FAECYS': 'FAECYS', 'AJ_O_SOCIA': 'AJ_O_SOCIA',
  'SEG_VIDA_Y': 'SEG_VIDA_Y', 'O_S_ADIC': 'O_S_ADIC', 'IMP_GCIAS': 'IMP_GCIAS',
  'ANT_SDO_PR': 'ANT_SDO_PR', 'OTRAS_DED': 'OTRAS_DED', 'INDEMNIZ_Y': 'INDEMNIZ_Y',
  'ACUERDO': 'ACUERDO', 'APO_OS_S_A': 'APO_OS_S_A', 'APO_SINDIC': 'APO_SINDIC',
  'APO_FAECYS': 'APO_FAECYS', 'OTROSNR': 'OTROSNR', 'NETO': 'NETO',
};

export const COLS_CONTRIB = [
  'CUIT', 'CENTRO DE COSTOS', 'CENTRO DE OPERACIÓN', 'LEGAJO', 'AP_YNOMBRE',
  'PLUS_1', 'VAC_1', 'DS_1', 'PLUS_2', 'VAC_2', 'DS_2', 'PLUS_3', 'VAC_3', 'DS_3',
  'AJUVAC', 'PLUSMES', 'SAC', 'DSSAC', 'HABERES', 'REDUCCION', 'DSNTRA',
  'COD_CATEGO', 'SUELDO_BAS', 'ANTIGUEDAD', 'Dto 14/2020',
  'BI SAC SIJP', 'BI APORTES SS', 'BI APORTES SS VAC', 'TOTAL REM IMP 1',
  'BI AJ MANUAL REM IMP 1', 'BI APORTES OS', 'BI APORTES OS SAC', 'BI APORTES OS VAC',
  'TOTAL REM IMP 4', 'BI AJ MANUAL REM IMP 4', 'BI REM 5', 'BI SAC REM 5',
  'BI VACAC REM 5', 'TOTAL REM IMP 5', 'TOTAL REM IMP 8', 'BI AJ MANUAL REM IMP 5',
  'BI REM IMP 2y3', 'BI REM IMP 9', 'BI REM IMP 10', 'BI REM IMP 11',
  'Ley 27940', 'Base Seg La Estrella', 'Base Sec San Martin / FAECyS',
  'Acuerdos no Remunerativos Sueldo', 'Acuerdos no Remunerativos SIN AP OS',
  'Acuerdos no Remunerativos VAC', 'Base Minima OS SUELDO', 'Base Minima OS SAC',
  'Base Minima OS VAC', 'Base Minima NOREM',
  '% jornada', '% sijp', '% 19032', '% fne', '% afam', 'OS Direc', '% anssal',
  '% art', 'fijo art $', '% La Estrella',
  'CONT SIJP', 'CONT 19032', 'CONT FNE', 'CONT AFAM', 'CONT ANSSAL', 'CONT OS',
  'CONT ART', 'TOTAL CONT SS', 'CONT LA ESTRELLA', 'APORTES SS', 'APORTES OS',
  'CONTRIBUCION INACAP', 'CONTRIBUCION SEGURO VIDA OBLIG',
  'CONT EXTRAORDINARIA UOM', 'CONT SEG VIDA UOM', 'CONT Norem UOM',
  'CONTRIBUCION OSECAC', 'Detracción art. 23 Ley 27.541',
];

// ── Conceptos propios de cada gremio (INACAP, La Estrella, OSECAC, UOM) ─────
// Se imputan a cuenta separada en el asiento. Se aplican al legajo cuando el
// concepto no tiene gremio (vale para todos) o cuando coincide con el del legajo.
function sindicalesDe(rec, sindicales) {
  const cod = String(rec.edata?.cod_sindicato || '').trim().toUpperCase();
  const remun = num(rec.data?.totales?.totalRemun);
  const o = {};
  for (const c of sindicales) {
    const suyo = !c.cod_sindicato || cod === String(c.cod_sindicato).toUpperCase()
      || cod.includes(String(c.cod_sindicato).toUpperCase());
    if (!suyo) continue;
    const monto = c.base === 'remunerativo' ? r2(remun * num(c.pct) / 100) : r2(num(c.importe));
    if (monto) o[c.columna] = r2(num(o[c.columna]) + monto);
  }
  return o;
}

// ── Datos base del período ───────────────────────────────────────────────────
async function recibosDelPeriodo(anio, mes, empresa) {
  const cond = ['r.anio = $1', 'r.mes = $2'], pr = [Number(anio), Number(mes)];
  if (empresa) { pr.push(empresa); cond.push(`em.nombre = $${pr.length}`); }
  const { rows } = await query(
    `SELECT r.data, r.tipo, r.neto, e.id AS emp_id, e.nom, e.leg_num, e.cuil, e.cat,
            e.ingreso, e.data AS edata, em.nombre AS empresa, em.cuit AS empresa_cuit
       FROM recibos r
       JOIN empleados e  ON e.id = r.empleado_id
       JOIN empresas em  ON em.id = e.empresa_id
      WHERE ${cond.join(' AND ')}
      ORDER BY em.nombre, (e.leg_num ~ '^[0-9]+$')::int DESC,
               NULLIF(regexp_replace(e.leg_num,'\\D','','g'),'')::bigint NULLS LAST, e.nom`, pr);
  return rows;
}

// Centro de costos y de operaciones del legajo. Hoy no son campos del modelo:
// se leen del JSON del legajo si RR.HH. los cargó, con el lugar de trabajo como
// respaldo para el centro de operaciones.
const centroCosto = (ed) => String(ed?.centroCosto || ed?.centro_costo || '').trim().toLowerCase();
const centroOper  = (ed) => String(ed?.centroOperacion || ed?.centro_operacion || ed?.lugar || '').trim();

// ── Clasificador de un recibo en las columnas de la hoja Remun ───────────────
function clasificar(rec) {
  const d = rec.data || {};
  const o = Object.fromEntries(Object.values(KEY_REMUN).map((k) => [k, 0]));

  for (const h of (d.haberes || [])) {
    const monto = num(h.monto), txt = String(h.concepto || '');
    if (h.tipo === 'rem') {
      const k = primerMatch(HABERES_REM, txt) || 'OTROS_REM';
      o[k] = r2(o[k] + monto);
    } else {
      const k = primerMatch(HABERES_NOREM, txt) || 'OTROSNR';
      o[k] = r2(o[k] + monto);
    }
  }
  // Los descuentos van con signo negativo, igual que en el Excel.
  for (const x of (d.descuentos || [])) {
    const monto = num(x.monto), txt = String(x.concepto || '');
    const k = primerMatch(DESCUENTOS, txt) || 'OTRAS_DED';
    o[k] = r2(o[k] - monto);
  }
  o.NETO = r2(num(d.totales?.neto ?? rec.neto));
  return o;
}

function clasificarContrib(rec) {
  const o = {};
  for (const c of (rec.data?.costoEmpleador?.contribuciones || [])) {
    const k = primerMatch(CONTRIBUCIONES, String(c.concepto || '')) || 'CONT_OTRAS';
    o[k] = r2(num(o[k]) + num(c.monto));
  }
  o.TOTAL = r2(num(rec.data?.costoEmpleador?.totalContrib));
  return o;
}

// ─────────────────────────────────────────────────────────────────────────────
// HOJAS
// ─────────────────────────────────────────────────────────────────────────────
function hojaRemun(recibos) {
  const filas = recibos.map((rec) => {
    const c = clasificar(rec), ed = rec.edata || {};
    return [
      centroCosto(ed), centroOper(ed), rec.leg_num, rec.nom,
      ...COLS_REMUN.slice(4).map((col) => c[KEY_REMUN[col]] ?? 0),
    ];
  });
  return { key: 'Remun', titulo: 'Remun', columnas: COLS_REMUN, filas,
    nota: 'Un renglón por legajo liquidado. Los descuentos van en negativo, como en el Excel original.' };
}

function hojaContribuciones(recibos, alicuotas, sindicales) {
  const filas = recibos.map((rec) => {
    const d = rec.data || {}, ed = rec.edata || {}, ct = clasificarContrib(rec);
    const b = d.bases || {};               // ← bases imponibles SICOSS (ver "faltantes")
    const t = d.totales || {};
    const v = {};
    const set = (k, val) => { v[k] = val; };
    set('CUIT', rec.cuil || '');
    set('CENTRO DE COSTOS', centroCosto(ed));
    set('CENTRO DE OPERACIÓN', centroOper(ed));
    set('LEGAJO', rec.leg_num);
    set('AP_YNOMBRE', rec.nom);
    set('HABERES', r2(num(t.totalRemun) + num(t.totalNoRem)));
    set('REDUCCION', Math.abs(clasificar(rec).REDUCCION));
    set('COD_CATEGO', rec.cat || ed.desc_categoria || '');
    set('SUELDO_BAS', num(ed.basico ?? ed.sueldo));
    set('ANTIGUEDAD', num(ed.antiguedad_monto));
    set('SAC', clasificar(rec).SAC);
    // Bases imponibles: sólo si la liquidación las dejó guardadas.
    set('BI APORTES SS',  b.remImp1 ?? '');
    set('TOTAL REM IMP 1', b.remImp1 ?? '');
    set('BI APORTES OS',  b.remImp4 ?? '');
    set('TOTAL REM IMP 4', b.remImp4 ?? '');
    set('BI REM 5',       b.remImp5 ?? '');
    set('TOTAL REM IMP 5', b.remImp5 ?? '');
    set('TOTAL REM IMP 8', b.remImp8 ?? '');
    set('BI REM IMP 2y3', b.remImp2 ?? '');
    set('BI REM IMP 9',   b.remImp9 ?? '');
    set('BI REM IMP 10',  b.remImp10 ?? '');
    set('BI REM IMP 11',  b.remImp11 ?? '');
    set('BI SAC SIJP',    b.sac ?? '');
    set('BI VACAC REM 5', b.vacaciones ?? '');
    set('Detracción art. 23 Ley 27.541', b.detraccion ?? '');
    // Alícuotas vigentes (paramétricas, iguales para todos salvo ART por empresa).
    set('% jornada', num(ed.pctJornada) || 1);
    set('% sijp',    alicuotas.sijp);
    set('% 19032',   alicuotas.ley19032);
    set('% fne',     alicuotas.fne);
    set('% afam',    alicuotas.afam);
    set('% anssal',  alicuotas.anssal);
    set('% art',     alicuotas.artVariable);
    set('fijo art $', alicuotas.artFijo);
    set('OS Direc',  ed.cod_os || '');
    // Contribuciones calculadas por el motor de liquidación.
    set('CONT SIJP',   ct.CONT_SIJP || 0);
    set('CONT 19032',  ct.CONT_19032 || 0);
    set('CONT FNE',    ct.CONT_FNE || 0);
    set('CONT AFAM',   ct.CONT_AFAM || 0);
    set('CONT ANSSAL', ct.CONT_ANSSAL || 0);
    set('CONT OS',     ct.CONT_OS || 0);
    set('CONT ART',    ct.CONT_ART || 0);
    set('TOTAL CONT SS', ct.TOTAL || 0);
    set('CONT LA ESTRELLA', ct.CONT_ESTRELLA || 0);
    set('CONTRIBUCION SEGURO VIDA OBLIG', ct.CONT_SCVO || 0);
    const cl = clasificar(rec);
    set('APORTES SS', Math.abs(cl.APO_JUB + cl.LEY_19032));
    set('APORTES OS', Math.abs(cl.O_SOCIAL + cl.ANSSAL));
    set('Acuerdos no Remunerativos Sueldo', cl.ACUERDO);
    // Conceptos del gremio, con las mismas etiquetas del Excel.
    const sd = sindicalesDe(rec, sindicales);
    set('CONTRIBUCION INACAP',      sd.CONT_INACAP  || 0);
    set('CONT LA ESTRELLA',         sd.CONT_ESTRELLA || ct.CONT_ESTRELLA || 0);
    set('CONTRIBUCION OSECAC',      sd.CONT_OSECAC  || 0);
    set('CONT EXTRAORDINARIA UOM',  sd.CONT_UOM_EXT || 0);
    set('CONT SEG VIDA UOM',        sd.CONT_UOM_SV  || 0);
    set('CONT Norem UOM',           sd.CONT_UOM_NR  || 0);
    return COLS_CONTRIB.map((col) => (v[col] === undefined ? '' : v[col]));
  });
  return { key: 'Contribuciones', titulo: 'Contribuciones', columnas: COLS_CONTRIB, filas,
    nota: 'Bases imponibles y alícuotas por legajo. Las columnas vacías son las que todavía no se persisten en la liquidación (ver "Datos a cargar").' };
}

function hojaApLiqui(recibos, embargos, indemn) {
  const columnas = ['CENTRO DE COSTOS', 'CENTRO DE OPERACIONES', 'LEGAJO', 'AP_YNOMBRE', 'OTRAS_DED', 'INDEMNIZ_Y'];
  const filas = recibos.map((rec) => {
    const c = clasificar(rec), ed = rec.edata || {};
    return [centroCosto(ed), centroOper(ed), rec.leg_num, rec.nom, c.OTRAS_DED, c.INDEMNIZ_Y];
  });
  const totEmb = r2(filas.reduce((s, f) => s + num(f[4]), 0));
  const totInd = r2(filas.reduce((s, f) => s + num(f[5]), 0));
  return { key: 'AP LIQUI', titulo: 'AP LIQUI', columnas, filas,
    resumen: [['EMBARGO', totEmb], ['INDEMNIZACIONES', totInd], ['TOTAL', r2(totEmb + totInd)]],
    nota: 'Apertura de otras deducciones e indemnizaciones que el asiento reclasifica.' };
}

// ASTO SUELDO: el asiento propiamente dicho, por cuenta × centro de costos × centro de operaciones.
function hojaAsiento(recibos, mapeo, fecha, sindicales) {
  const columnas = ['CODIGO CTA', 'DESCRIPCION', 'Centro de costos', 'Centro de operaciones',
    'IMPORTES', 'DEBITOS', 'CREDITOS', 'ASIENTO PARA IMPORTAR', 'NUMERO DE CUENTA'];
  // acumulador: cuenta|cc|co → importe (signo: + debe, − haber)
  const acc = new Map();
  const sinCuenta = new Set();
  // `alt` es la cuenta que trae el propio concepto (los del gremio la tienen):
  // se usa cuando la columna todavía no está mapeada, para que el asiento no
  // quede descuadrado por un concepto nuevo sin cuenta en el plan.
  const push = (columna, cc, co, importe, alt) => {
    if (!importe) return;
    const m = mapeo.get(`${columna}|${cc}`) || mapeo.get(`${columna}|`)
      || (alt ? { cuenta: alt, descripcion: columna } : null);
    if (!m) { sinCuenta.add(columna); return; }
    const k = `${m.cuenta}|${m.descripcion}|${cc}|${co}`;
    acc.set(k, r2(num(acc.get(k)) + importe));
  };

  for (const rec of recibos) {
    const ed = rec.edata || {}, cc = centroCosto(ed), co = centroOper(ed);
    const c = clasificar(rec), ct = clasificarContrib(rec);
    // El neto es el único importe que en la hoja Remun figura en positivo pero en
    // el asiento es un crédito (173 Remuneraciones a pagar): se invierte acá.
    for (const [col, val] of Object.entries(c)) push(col, cc, co, col === 'NETO' ? -val : val);
    push('CONTRIBUCIONES', cc, co, ct.TOTAL);
    push('CONT_SS', cc, co, -ct.TOTAL);
    // Conceptos del gremio: gasto en la cuenta de cargas sociales del centro de
    // costos y crédito en la cuenta propia de cada entidad.
    for (const [col, monto] of Object.entries(sindicalesDe(rec, sindicales))) {
      const alt = (sindicales.find((x) => x.columna === col) || {}).cuenta;
      push('CONTRIBUCIONES', cc, co, monto);
      push(col, cc, co, -monto, alt);
    }
  }

  const filas = [];
  for (const [k, importe] of acc) {
    const [cuenta, descripcion, cc, co] = k.split('|');
    const debe = importe > 0 ? r2(importe) : 0;
    const haber = importe < 0 ? r2(-importe) : 0;
    filas.push([cuenta, descripcion, cc, co, r2(importe), debe, haber, r2(importe), cuenta]);
  }
  filas.sort((a, b) => String(a[0]).localeCompare(String(b[0])) || String(a[2]).localeCompare(String(b[2])) || String(a[3]).localeCompare(String(b[3])));

  const totalDebe = r2(filas.reduce((s, f) => s + num(f[5]), 0));
  const totalHaber = r2(filas.reduce((s, f) => s + num(f[6]), 0));
  return { key: 'ASTO SUELDO', titulo: 'ASTO SUELDO', columnas, filas, fecha, sinCuenta: [...sinCuenta],
    totales: { debe: totalDebe, haber: totalHaber, diferencia: r2(totalDebe - totalHaber), balanceado: Math.abs(totalDebe - totalHaber) < 1 },
    nota: 'Asiento por cuenta, centro de costos y centro de operaciones. La columna "ASIENTO PARA IMPORTAR" lleva el importe con signo (+ débito / − crédito).' };
}

function hojaPlanCtas(asiento, mapeo) {
  const columnas = ['CONCEPTO', 'CUENTA', 'IMPORTE'];
  const porColumna = new Map();
  for (const [k, m] of mapeo) {
    const col = k.split('|')[0];
    if (!porColumna.has(col)) porColumna.set(col, m.cuenta);
  }
  const importes = new Map();
  for (const f of asiento.filas) importes.set(f[0], r2(num(importes.get(f[0])) + num(f[4])));
  const filas = [...porColumna.entries()].map(([col, cta]) => [col, cta, importes.get(cta) ?? 0]);
  return { key: 'TABLA PLAN CTAS', titulo: 'TABLA PLAN CTAS', columnas, filas,
    nota: 'Mapeo concepto de nómina → cuenta contable (editable desde esta pantalla).' };
}

function hojaAlicuotas(a) {
  return {
    key: 'TABLA ALICUOTAS', titulo: 'TABLA ALICUOTAS',
    columnas: ['DESCRIPCION', 'ALICUOTA CONTRIBUCION'],
    filas: [
      ['JUBILAC', a.sijp], ['LEY 19032', a.ley19032], ['ASIG FAM', a.afam],
      ['FDO NAC EMPLEO', a.fne], ['ANSSAL', a.anssal], ['O.SOCIAL', a.osPatronal],
      ['LRT FIJO', a.artFijo], ['LRT VARIABLE', a.artVariable],
    ],
    nota: 'Alícuotas vigentes tomadas de Parámetros de liquidación y del contrato de ART de cada empresa.',
  };
}

async function hojaCategorias() {
  const { rows } = await query(
    `SELECT cod_categoria, descripcion, hs_normal, hs_min_imp, di_min_imp, aplica_tope
       FROM categoria_params ORDER BY cod_categoria`).catch(() => ({ rows: [] }));
  const columnas = ['COD_CATEGO', 'DESCRIP', 'IMPORTE', 'ADICIONAL1', 'ADICIONAL2', 'HS_NORMAL', 'HS_MIN_IMP', 'DI_MIN_IMP', 'APLICATOPE'];
  // El importe sale de la escala salarial vigente si la categoría está adoptada.
  const esc = new Map();
  try {
    const e = await query(
      `SELECT data FROM escala_versiones ORDER BY vigencia_desde DESC LIMIT 1`);
    for (const c of (e.rows[0]?.data?.categorias || [])) esc.set(String(c.codigo || c.cod || '').toUpperCase(), num(c.basico ?? c.importe));
  } catch { /* sin escala cargada */ }
  const filas = rows.map((c) => [
    c.cod_categoria, c.descripcion, esc.get(String(c.cod_categoria).toUpperCase()) ?? 0, 0, 0,
    num(c.hs_normal), num(c.hs_min_imp), num(c.di_min_imp), c.aplica_tope ? 'S' : 'N',
  ]);
  return { key: 'CATEGORIAS', titulo: 'CATEGORIAS', columnas, filas,
    nota: 'Parámetros por categoría (horas normales, mínimos imponibles y tope). El importe sale de la escala vigente.' };
}

async function hojaTablaOS() {
  const { rows } = await query(
    `SELECT cod_os, nombre, por_aporte, imp_aporte, por_reten, imp_reten,
            direccion, localidad, cp, telefono
       FROM obras_sociales_aportes WHERE activo = true ORDER BY nombre`).catch(() => ({ rows: [] }));
  const columnas = ['COD_OS', 'NOMBRE_OS', 'POR_APORTE', 'IMP_APORTE', 'POR_RETEN', 'IMP_RETEN', 'DIRECCION', 'LOCALIDAD', 'COD_POS', 'TELEFONO'];
  const filas = rows.map((o) => [o.cod_os, o.nombre, num(o.por_aporte), num(o.imp_aporte),
    num(o.por_reten), num(o.imp_reten), o.direccion || '', o.localidad || '', o.cp || '', o.telefono || '']);
  return { key: 'TABLA OS', titulo: 'TABLA OS', columnas, filas,
    nota: 'Aportes y retenciones por obra social, con el código que lleva el legajo. Editable en Tablas auxiliares del asiento.' };
}

async function hojaDetalleGanancias(recibos) {
  const columnas = ['LEGAJO', 'AP_YNOMBRE', 'IMP_GCIAS (Retención)', 'CUIT'];
  const filas = recibos.map((rec) => [rec.leg_num, rec.nom, Math.abs(clasificar(rec).IMP_GCIAS), rec.cuil || '']);
  return { key: 'DETALLE GANANCIAS', titulo: 'DETALLE GANANCIAS', columnas, filas,
    nota: 'Retención del Impuesto a las Ganancias del período, por legajo.' };
}

async function hojaDetalleLiqOS(recibos) {
  const columnas = ['LEGAJO', 'APELLIDO_Y', 'HABERES', 'SAC', 'O_SOCIAL', 'OS_ADHERID', 'OS_ADIC', 'COD_OS', 'COD_PLAN', 'IMP_PLAN', 'ANTIG'];
  const filas = recibos.map((rec) => {
    const c = clasificar(rec), ed = rec.edata || {}, t = rec.data?.totales || {};
    const antig = ed.ing ? Math.max(0, new Date().getFullYear() - Number(String(ed.ing).slice(-4))) : '';
    return [rec.leg_num, rec.nom, num(t.totalRemun), c.SAC, Math.abs(c.O_SOCIAL), Math.abs(c.O_S_ADHE), Math.abs(c.O_S_ADIC), ed.cod_os || '', ed.codPlanOs || '', num(ed.impPlanOs), antig];
  });
  return { key: 'Detalle Liq OS', titulo: 'Detalle Liq OS', columnas, filas,
    nota: 'COD_PLAN e IMP_PLAN se cargan por legajo en la pantalla de centros y datos del asiento.' };
}

function hojaAportesPorSede(recibos, sedes, titulo, key) {
  const columnas = ['LEGAJO', 'AP_YNOMBRE', 'SINDICATO', 'APO_SINDIC', 'APO_OS_S_A'];
  const filas = [];
  for (const sede of sedes) {
    const delSede = recibos.filter((r) => centroOper(r.edata).toUpperCase().includes(sede));
    if (!delSede.length) continue;
    filas.push([sede, '', '', '', '']);
    for (const rec of delSede) {
      const c = clasificar(rec);
      filas.push([rec.leg_num, rec.nom, c.SINDICATO, c.APO_SINDIC, c.APO_OS_S_A]);
    }
  }
  return { key, titulo, columnas, filas, nota: 'Aportes sindicales agrupados por sede, para la DDJJ de cada seccional.' };
}

function hojaAportesUOM(recibos) {
  const columnas = ['LEGAJO', 'AP_YNOMBRE', 'SINDICATO', 'APO_SINDIC', 'APO_OS_S_A', 'BASE'];
  const filas = recibos
    .filter((r) => /uom|metal/i.test(String(r.edata?.cod_sindicato || '')))
    .map((rec) => {
      const c = clasificar(rec), t = rec.data?.totales || {};
      return [rec.leg_num, rec.nom, c.SINDICATO, c.APO_SINDIC, c.APO_OS_S_A, -num(t.totalRemun)];
    });
  return { key: 'Tabla Aportes Personal UOM', titulo: 'Tabla Aportes Personal UOM', columnas, filas,
    nota: 'Personal encuadrado en UOM (aporte solidario, seguro de vida colectivo y contribuciones no remunerativas).' };
}

async function hojaAnticipos(recibos, anio, mes) {
  const columnas = ['LEGAJO', 'AP_YNOMBRE', 'Anticipos de Sueldo'];
  const filas = recibos.map((rec) => [rec.leg_num, rec.nom, clasificar(rec).ANT_SDO_PR]);
  return { key: 'ANTICIPOS SUELDOS', titulo: 'ANTICIPOS SUELDOS', columnas, filas,
    nota: `Adelantos descontados en la liquidación ${String(mes).padStart(2, '0')}/${anio}.` };
}

function hojaRetSuss() {
  return {
    key: 'RETENCIONES SUSS SUFRIDAS', titulo: 'RETENCIONES SUSS SUFRIDAS',
    columnas: ['COD_CTA', 'DESC_CTA', 'COD_MONEDA', 'SIGLA_MONE', 'DESC_MONE', 'FECHA', 'COD_COMP', 'N_COMP', 'BARRA', 'LEYENDA', 'DEBE', 'HABER', 'SALDO'],
    filas: [],
    nota: 'Hoja de carga manual: las retenciones SUSS sufridas las informa Contabilidad, no salen de la liquidación.',
  };
}

// ── Parámetros / alícuotas ──────────────────────────────────────────────────
async function leerAlicuotas(empresa) {
  const p = (await query('SELECT data FROM parametros_liq WHERE id=1')).rows[0]?.data || {};
  let artFijo = 0, artVariable = num(p.pctArt);
  try {
    const a = (await query(
      `SELECT ac.alicuotas FROM art_contratos ac JOIN empresas em ON em.id = ac.empresa_id
        WHERE ac.activo = true ${empresa ? 'AND em.nombre = $1' : ''} ORDER BY ac.fecha_inicio DESC LIMIT 1`,
      empresa ? [empresa] : [])).rows[0];
    const ult = Array.isArray(a?.alicuotas) ? a.alicuotas[a.alicuotas.length - 1] : null;
    if (ult) { artVariable = num(ult.pct) || artVariable; artFijo = num(ult.fijo); }
  } catch { /* sin contrato de ART cargado */ }
  return {
    sijp: num(p.pctJubPatronal), ley19032: num(p.pctPamiPatronal), fne: num(p.pctDesempleo),
    afam: num(p.pctAsigFam), anssal: num(p.pctAnssalPatronal), osPatronal: num(p.pctOsPatronal),
    artVariable, artFijo,
  };
}

async function leerSindicales() {
  await migrarAsientoAux();
  const { rows } = await query(
    `SELECT columna, descripcion, cod_sindicato, tipo, base, pct, importe, cuenta, confirmado, nota
       FROM conceptos_sindicales WHERE activo = true ORDER BY columna`);
  return rows;
}

async function leerMapeo() {
  await migrarAsiento();
  const { rows } = await query(
    'SELECT columna, centro_costo, cuenta, descripcion, naturaleza, orden FROM asiento_cuentas WHERE activo = true ORDER BY orden');
  const m = new Map();
  for (const r of rows) m.set(`${r.columna}|${r.centro_costo || ''}`, r);
  return m;
}

// ── Detección de datos faltantes ────────────────────────────────────────────
function detectarFaltantes(recibos, mapeo, alicuotas, sindicales, asiento) {
  const f = [];
  const sinCC = recibos.filter((r) => !centroCosto(r.edata));
  const sinCO = recibos.filter((r) => !centroOper(r.edata));
  const sinBases = recibos.filter((r) => !r.data?.bases);
  if (sinCC.length) f.push({ nivel: 'bloqueante', dato: 'Centro de costos del legajo',
    detalle: `${sinCC.length} de ${recibos.length} legajos no lo tienen cargado. Sin este dato el asiento no se puede abrir por cuenta de resultado.`,
    ejemplos: sinCC.slice(0, 8).map((r) => `${r.leg_num} ${r.nom}`) });
  if (sinCO.length) f.push({ nivel: 'bloqueante', dato: 'Centro de operaciones del legajo',
    detalle: `${sinCO.length} legajos sin centro de operaciones (sucursal). Es la segunda apertura del asiento.`,
    ejemplos: sinCO.slice(0, 8).map((r) => `${r.leg_num} ${r.nom}`) });
  if (sinBases.length) f.push({ nivel: 'alto', dato: 'Bases imponibles del recibo (Rem. 1 a 11)',
    detalle: `${sinBases.length} recibos no guardan las bases imponibles. Hoy se calculan al generar el F.931/SICOSS pero no se persisten en el recibo, así que la hoja Contribuciones queda incompleta.` });
  if (!mapeo.size) f.push({ nivel: 'bloqueante', dato: 'Plan de cuentas del asiento', detalle: 'No hay cuentas mapeadas.' });
  if (asiento?.sinCuenta?.length) f.push({ nivel: 'bloqueante', dato: 'Columnas sin cuenta contable',
    detalle: `Estas columnas tienen importe pero ninguna cuenta asignada, así que quedaron fuera del asiento: ${asiento.sinCuenta.join(', ')}.` });
  if (!alicuotas.sijp || !alicuotas.artVariable) f.push({ nivel: 'medio', dato: 'Alícuotas de contribuciones / ART',
    detalle: 'Falta completar alícuotas patronales en Parámetros de liquidación o el contrato de ART vigente de la empresa.' });
  const sinCuil = recibos.filter((r) => !r.cuil);
  if (sinCuil.length) f.push({ nivel: 'medio', dato: 'CUIT/CUIL del legajo',
    detalle: `${sinCuil.length} legajo(s) sin CUIL. En el Excel esto aparece como #N/A en DETALLE GANANCIAS.`,
    ejemplos: sinCuil.slice(0, 8).map((r) => `${r.leg_num} ${r.nom}`) });

  const sinConfirmar = (sindicales || []).filter((c) => !c.confirmado);
  if (sinConfirmar.length) f.push({ nivel: 'medio', dato: 'Conceptos del gremio sin confirmar',
    detalle: `${sinConfirmar.length} concepto(s) sindicales tienen valores tomados del Excel de agosto 2026 y todavía no se validaron contra el convenio: ${sinConfirmar.map((c) => c.descripcion).join(' · ')}.` });

  const sinPlanOs = recibos.filter((r) => !r.edata?.codPlanOs);
  if (sinPlanOs.length) f.push({ nivel: 'bajo', dato: 'Plan de obra social del legajo',
    detalle: `${sinPlanOs.length} legajo(s) sin COD_PLAN/IMP_PLAN. Sólo afecta a la hoja Detalle Liq OS.` });
  f.push({ nivel: 'bajo', dato: 'Retenciones SUSS sufridas',
    detalle: 'Dato de Contabilidad: no se genera en RR.HH. Se deja como hoja de carga manual.' });
  return f;
}

// ─────────────────────────────────────────────────────────────────────────────
export async function construirLibro({ anio, mes, empresa }) {
  const recibos = await recibosDelPeriodo(anio, mes, empresa);
  const [mapeo, alicuotas, sindicales] = await Promise.all([leerMapeo(), leerAlicuotas(empresa), leerSindicales()]);
  const fecha = new Date(Number(anio), Number(mes), 0).toISOString().slice(0, 10);  // último día del mes

  const asiento = hojaAsiento(recibos, mapeo, fecha, sindicales);
  const hojas = [
    hojaApLiqui(recibos),
    asiento,
    hojaRemun(recibos),
    await hojaCategorias(),
    hojaContribuciones(recibos, alicuotas, sindicales),
    hojaPlanCtas(asiento, mapeo),
    hojaAlicuotas(alicuotas),
    hojaRetSuss(),
    await hojaTablaOS(),
    await hojaDetalleGanancias(recibos),
    await hojaDetalleLiqOS(recibos),
    hojaAportesPorSede(recibos, ['ROSARIO', 'CORDOBA', 'CÓRDOBA', 'MENDOZA'], 'Tabla Aportes ROS-CORD-MEND', 'Tabla Aportes ROS-CORD-MEND'),
    hojaAportesUOM(recibos),
    await hojaAnticipos(recibos, anio, mes),
  ];

  return {
    periodo: { anio: Number(anio), mes: Number(mes), empresa: empresa || 'Todas', fecha },
    resumen: { legajos: recibos.length, ...asiento.totales },
    hojas,
    faltantes: detectarFaltantes(recibos, mapeo, alicuotas, sindicales, asiento),
  };
}

export default { construirLibro };
