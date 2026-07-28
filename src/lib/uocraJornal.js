// Liquidación de JORNAL UOCRA (CCT 76/75 / 577/10).
// Reglas acordadas con RR.HH. (jul-2026), validadas contra recibo real:
//   • Haber = valor hora (por categoría/zona) × horas trabajadas de la quincena (de fichadas).
//     Hasta la jornada (9 h/día) es normal; lo que supera va a extra (50 % hábil/sábado, 100 % dom/feriado). SIN banco.
//   • Premio asistencia = 20 % de horas trabajadas, solo si NO hay ausencias injustificadas.
//   • Horas feriado (feriado NO trabajado) = valor hora × jornada × 30 ÷ 25 por cada feriado.
//   • SNR (bono no remunerativo) se paga por mitades en cada quincena; lleva Obra Social 3 %.
//   • Aportes: Jubilación 11 %, Ley 19.032 (PAMI) 3 %, Obra Social 3 % s/remunerativo;
//     Sindicato 2,5 % (afiliado) o Aporte solidario 2 % (no afiliado).
// Quincenas fijas: 1ª = 1–15; 2ª = 16–fin de mes.
import { query } from '../db.js';

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
export const JORNADA_JORNAL_HS = 9;      // parámetro global: hasta 9 h/día se paga como normal
const UMBRAL_MIN = 30;                    // mismo umbral de extra que el control de fichadas

// Escala vigente para una categoría/zona a una fecha dada (la de mayor vigencia <= fecha).
export async function escalaUOCRA(categoria, zona = 'A', fechaISO, cct = '76/75') {
  const { rows } = await query(
    `SELECT valor_hora, mensual, snr FROM uocra_escala
      WHERE cct=$1 AND categoria=$2 AND zona=$3 AND vigencia <= $4
      ORDER BY vigencia DESC LIMIT 1`,
    [cct, categoria, zona, fechaISO]);
  if (!rows[0]) return null;
  return { valorHora: Number(rows[0].valor_hora) || 0, mensual: Number(rows[0].mensual) || 0, snr: Number(rows[0].snr) || 0 };
}

// Rango de la quincena (1 = 1–15; 2 = 16–fin de mes) → { desde, hasta } YYYY-MM-DD.
export function rangoQuincena(anio, mes, quincena) {
  const mm = String(mes).padStart(2, '0');
  if (Number(quincena) === 1) return { desde: `${anio}-${mm}-01`, hasta: `${anio}-${mm}-15` };
  const ultimo = new Date(anio, mes, 0).getDate();
  return { desde: `${anio}-${mm}-16`, hasta: `${anio}-${mm}-${String(ultimo).padStart(2, '0')}` };
}

// De los días de fichadas (detalle del período) saca horas normales y extra del JORNAL.
// Sin banco: cada día suma lo trabajado hasta la jornada como normal, y el excedente como extra.
//   dias: [{ saldoMin?, hsNetasMin, tipoDia, estado, ... }]  (hsNetasMin = neto trabajado del día)
export function horasJornalDesdeFichadas(dias, jornadaMin = JORNADA_JORNAL_HS * 60) {
  let normalMin = 0, extra50Min = 0, extra100Min = 0;
  for (const d of (dias || [])) {
    const neto = Number(d.hsNetasMin) || 0;
    if (neto <= 0) continue;
    const t = d.tipoDia;
    if (t === 'sabado') { extra50Min += neto; continue; }              // sábado → todo extra 50 %
    if (t === 'domingo' || t === 'feriado') { extra100Min += neto; continue; } // dom/feriado → 100 %
    // Día hábil: hasta la jornada = normal; excedente > 30 min = extra 50 %.
    const norm = Math.min(neto, jornadaMin);
    const exc = neto - norm;
    normalMin += norm;
    if (exc > UMBRAL_MIN) extra50Min += exc;
    else normalMin += exc; // excedente chico: se paga como hora normal (no llega a extra)
  }
  return { normalMin, extra50Min, extra100Min };
}

// Arma el recibo del jornal. `inp` en HORAS (no minutos) y valorHora ya de la zona.
export function calcReciboJornal(inp) {
  const vh = Number(inp.valorHora) || 0;
  const jorHs = inp.jornadaHoras || JORNADA_JORNAL_HS;
  const horasTrab = r2(vh * (inp.horasNormales || 0));                  // 50 Horas trabajadas
  const premio = (inp.injustificadas || 0) === 0 ? r2(horasTrab * 0.20) : 0; // 110 Premio asistencia
  const feriado = r2((inp.feriadosNoTrab || 0) * vh * jorHs * 30 / 25); // 121 Horas feriado
  const extra50 = r2(vh * 1.5 * (inp.hsExtra50 || 0));
  const extra100 = r2(vh * 2 * (inp.hsExtra100 || 0));
  const totalRem = r2(horasTrab + premio + feriado + extra50 + extra100);

  const jub = r2(totalRem * 0.11);
  const pami = r2(totalRem * 0.03);
  const os = r2(totalRem * 0.03);
  const sind = inp.afiliado ? r2(totalRem * 0.025) : r2(totalRem * 0.02); // afiliado 2,5 % / no afiliado 2 %
  const sindLabel = inp.afiliado ? 'Cuota sindical UOCRA 2,5%' : 'Aporte solidario UOCRA 2%';

  const bonoNR = r2((inp.snr || 0) * (inp.quincena ? 0.5 : 1));          // SNR por mitades por quincena
  const osNR = r2(bonoNR * 0.03);                                        // Obra social s/ no remunerativo

  const totalDeduc = r2(jub + pami + os + sind + osNR);
  const neto = r2(totalRem + bonoNR - totalDeduc);

  // Mismas claves que el motor mensual: haberes {concepto, tipo, monto}; descuentos {concepto, monto}.
  const hn = r2(inp.horasNormales || 0);
  const haberes = [
    { concepto: `Horas trabajadas (${hn} hs × ${vh})`, tipo: 'rem', monto: horasTrab },
  ];
  if (premio > 0) haberes.push({ concepto: 'Premio asistencia (20%)', tipo: 'rem', monto: premio });
  if (feriado > 0) haberes.push({ concepto: `Horas feriado (${inp.feriadosNoTrab})`, tipo: 'rem', monto: feriado });
  if (extra50 > 0) haberes.push({ concepto: `Horas extra 50% (${inp.hsExtra50} hs)`, tipo: 'rem', monto: extra50 });
  if (extra100 > 0) haberes.push({ concepto: `Horas extra 100% (${inp.hsExtra100} hs)`, tipo: 'rem', monto: extra100 });
  if (bonoNR > 0) haberes.push({ concepto: 'Bono no remunerativo (acuerdo UOCRA)', tipo: 'norem', monto: bonoNR });

  const descuentos = [
    { concepto: 'Jubilación', monto: jub },
    { concepto: 'Ley 19.032 (INSSJP)', monto: pami },
    { concepto: 'Obra Social', monto: os },
    { concepto: sindLabel, monto: sind },
  ];
  if (osNR > 0) descuentos.push({ concepto: 'Obra Social s/ No Remunerativo', monto: osNR });

  return {
    modo: 'jornal-uocra', valorHora: vh,
    haberes, descuentos,
    totales: {
      totalRemun: totalRem, totalNoRem: bonoNR, totalExento: 0,
      totalHaberes: r2(totalRem + bonoNR), totalDescuentos: totalDeduc, neto,
    },
    // Aportes del trabajador para el detalle de cargas (Decreto 407/2026).
    aportes: { jub, os, pami, sind, osNR },
  };
}
