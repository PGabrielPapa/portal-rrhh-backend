// Liquidación por PRODUCCIÓN (premios/contratos) — PARALELA a la del convenio.
// Reglas (según el Excel de Novedades, hoja LIQUIDACION):
//   • Valor jornal = valor hora de producción (ya con presentismo) × 8 hs.
//   • Básico = jornal × días normales trabajados.
//   • Extra semana y sábado = valor hora × 1,5 × horas. Domingo y feriado = valor hora × 2 × horas.
//   • Se suman Bono, Retroactivo, SAC y "diferencia liq. anterior".
//   • Ajustes (+/-): herramientas perdidas, préstamos, etc. (negativo = descuento).
//   • Contratos: se totalizan APARTE → "Total con contrato".
//   • TODO es bruto = neto: esta liquidación NO descuenta aportes ni contribuciones.
import { query } from '../db.js';

const JORNADA_PROD_HS = 8;
const r2 = (x) => Math.round((Number(x) || 0) * 100) / 100;
const n = (x) => Number(x) || 0;

// Valor hora + jornada (8/9 hs) de producción vigentes para un empleado a una fecha
// (el registro más reciente ≤ fecha).
export async function valorProd(empleadoId, fechaISO) {
  if (!empleadoId) return { valorHora: 0, jornadaHoras: JORNADA_PROD_HS };
  const { rows } = await query(
    `SELECT valor_hora, jornada_horas FROM prod_valor_hora WHERE empleado_id=$1 AND vigencia<=$2 ORDER BY vigencia DESC LIMIT 1`,
    [empleadoId, fechaISO]);
  if (!rows[0]) return { valorHora: 0, jornadaHoras: JORNADA_PROD_HS };
  return { valorHora: Number(rows[0].valor_hora), jornadaHoras: Number(rows[0].jornada_horas) || JORNADA_PROD_HS };
}

// De los días de fichadas saca las cantidades (editable después): días normales y horas
// extra por tipo de día. Producción usa jornada de 8 hs como umbral.
export function horasProdDesdeFichadas(dias, jornadaHs = JORNADA_PROD_HS) {
  let diasNormales = 0, hsSemana = 0, hsSabado = 0, hsDomingo = 0, hsFeriado = 0;
  const cap = jornadaHs * 60;
  for (const d of (dias || [])) {
    const neto = n(d.hsNetasMin); if (neto <= 0) continue;
    if (d.tipoDia === 'sabado') { hsSabado += neto / 60; continue; }
    if (d.tipoDia === 'domingo') { hsDomingo += neto / 60; continue; }
    if (d.tipoDia === 'feriado') { hsFeriado += neto / 60; continue; }
    diasNormales += 1;                        // día hábil trabajado = 1 jornada
    if (neto > cap) hsSemana += (neto - cap) / 60;  // excedente = extra de semana
  }
  return { diasNormales, hsSemana: r2(hsSemana), hsSabado: r2(hsSabado), hsDomingo: r2(hsDomingo), hsFeriado: r2(hsFeriado) };
}

// Calcula la liquidación de producción de un empleado. Sin aportes ni contribuciones.
export function calcProduccion(inp) {
  const vh = n(inp.valorHora);
  const jh = inp.jornadaHoras || JORNADA_PROD_HS;
  const jornal = vh * jh;
  const basico = r2(jornal * n(inp.diasNormales));
  const extraSemana = r2(vh * 1.5 * n(inp.hsSemana));
  const sabado = r2(vh * 1.5 * n(inp.hsSabado));
  const domingo = r2(vh * 2 * n(inp.hsDomingo));
  const feriado = r2(vh * 2 * n(inp.hsFeriado));
  const bono = r2(inp.bono), retro = r2(inp.retro), sac = r2(inp.sac), difAnterior = r2(inp.difAnterior);
  const ajustesTotal = r2((inp.ajustes || []).reduce((s, a) => s + n(a.monto), 0)); // +/-
  const contratosTotal = r2((inp.contratos || []).reduce((s, c) => s + n(c.monto), 0));
  const totalSinContrato = r2(basico + extraSemana + sabado + domingo + feriado + bono + retro + sac + difAnterior + ajustesTotal);
  const totalConContrato = r2(totalSinContrato + contratosTotal);
  return {
    valorHora: vh, jornal: r2(jornal),
    basico, extraSemana, sabado, domingo, feriado,
    bono, retro, sac, difAnterior, ajustesTotal, contratosTotal,
    totalSinContrato, totalConContrato,
  };
}
