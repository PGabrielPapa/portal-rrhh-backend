// Verificación y actualización automática de las escalas salariales de convenio
// (escala unificada + escalas por sindicato), con histórico de adopción por período.
// Mismo espíritu que valores legales / F.931 / SICORE: se adopta la versión VIGENTE
// para el período que se liquida y se deja registro, sin pisar las versiones cargadas.
import { query } from '../db.js';

const dd = (n) => String(n).padStart(2, '0');
const periodoStr = (anio, mes) => `${anio}-${dd(mes)}`;
// Fecha de referencia del período (mitad de mes) para resolver la vigencia.
const fechaRef = (anio, mes) => `${anio}-${dd(mes)}-15`;

// Escala unificada vigente a una fecha (la de mayor vigencia <= fecha).
export async function escalaUnificadaVigente(fechaISO) {
  const r = await query('SELECT * FROM escala_versiones WHERE vigencia <= $1 ORDER BY vigencia DESC, created_at DESC LIMIT 1', [fechaISO]);
  if (r.rows[0]) return r.rows[0];
  // fallback: la más antigua cargada (por si la vigencia inicial es posterior)
  const fb = await query('SELECT * FROM escala_versiones ORDER BY vigencia ASC, created_at ASC LIMIT 1');
  return fb.rows[0] || null;
}

// Escalas por sindicato vigentes a una fecha (una por convenio, la última con vigencia <= fecha).
export async function conveniosVigentes(fechaISO) {
  const r = await query(
    `SELECT DISTINCT ON (cv.codigo) cv.codigo, cv.vigencia, cv.mes_label, cv.porcentaje, cv.origen, c.nombre
       FROM convenio_versiones cv LEFT JOIN convenios c ON c.codigo = cv.codigo
      WHERE cv.vigencia <= $1
      ORDER BY cv.codigo, cv.vigencia DESC, cv.created_at DESC`, [fechaISO]);
  return r.rows.map((x) => ({ codigo: x.codigo, nombre: x.nombre || x.codigo, vigencia: x.vigencia, mesLabel: x.mes_label, porcentaje: x.porcentaje, origen: x.origen }));
}

function resumenDeEscala(esc) {
  if (!esc) return null;
  const d = esc.data || {};
  const nCategorias = Array.isArray(d.categorias) ? d.categorias.length : 0;
  const nTramos = Array.isArray(d.tramos) ? d.tramos.length : (d.categorias?.[0]?.tramos ? Object.keys(d.categorias[0].tramos).length : 0);
  return { id: esc.id, vigencia: esc.vigencia, mesLabel: esc.mes_label, origen: esc.origen, porcentaje: esc.porcentaje, nCategorias, nTramos };
}

// Arma el resumen de lo que se aplicaría en el período (escala unificada + convenios).
export async function resumenEscalaPeriodo(anio, mes) {
  const fecha = fechaRef(anio, mes);
  const esc = await escalaUnificadaVigente(fecha);
  const convenios = await conveniosVigentes(fecha);
  return { periodo: periodoStr(anio, mes), escala: resumenDeEscala(esc), convenios, _escRow: esc };
}

// Última adopción registrada para un período (o null).
async function ultimaAdopcion(periodo) {
  const r = await query('SELECT * FROM escala_adopciones WHERE periodo=$1 ORDER BY created_at DESC LIMIT 1', [periodo]);
  return r.rows[0] || null;
}

// Verificación (para la pantalla de liquidación, antes de la corrida). No modifica nada.
export async function verificarEscalas(anio, mes) {
  const res = await resumenEscalaPeriodo(anio, mes);
  const periodoAnt = mes === 1 ? periodoStr(anio - 1, 12) : periodoStr(anio, mes - 1);
  const adopAnt = await ultimaAdopcion(periodoAnt);

  let cambio = { hayCambio: false, texto: 'Sin cambios respecto al período anterior.' };
  if (res.escala && adopAnt && adopAnt.escala_version_id && adopAnt.escala_version_id !== res.escala.id) {
    const pct = res.escala.origen === 'incremento' && res.escala.porcentaje ? ` (+${Number(res.escala.porcentaje)}%)` : '';
    cambio = { hayCambio: true, texto: `La escala unificada se actualizó a la vigente desde ${res.escala.mesLabel || res.escala.vigencia}${pct}.` };
  } else if (res.escala && !adopAnt) {
    cambio = { hayCambio: true, texto: `Se aplicará la escala unificada vigente desde ${res.escala.mesLabel || res.escala.vigencia}.` };
  }

  const hayEscala = !!res.escala;
  const mensaje = hayEscala
    ? `Escala unificada vigente para ${res.periodo}: ${res.escala.mesLabel || res.escala.vigencia} — ${res.escala.nCategorias} categoría(s). ${cambio.texto}`
    : 'No hay una escala salarial unificada cargada. Cargá la escala en "Escala salarial" antes de liquidar (se usará el básico cargado en cada legajo).';

  return { periodo: res.periodo, hayEscala, alerta: !hayEscala, escala: res.escala, convenios: res.convenios, cambio, mensaje };
}

// Adopta (registra) la escala vigente para el período. Idempotente por (periodo, versión):
// si esa versión ya fue adoptada en el período, no duplica. Mantiene histórico.
export async function autoActualizarEscalas(anio, mes, opts = {}) {
  const res = await resumenEscalaPeriodo(anio, mes);
  if (!res.escala) return { periodo: res.periodo, adoptada: false, escala: null, convenios: res.convenios, cambio: { hayCambio: false, texto: 'Sin escala unificada cargada.' } };
  const ver = await verificarEscalas(anio, mes);
  const resumen = { nCategorias: res.escala.nCategorias, nTramos: res.escala.nTramos, origen: res.escala.origen, porcentaje: res.escala.porcentaje, convenios: res.convenios.map((c) => ({ codigo: c.codigo, vigencia: c.vigencia, mesLabel: c.mesLabel })) };
  const ins = await query(
    `INSERT INTO escala_adopciones (periodo, escala_version_id, vigencia, mes_label, resumen, adoptado_por)
     VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (periodo, escala_version_id) DO NOTHING RETURNING id`,
    [res.periodo, res.escala.id, res.escala.vigencia, res.escala.mesLabel || null, JSON.stringify(resumen), opts.adoptadoPor || 'auto']);
  return { periodo: res.periodo, adoptada: ins.rowCount > 0, escala: res.escala, convenios: res.convenios, cambio: ver.cambio };
}

// Verificación mensual/al arranque: adopta la vigente del mes en curso. Devuelve texto para log.
export async function verificacionMensualEscalas(opts = {}) {
  const d = new Date();
  const r = await autoActualizarEscalas(d.getFullYear(), d.getMonth() + 1, { adoptadoPor: opts.adoptadoPor || 'auto-mensual' });
  return r;
}
