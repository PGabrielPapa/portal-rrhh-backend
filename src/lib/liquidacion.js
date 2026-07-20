// Motor de liquidación — incluye: haberes (básico, antigüedad, presentismo,
// complemento, no rem), SAC (jun/dic), aportes del trabajador, contribuciones
// patronales + SCVO (costo del empleador), y Ganancias 4ª con tope del 35%
// (estimación anualizada). Pendiente: embargos, regímenes especiales, SIRADIG.
import { evaluarFormula } from './formulas.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let GAN = { mniAnual: 0, dedEspAnual: 0, dedEsp2Anual: 0, escala: [] };
try { GAN = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'ganancias.seed.json'), 'utf8')); } catch { /* defaults */ }

// Períodos de Ganancias con su vigencia (para resolver por fecha de pago, como la vanilla).
// Si el seed trae `periodos`, se usan; si no, se arma uno desde los campos planos.
function _vigDesdePeriodo(p) {
  const m = /(\d{4})-S([12])/.exec(p || '');
  if (m) return `${m[1]}-${m[2] === '1' ? '01' : '07'}-01`;
  return '2000-01-01';
}
const GAN_PERIODOS = (Array.isArray(GAN.periodos) && GAN.periodos.length)
  ? GAN.periodos.map((p) => ({ ...p, vigenciaDesde: p.vigenciaDesde || _vigDesdePeriodo(p.periodo) }))
  : [{ ...GAN, vigenciaDesde: _vigDesdePeriodo(GAN.periodo) }];

// Devuelve la tabla de Ganancias vigente a la fecha (la de mayor vigenciaDesde <= fecha).
function ganParaFecha(fechaISO) {
  const ref = String(fechaISO || '').slice(0, 10) || '2100-12-31';
  const aplic = GAN_PERIODOS.filter((p) => p.vigenciaDesde <= ref).sort((a, b) => a.vigenciaDesde.localeCompare(b.vigenciaDesde));
  return aplic.length ? aplic[aplic.length - 1] : GAN_PERIODOS.slice().sort((a, b) => a.vigenciaDesde.localeCompare(b.vigenciaDesde))[0];
}

const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : 0; };
const round2 = (n) => { const s = n < 0 ? -1 : 1; return s * Math.round((Math.abs(n) + Number.EPSILON) * 100) / 100; };

function aniosAntiguedad(ingreso, anio, mes) {
  if (!ingreso) return 0;
  const ing = new Date(String(ingreso).slice(0, 10) + 'T12:00:00'); if (isNaN(ing)) return 0;
  const ref = new Date(anio, mes - 1, 1);
  let a = ref.getFullYear() - ing.getFullYear();
  if (ref.getMonth() < ing.getMonth()) a--;
  return Math.max(0, a);
}

// Impuesto anual según escala progresiva (Art. 94 LIG)
export function impuestoEscala(base, escala) {
  if (base <= 0 || !escala?.length) return 0;
  for (const t of escala) {
    const hasta = t.hasta == null ? Infinity : t.hasta;
    if (base > t.desde && base <= hasta) return t.fijo + (base - t.desde) * t.alicuota / 100;
  }
  const last = escala[escala.length - 1];
  return last.fijo + (base - last.desde) * last.alicuota / 100;
}

// RG 4003 (Anexo II, ap. B) — remuneraciones NO habituales (plus vacacional,
// gratificaciones, ajustes de años anteriores; EXCEPTO SAC): se imputan en forma
// proporcional al mes de pago y a los meses que restan hasta concluir el año fiscal.
// Devuelve el factor [0..1] para el mes `mesActual` de un pago hecho en `mesPago`.
export function factorNoHabitual(mesPago, mesActual) {
  const k = Number(mesPago), m = Number(mesActual);
  if (!k || k < 1 || k > 12) return 1;
  const restantes = 13 - k;                                   // meses desde el pago hasta diciembre (inclusive)
  const transcurridos = Math.min(restantes, Math.max(0, m - k + 1));
  return restantes > 0 ? transcurridos / restantes : 1;
}

// Clasificación de tipos de liquidación para Ganancias 4ª (RG 4003 Anexo II):
export const TIPOS_SAC = ['sac1', 'sac2'];                  // Apartado C - Sueldo Anual Complementario
export const TIPOS_NO_HABITUAL_B = ['complementaria'];      // Apartado B - no habituales (ajustes/gratificaciones)
// (mensual/quincenal/vacaciones = remuneración habitual, Apartado A)

// Núcleo del cálculo acumulado de Ganancias 4ª conforme RG 4003 (Anexo II):
//  A) remuneración habitual; B) no habituales imputadas en forma proporcional a fin
//  de año (excepto SAC); C) SAC = una doceava parte (1/12) de (A+B) cada mes, con
//  1/12 de las deducciones; el SAC realmente abonado se reconoce sólo en la
//  liquidación anual/final (anualizada), sin computar el 1/12.
export function calcularGananciasAcum(comp) {
  const G = comp.ganTabla || {};
  const anualizada = !!comp.anualizada;
  const meses = anualizada ? 12 : Number(comp.mes);
  const prop = anualizada ? 1 : Math.min(1, Math.max(0, meses / 12));

  const gravadoBase = num(comp.habitual) + (anualizada ? num(comp.noHabFull) : num(comp.noHabPro));
  const aportesBase = num(comp.aporHabitual) + (anualizada ? num(comp.aporNoHabFull) : num(comp.aporNoHabPro));

  // Apartado C — SAC
  let sacProv, sacDed;
  if (anualizada) { sacProv = num(comp.sacReal); sacDed = num(comp.aporSacReal); }   // SAC realmente percibido
  else { sacProv = gravadoBase / 12; sacDed = aportesBase / 12; }                     // 1/12 mensual
  const gravadoTotal = gravadoBase + sacProv;
  const aportesTotal = aportesBase + sacDed;

  const cargasFamAnual = (comp.tieneConyuge ? num(G.cargaConyugeAnual) : 0)
    + num(comp.nroHijosMenores) * num(G.cargaHijoAnual)
    + num(comp.nroHijosIncapacitados) * num(G.cargaHijoIncAnual);
  const mni = num(G.mniAnual) * prop;
  const dedEsp = num(G.dedEspAnual) * prop;
  const dedEsp2 = num(G.dedEsp2Anual) * prop;
  const cargasDed = cargasFamAnual * prop;
  const dedVol = num(comp.dedVoluntariasAnual) * prop;
  const dedSir = num(comp.dedSiradigAcum); // SiRADIG: deducciones ya acumuladas del período (no se prorratean)

  const remSujeta = Math.max(0, gravadoTotal - aportesTotal - mni - dedEsp - dedEsp2 - cargasDed - dedVol - dedSir);
  const impDet = (prop > 0 && prop < 1)
    ? round2(impuestoEscala(remSujeta / prop, G.escala) * prop)
    : round2(impuestoEscala(remSujeta, G.escala));
  const retenidoAnterior = num(comp.retenidoAcum);
  const retencionPeriodo = round2(impDet - retenidoAnterior);

  return {
    mesesTranscurridos: meses, anualizada,
    remGravAcum: round2(gravadoTotal),
    gravadoBase: round2(gravadoBase), sacProvision: round2(sacProv), gravadoTotal: round2(gravadoTotal),
    aportesAcum: round2(aportesTotal), aportesBase: round2(aportesBase), sacDeduccion: round2(sacDed),
    mni: round2(mni), dedEspecial: round2(dedEsp), dedEspecial2: round2(dedEsp2),
    cargasFamilia: round2(cargasDed), dedVoluntarias: round2(dedVol), dedSiradig: round2(dedSir),
    remSujeta: round2(remSujeta), impuestoDeterminado: round2(impDet),
    retenidoAnterior: round2(retenidoAnterior), retencionPeriodo, periodo: G.periodo || null,
  };
}

// Nota: el F.1357 (Impuesto a las Ganancias) se arma en routes/ganancias.routes.js
// (f1357For), que ya integra SiRADIG, topes RG 4003 y acumulados. La función previa
// calcularF1357 se eliminó por estar sin uso y con un bug de scope (referencia a opts).

// ── Helpers de liquidación final (indemnizaciones) ──
function diasEntreFechas(a, b) { return Math.floor((b - a) / 86400000) + 1; }
function parseDate(s) { if (!s) return null; const d = new Date(String(s).slice(0, 10) + 'T12:00:00'); return isNaN(d) ? null : d; }

function calcSacProporcional(ingreso, fechaEgreso, mejorRem) {
  const fEg = parseDate(fechaEgreso); if (!fEg) return { monto: 0, dias: 0 };
  const anio = fEg.getFullYear(), mes = fEg.getMonth() + 1;
  const sem = mes <= 6 ? 1 : 2;
  const inicioSem = new Date(anio, sem === 1 ? 0 : 6, 1, 12);
  const fIng = parseDate(ingreso) || inicioSem;
  const inicio = fIng > inicioSem ? fIng : inicioSem;
  const dias = diasEntreFechas(inicio, fEg);
  return { monto: (mejorRem / 2) * (dias / 180), dias, semestre: sem };
}
function calcPreaviso(ingreso, fechaEgreso, bruto) {
  const fEg = parseDate(fechaEgreso), fIng = parseDate(ingreso);
  if (!fEg || !fIng) return { meses: 0, dias: 0, monto: 0 };
  const meses = (fEg.getFullYear() - fIng.getFullYear()) * 12 + (fEg.getMonth() - fIng.getMonth());
  let mP = 0, dP = 0;
  if (meses < 3) { mP = 0; dP = 15; } else if (meses < 60) { mP = 1; } else { mP = 2; }
  return { meses: mP, dias: dP, monto: mP * bruto + dP * (bruto / 30), antiguedadMeses: meses };
}
function calcIntegracionMes(fechaEgreso, bruto) {
  const fEg = parseDate(fechaEgreso); if (!fEg) return { dias: 0, monto: 0 };
  const ult = new Date(fEg.getFullYear(), fEg.getMonth() + 1, 0).getDate();
  const dias = ult - fEg.getDate();
  return { dias, monto: dias * (bruto / 30) };
}
function calcIndemAntiguedad(ingreso, fechaEgreso, mejorRem, topeCCT) {
  const fEg = parseDate(fechaEgreso), fIng = parseDate(ingreso);
  if (!fEg || !fIng) return { anios: 0, monto: 0, topeAplicado: false };
  const aniosFloat = (fEg - fIng) / (365.25 * 86400000);
  const ent = Math.floor(aniosFloat), frac = aniosFloat - ent;
  const aniosCalc = Math.max(1, frac > 0.25 ? ent + 1 : ent);
  let base = mejorRem, topeAplicado = false;
  if (num(topeCCT) > 0 && base > num(topeCCT) * 3) { base = num(topeCCT) * 3; topeAplicado = true; }
  return { anios: aniosCalc, monto: base * aniosCalc, baseAplicada: base, topeAplicado };
}

// Liquidación. opts: { anio, mes, tipo, diasVac, fechaEgreso, motivoBaja, mejorRem, diasVacNoGozadas, topeCCT }
export function calcularRecibo(emp, params, opts) {
  const { anio, mes, tipo = 'mensual' } = opts || {};
  const p = params || {};
  const d = emp.data || {};
  const esFC = !d.cod_sindicato || String(d.cod_sindicato).toUpperCase() === 'FC';

  // Si el empleado tiene categoría de convenio que define básico, ese tiene prioridad (luego básico cargado / escala).
  // Prioridad del básico: matriz de antigüedad > convenio/categoría > básico del legajo > sueldo > bruto.
  const basico = num(opts?.basicoPorAntiguedad) || num(opts?.convBasico) || num(d.basico) || num(d.sueldo) || num(emp.bruto);
  const anios = aniosAntiguedad(emp.ingreso, anio, mes);
  const sind = opts?.sind || null;
  const pctAntig = (sind && Number(sind.pctAntigPorAnio) > 0) ? Number(sind.pctAntigPorAnio) : num(p.pctAntiguedadPorAnio);
  const antiguedad = esFC ? 0 : basico * anios * pctAntig / 100;
  const pierdePresentismo = num(opts?.diasSuspension) > 0 || num(opts?.ausenciasInjustificadas) > 0;
  // Adicional por título según el nivel del empleado (data.nivelTitulo) y los montos del CCT (sindicato).
  const nivelTit = String(d.nivelTitulo || '').toLowerCase();
  const tituloAdic = (esFC || !sind) ? 0 : (nivelTit === 'universitario' ? num(sind.tituloUniversitario) : nivelTit === 'secundario' ? num(sind.tituloSecundario) : 0);
  // Base del presentismo según el CCT (pres_base): básico [+ antig] [+ título] [+ a cuenta de futuros aumentos].
  const presBase = opts?.presBase || 'basico';
  let basePres = basico;
  if (presBase.includes('antig')) basePres += antiguedad;
  if (presBase.includes('titulo')) basePres += tituloAdic;
  if (presBase.includes('acuenta')) basePres += num(d.aCuenta);
  const pctPres = (sind && Number(sind.pctPresentismo) > 0) ? Number(sind.pctPresentismo) : num(p.pctPresentismo);
  const presentismo = (esFC || pierdePresentismo) ? 0 : basePres * pctPres / 100;
  // Adicional presentismo individual (tilde del legajo): lleva el presentismo hasta el 10%; solo si la diferencia es > 0.
  const adicPres = (esFC || pierdePresentismo || !d.adicionalPresentismo) ? 0 : Math.max(0, basePres * (10 - pctPres) / 100);
  const complemento = num(d.complemento);
  const noRem = num(d.norem);
  const regularRemun = basico + antiguedad + presentismo + tituloAdic + adicPres + complemento;
  const mejorRem = num(opts?.mejorRem) || (regularRemun + noRem);
  const fechaPago = opts?.fechaPago || `${anio}-${String(mes).padStart(2, '0')}-01`;
  const G = opts?.ganTabla || ganParaFecha(fechaPago);

  const haberes = [];
  const tipoLabel = {
    mensual: 'Mensual', quincenal_1: 'Quincena 1ª (1–15)', quincenal_2: 'Quincena 2ª (16–fin)',
    sac1: 'SAC 1° semestre', sac2: 'SAC 2° semestre', vacaciones: 'Vacaciones', final: 'Liquidación final',
    anticipo: 'Anticipo de haberes', complementaria: 'Extraordinaria remunerativa (ajuste con aportes)', anticipo_ajuste: 'Anticipo ajuste de sueldo (no rem.)', extra_norem: 'Extraordinaria no remunerativa',
  }[tipo] || tipo;

  const esQuincenal = tipo === 'quincenal_1' || tipo === 'quincenal_2';
  const esSAConly = tipo === 'sac1' || tipo === 'sac2';
  const esVacaciones = tipo === 'vacaciones';
  const esFinal = tipo === 'final';
  const esAnticipo = tipo === 'anticipo';
  const esComplementaria = tipo === 'complementaria';
  const esAnticipoAjuste = tipo === 'anticipo_ajuste';
  const esExtraNoRem = tipo === 'extra_norem';
  const detalle = {};

  if (esSAConly) {
    // SAC = 50% de la MEJOR remuneración mensual del semestre (Ley 23.041 / art. 121 LCT).
    // Si la corrida aporta la mejor remuneración del semestre se usa esa; si no, la del mes en curso.
    const baseSac = num(opts?.mejorRemSAC) > 0 ? num(opts.mejorRemSAC) : regularRemun;
    const sac = baseSac * 0.5;
    haberes.push({ concepto: `SAC ${tipo === 'sac1' ? '1°' : '2°'} semestre (50% mejor remuneración)`, tipo: 'rem', monto: round2(sac) });
    detalle.sac = { mejorRemSemestre: round2(baseSac), monto: round2(sac) };
  } else if (esVacaciones) {
    const diasCorr = anios < 5 ? 14 : anios < 10 ? 21 : anios < 20 ? 28 : 35;
    const diasVac = num(opts?.diasVac) > 0 ? num(opts.diasVac) : diasCorr;
    const valorDia = (regularRemun + noRem) / 25; // Art. 155 LCT
    haberes.push({ concepto: `Vacaciones (${diasVac} días × $${round2(valorDia)})`, tipo: 'rem', monto: round2(diasVac * valorDia) });
    detalle.vacaciones = { dias: diasVac, valorDia: round2(valorDia), diasCorresponden: diasCorr };
    // Art. 155 inc. c) LCT: si hay remuneraciones variables, se adiciona el promedio (del año / último semestre).
    const promVarVac = num(opts?.promedioVariablesMes);
    if (promVarVac > 0) {
      const vVar = round2((promVarVac / 25) * diasVac);
      haberes.push({ concepto: `Promedio de variables s/vacaciones (${diasVac} días — art. 155 inc. c LCT)`, tipo: 'rem', monto: vVar });
      detalle.vacaciones.promedioVariables = vVar;
    }
  } else if (esFinal) {
    const fEg = opts?.fechaEgreso;
    const diaEgreso = parseDate(fEg)?.getDate() || 30;
    const valorDia = regularRemun / 30;
    // Haberes del mes hasta el egreso
    haberes.push({ concepto: `Haberes ${diaEgreso} día(s) del mes de egreso`, tipo: 'rem', monto: round2(valorDia * diaEgreso) });
    // SAC proporcional
    const sacP = calcSacProporcional(emp.ingreso, fEg, mejorRem);
    haberes.push({ concepto: `SAC proporcional (${sacP.dias} días del semestre)`, tipo: 'rem', monto: round2(sacP.monto) });
    // Vacaciones no gozadas
    const diasVNG = num(opts?.diasVacNoGozadas);
    if (diasVNG > 0) { const vd = mejorRem / 25; haberes.push({ concepto: `Vacaciones no gozadas (${diasVNG} días)`, tipo: 'norem', monto: round2(diasVNG * vd) }); }
    detalle.sacProporcional = { monto: round2(sacP.monto), dias: sacP.dias };
    // Indemnizaciones según el supuesto legal de la baja.
    const motivo = opts?.motivoBaja || 'renuncia';
    // Modalidad de contratación: si no genera indemnización por antigüedad (eventual, pasantía,
    // práctica profesionalizante), no se calcula la indemnización del Art. 245/247/etc.
    const _indemnAplica = opts?.indemnizaAplica !== false;
    const aniosAntServicio = (parseDate(fEg) - parseDate(emp.ingreso)) / (365.25 * 86400000);
    const finContratoMedia = motivo === 'fin_contrato' && aniosAntServicio > 1; // Art. 250: plazo fijo cumplido > 1 año
    const conIndemPlena = _indemnAplica && ['sin_causa', 'despido_indirecto', 'incapacidad_absoluta'].includes(motivo); // Art. 245 / 246 / 212 4°
    const conMediaIndem = _indemnAplica && (['fallecimiento', 'fuerza_mayor', 'incapacidad_parcial'].includes(motivo) || finContratoMedia); // Art. 248 / 247 / 212 1°-3° / 250: 50%
    const debePreaviso = ['sin_causa', 'fuerza_mayor', 'despido_indirecto'].includes(motivo);
    let pagarPreaviso = true;
    if (opts?.pagarPreaviso === true || opts?.pagarPreaviso === false) pagarPreaviso = opts.pagarPreaviso;
    else if (opts?.fechaNotificacion && fEg) {
      const plazoMeses = aniosAntServicio > 5 ? 2 : 1;
      const servido = parseDate(opts.fechaNotificacion); servido.setMonth(servido.getMonth() + plazoMeses);
      pagarPreaviso = parseDate(fEg) < servido; // si egresó antes de cumplir el plazo legal, se paga la sustitutiva
    }
    const conPreaviso = debePreaviso && pagarPreaviso;
    if (debePreaviso) detalle.preavisoPagado = pagarPreaviso;
    const conPreavisoPrueba = motivo === 'prueba'; // Art. 92 bis: 15 días
    if (conIndemPlena || conMediaIndem || conPreaviso || conPreavisoPrueba) {
      const ind = calcIndemAntiguedad(emp.ingreso, fEg, mejorRem, opts?.topeCCT);
      if (conPreaviso) {
        const pre = calcPreaviso(emp.ingreso, fEg, mejorRem);
        const integ = calcIntegracionMes(fEg, mejorRem);
        const sacPre = pre.monto / 12;
        haberes.push({ concepto: `Preaviso (${pre.meses ? pre.meses + ' mes(es)' : pre.dias + ' días'})`, tipo: 'rem', monto: round2(pre.monto) });
        if (sacPre > 0) haberes.push({ concepto: 'SAC sobre preaviso', tipo: 'rem', monto: round2(sacPre) });
        if (integ.monto > 0) haberes.push({ concepto: `Integración mes de despido (${integ.dias} días)`, tipo: 'norem', monto: round2(integ.monto) });
        detalle.indemnizacion = { preaviso: round2(pre.monto), sacPreaviso: round2(sacPre), integracion: round2(integ.monto) };
      }
      if (conPreavisoPrueba) {
        const montoPre = round2((mejorRem / 30) * 15);
        haberes.push({ concepto: 'Preaviso período de prueba (15 días — Art. 92 bis)', tipo: 'rem', monto: montoPre });
      }
      const usaFondoCese = (opts?.modoIndemnizacion || p.modoIndemnizacion) === 'fondo_cese';
      if (conIndemPlena) {
        if (usaFondoCese) {
          detalle.indemnizacion = { ...(detalle.indemnizacion || {}), art245: 0, cubiertoPorFondoCese: round2(ind.monto), anios: ind.anios };
          detalle.notaFondoCese = 'Indemnización por antigüedad cubierta por el Fondo de Cese Laboral (Ley Bases 27.742) — no se abona Art. 245 con la liquidación final.';
        } else {
          haberes.push({ concepto: `Indemnización por antigüedad — Art. 245 (${ind.anios} años${ind.topeAplicado ? ', con tope CCT' : ''})`, tipo: 'exento', monto: round2(ind.monto) });
          detalle.indemnizacion = { ...(detalle.indemnizacion || {}), art245: round2(ind.monto), anios: ind.anios };
        }
      } else if (conMediaIndem) {
        const m = round2(ind.monto * 0.5);
        const lblMedia = motivo === 'fuerza_mayor' ? 'Art. 247 (fuerza mayor / falta de trabajo)' : motivo === 'incapacidad_parcial' ? 'Art. 212 (incapacidad parcial)' : motivo === 'fin_contrato' ? 'Art. 250 (fin de contrato a plazo)' : 'Art. 248 (fallecimiento)';
        if (usaFondoCese && motivo !== 'fin_contrato') {
          detalle.indemnizacion = { ...(detalle.indemnizacion || {}), art245Media: 0, cubiertoPorFondoCese: m, anios: ind.anios };
          detalle.notaFondoCese = 'Indemnización cubierta por el Fondo de Cese Laboral (Ley Bases 27.742).';
        } else {
          haberes.push({ concepto: `Indemnización ${lblMedia} — 50% del Art. 245`, tipo: 'exento', monto: m });
          detalle.indemnizacion = { ...(detalle.indemnizacion || {}), art245Media: m, anios: ind.anios };
        }
      }
    }
    const grat = num(opts?.gratificacion);
    if (grat > 0) {
      const topeExento = calcIndemAntiguedad(emp.ingreso, fEg, mejorRem, opts?.topeCCT).monto; // exenta hasta una indemnización Art. 245
      const exento = Math.min(grat, topeExento);
      const gravado = round2(grat - exento);
      if (exento > 0) haberes.push({ concepto: 'Gratificación por cese (exenta hasta tope Art. 245)', tipo: 'exento', monto: round2(exento) });
      if (gravado > 0) haberes.push({ concepto: 'Gratificación por cese (excedente gravado en Ganancias)', tipo: 'gravado', monto: gravado });
      detalle.gratificacion = round2(grat);
    }
  } else if (esAnticipo) {
    // Anticipo de haberes: pago a cuenta de la remuneración futura. No tributa aportes/Ganancias ahora;
    // se descuenta en la liquidación regular posterior (módulo Adelantos).
    const monto = num(opts?.montoAnticipo);
    haberes.push({ concepto: 'Anticipo de haberes', tipo: 'anticipo', monto: round2(monto) });
    detalle.anticipo = { monto: round2(monto) };
  } else if (esComplementaria) {
    // Ajuste de sueldo REMUNERATIVO: paga un ajuste con aportes (retroactivos, diferencias).
    const monto = num(opts?.montoAjuste);
    const concepto = (opts?.conceptoAjuste && String(opts.conceptoAjuste).trim()) || 'Ajuste de sueldo';
    haberes.push({ concepto, tipo: 'rem', monto: round2(monto) });
    detalle.ajuste = { concepto, monto: round2(monto) };
  } else if (esAnticipoAjuste) {
    // Anticipo ajuste de sueldo: suma NO REMUNERATIVA a cuenta. Luego se regulariza en la mensual
    // (código "ajuste de sueldo" remunerativo) y se descuenta este anticipo.
    const monto = num(opts?.montoAnticipoAjuste != null ? opts.montoAnticipoAjuste : opts?.montoAjuste);
    const concepto = (opts?.conceptoAjuste && String(opts.conceptoAjuste).trim()) || 'Anticipo ajuste de sueldo';
    haberes.push({ concepto, tipo: 'norem', monto: round2(monto) });
    detalle.anticipoAjuste = { concepto, monto: round2(monto) };
  } else if (esExtraNoRem) {
    // Extraordinaria NO remunerativa: pago no remunerativo genuino (beneficio/gratificación no rem.),
    // no tributa aportes ni Ganancias; se informa en el recibo, Libro y LSD como no remunerativo.
    const monto = num(opts?.montoAjuste);
    const concepto = (opts?.conceptoAjuste && String(opts.conceptoAjuste).trim()) || 'Extraordinaria no remunerativa';
    haberes.push({ concepto, tipo: 'norem', monto: round2(monto) });
    detalle.extraNoRem = { concepto, monto: round2(monto) };
  } else {
    // mensual / quincenal
    const diasBase = esQuincenal ? 15 : 30;
    const diasTrab = num(opts?.diasTrabajados) > 0 ? Math.min(num(opts.diasTrabajados), diasBase) : diasBase;
    const f = diasTrab / 30; // proporción sobre el mes (15/30 para quincena completa)
    const suf = esQuincenal ? ` (${tipo === 'quincenal_1' ? '1ª' : '2ª'} quinc.)` : '';
    const diasTxt = diasTrab !== diasBase ? ` (${diasTrab} días)` : '';
    haberes.push({ concepto: 'Sueldo básico' + suf + diasTxt, tipo: 'rem', monto: round2(basico * f) });
    if (antiguedad > 0) haberes.push({ concepto: `Antigüedad (${anios} año${anios !== 1 ? 's' : ''})${suf}`, tipo: 'rem', monto: round2(antiguedad * f) });
    if (presentismo > 0) haberes.push({ concepto: 'Presentismo' + suf, tipo: 'rem', monto: round2(presentismo * f) });
    if (tituloAdic > 0) haberes.push({ concepto: 'Adicional por título' + suf, tipo: 'rem', monto: round2(tituloAdic * f) });
    if (adicPres > 0) haberes.push({ concepto: 'Adicional presentismo (al 10%)' + suf, tipo: 'rem', monto: round2(adicPres * f) });
    if (complemento > 0) haberes.push({ concepto: 'Complemento variable' + suf, tipo: 'rem', monto: round2(complemento * f) });
    if (noRem > 0) haberes.push({ concepto: 'Asignación no remunerativa' + suf, tipo: 'norem', monto: round2(noRem * f) });
    // Horas extra (valor hora normal = básico / 200)
    const vHora = basico / 200;
    const he50 = num(opts?.horasExtra50), he100 = num(opts?.horasExtra100);
    if (he50 > 0) haberes.push({ concepto: `Horas extra 50% (${he50} hs)`, tipo: 'rem', monto: round2(vHora * 1.5 * he50) });
    if (he100 > 0) haberes.push({ concepto: `Horas extra 100% (${he100} hs)`, tipo: 'rem', monto: round2(vHora * 2 * he100) });
    // Otros conceptos manuales
    if (num(opts?.otrosRemun) > 0) haberes.push({ concepto: opts?.otrosRemunLabel || 'Otros haberes remunerativos', tipo: 'rem', monto: round2(num(opts.otrosRemun)) });
    if (num(opts?.otrosNoRem) > 0) haberes.push({ concepto: opts?.otrosNoRemLabel || 'Otros haberes no remunerativos', tipo: 'norem', monto: round2(num(opts.otrosNoRem)) });
    // Feriados trabajados: un jornal adicional por feriado (Art. 166/168 LCT)
    const ferT = num(opts?.feriadosTrabajados);
    if (ferT > 0) haberes.push({ concepto: `Feriados trabajados (${ferT})`, tipo: 'rem', monto: round2((basico / 30) * ferT) });
    // Horas extra exentas de Ganancias (Art. 82 LIG) — remunerativas para aportes
    const heEx = num(opts?.hsExtrasExentas);
    if (heEx > 0) haberes.push({ concepto: `Horas extra exentas Ganancias (${heEx} hs)`, tipo: 'rem', monto: round2((basico / 200) * 1.5 * heEx) });
    // Art. 208 LCT: durante la licencia por enfermedad inculpable se mantiene el promedio
    // de las remuneraciones variables del último semestre por los días de licencia.
    const dEnf = num(opts?.diasEnfermedad), promVarEnf = num(opts?.promedioVariablesMes);
    if (dEnf > 0 && promVarEnf > 0) haberes.push({ concepto: `Promedio de variables s/licencia por enfermedad (${dEnf} días — art. 208 LCT)`, tipo: 'rem', monto: round2((promVarEnf / 30) * dEnf) });
    // Conceptos exentos (no tributan aportes ni Ganancias): bono productividad, indemnizaciones, otros
    if (num(opts?.bonoProductividadExento) > 0) haberes.push({ concepto: 'Bono productividad (exento)', tipo: 'exento', monto: round2(num(opts.bonoProductividadExento)) });
    if (num(opts?.indemnizaciones) > 0) haberes.push({ concepto: 'Indemnizaciones (exento)', tipo: 'exento', monto: round2(num(opts.indemnizaciones)) });
    if (num(opts?.otrosExentos) > 0) haberes.push({ concepto: opts?.otrosExentosLabel || 'Otros conceptos exentos', tipo: 'exento', monto: round2(num(opts.otrosExentos)) });
    const ajB = num(opts?.ajusteSueldoBruto);
    if (ajB > 0) haberes.push({ concepto: 'Ajuste de sueldo', tipo: 'rem', monto: round2(ajB) });
  }

  // ── Conceptos por FÓRMULA (motor de fórmulas). Aditivo: solo actúan si se pasan
  //    conceptos activos con fórmula. Con lista vacía, el recibo es idéntico al actual. ──
  const _formDesc = [];
  const _conceptosForm = Array.isArray(opts?.conceptosFormula) ? opts.conceptosFormula : [];
  if (_conceptosForm.length) {
    const _cx = {}; for (const [k, v] of Object.entries(d)) if (k.startsWith('cx_')) _cx[k] = num(v);
    const _ctxF = { basico, sueldo: num(d.sueldo), complemento, norem: noRem, noRem, antiguedad_monto: antiguedad,
      bruto: num(emp.bruto), anios, remun: regularRemun, dias: num(opts?.diasTrabajados) || 30,
      // Decreto 612/2026: base de aportes/contribuciones SOLIDARIAS = remuneración mensual,
      // habitual y permanente (= regularRemun; excluye HE, SAC, vacaciones, gratificaciones, no rem.).
      // Configurá los conceptos solidarios (p. ej. aporte 'no afiliados') sobre esta variable.
      baseSolidaria: regularRemun, baseSindical: regularRemun,
      he50: num(opts?.horasExtra50), he100: num(opts?.horasExtra100), ausencias: num(opts?.ausenciasInjustificadas),
      feriados: num(opts?.feriadosTrabajados), smvm: num(p.smvmMensual || p.smvm), topeSipa: num(p.topeAportesMax), ..._cx };
    _ctxF.__aux = opts?.auxFormulas || {};
    const _macrosF = opts?.macrosFormulas || null;
    detalle.conceptosFormula = [];
    const _motivoEg = opts?.motivoBaja || null;
    for (const cf of _conceptosForm) {
      try {
        // Conceptos asociados a motivos de egreso: solo se aplican en la liquidación final y si el motivo coincide.
        if (Array.isArray(cf.motivosEgreso) && cf.motivosEgreso.length && (tipo !== 'final' || !cf.motivosEgreso.includes(_motivoEg))) continue;
        if (cf.condicion && String(cf.condicion).trim() && evaluarFormula(cf.condicion, _ctxF, { macros: _macrosF }) === 0) continue;
        // Fórmula en 3 partes (Tango): importe = cantidad × valor unitario. Si no, un único importe.
        let val, cantidad = null, valorUnit = null;
        if (cf.cantidad && String(cf.cantidad).trim() && cf.valorUnit && String(cf.valorUnit).trim()) {
          cantidad = round2(evaluarFormula(cf.cantidad, _ctxF, { macros: _macrosF }));
          valorUnit = round2(evaluarFormula(cf.valorUnit, _ctxF, { macros: _macrosF }));
          val = round2(cantidad * valorUnit);
        } else {
          val = round2(evaluarFormula(cf.formula, _ctxF, { macros: _macrosF }));
        }
        if (!val) continue;
        const base = cf.base || 'rem';
        const item = { concepto: cf.descripcion || cf.codigo || 'Concepto', monto: val };
        if (cantidad != null) { item.cantidad = cantidad; item.valor = valorUnit; if (cf.unidad) item.unidad = cf.unidad; }
        if (base === 'descuento') _formDesc.push(item);
        else haberes.push({ ...item, tipo: base === 'norem' ? 'norem' : base === 'exento' ? 'exento' : 'rem' });
        detalle.conceptosFormula.push({ codigo: cf.codigo || null, descripcion: cf.descripcion || null, base, monto: val, cantidad, valor: valorUnit, unidad: cf.unidad || null });
      } catch (e) { /* fórmula inválida: se omite, no frena la liquidación */ }
    }
  }

  const totalRemun = haberes.filter((h) => h.tipo === 'rem').reduce((s, h) => s + h.monto, 0);
  let totalNoRem = haberes.filter((h) => h.tipo === 'norem').reduce((s, h) => s + h.monto, 0);
  const totalExento = haberes.filter((h) => h.tipo === 'exento').reduce((s, h) => s + h.monto, 0);
  const totalGravado = haberes.filter((h) => h.tipo === 'gravado').reduce((s, h) => s + h.monto, 0); // Ganancias sí, aportes no
  const totalAnticipo = haberes.filter((h) => h.tipo === 'anticipo').reduce((s, h) => s + h.monto, 0);
  let totalHaberes = totalRemun + totalNoRem + totalExento + totalGravado + totalAnticipo;

  // Aportes del trabajador (sobre base remunerativa con tope Art. 9 Ley 24.241, si está configurado)
  const descuentos = [];
  for (const _x of _formDesc) descuentos.push(_x);
  const topeMax = num(p.topeAportesMax) > 0 ? num(p.topeAportesMax) : Infinity;
  const topeMin = num(p.topeAportesMin) > 0 ? num(p.topeAportesMin) : 0;
  const baseAportes = Math.min(Math.max(totalRemun, topeMin), topeMax);   // base SIPA (jubilación + INSSJP)
  // Obra Social: MISMO tope y base que SIPA para jornada completa. En jornada PARCIAL
  // (art. 92 ter LCT / Ley 24.465) los aportes y contribuciones de OS se calculan sobre la
  // remuneración de un trabajador de JORNADA COMPLETA de la misma categoría (data.remFullTime);
  // si no está cargada, el piso es la base mínima (equivalente a la jornada completa mínima).
  const esParcial = d.jornadaParcial === true || d.jornadaParcial === 'si' || d.jornadaParcial === '1';
  // Equivalente de jornada completa para OS: remFullTime del legajo → si no está, el básico de
  // convenio de la categoría (jornada completa) → si tampoco, el piso de la base mínima.
  const remOs = esParcial ? Math.max(totalRemun, num(d.remFullTime) || num(opts?.convBasico) || topeMin) : totalRemun;
  const baseAportesOs = Math.min(Math.max(remOs, topeMin), topeMax);
  const ap = (pct) => round2(baseAportes * num(pct) / 100);
  const apOs = (pct) => round2(baseAportesOs * num(pct) / 100);
  const aJub = ap(p.pctJubilacion), aOS = apOs(p.pctObraSocial), aAnssal = apOs(p.pctAnssal), aPami = ap(p.pctPamiEmp), aSind = esFC ? 0 : ap((sind && Number(sind.pctEmpleado) > 0) ? Number(sind.pctEmpleado) : num(p.pctSindicatoEmp));
  if (aJub > 0) descuentos.push({ concepto: 'Jubilación', monto: aJub });
  if (aOS > 0) descuentos.push({ concepto: 'Obra Social', monto: aOS });
  if (aAnssal > 0) descuentos.push({ concepto: 'ANSSAL', monto: aAnssal });
  if (aPami > 0) descuentos.push({ concepto: 'INSSJP (PAMI)', monto: aPami });
  if (aSind > 0) descuentos.push({ concepto: 'Cuota sindical', monto: aSind });
  const totalAportes = descuentos.reduce((s, x) => s + x.monto, 0);
  const netoAntesGan = totalHaberes - totalAportes;

  // ── Impuesto a las Ganancias 4ª — RG 4003/17 (Anexo II) ──
  // A) Remuneración habitual del mes. B) No habituales (ajustes/plus/gratificaciones,
  //    EXCEPTO SAC): imputación proporcional del mes de pago a diciembre. C) SAC:
  //    1/12 de (A+B) cada mes con 1/12 de las deducciones; el SAC realmente abonado
  //    se ignora en el mes y se reconcilia en la liquidación anual/final.
  const aplicaGan = ['mensual', 'quincenal_1', 'quincenal_2', 'sac1', 'sac2', 'vacaciones', 'complementaria', 'final', 'anual'].includes(tipo);
  let ganDetalle = null;
  if (aplicaGan && opts?.calcularGanancias !== false) {
    const ac = opts?.acumGanancias || {};
    const anualizada = esFinal || tipo === 'anual' || !!opts?.gananciasAnualizada;
    const esSacPago = TIPOS_SAC.includes(tipo);
    const esNoHabB = TIPOS_NO_HABITUAL_B.includes(tipo);
    const esHabitualCur = !esSacPago && !esNoHabB;                       // mensual/quincenal/vacaciones/final
    const fB = anualizada ? 1 : factorNoHabitual(Number(mes), Number(mes));
    const comp = {
      habitual: num(ac.habitual) + (esHabitualCur ? totalRemun : 0) + totalGravado,
      noHabPro: num(ac.noHabPro) + (esNoHabB ? totalRemun * fB : 0),
      noHabFull: num(ac.noHabFull) + (esNoHabB ? totalRemun : 0),
      aporHabitual: num(ac.aporHabitual) + (esHabitualCur ? totalAportes : 0),
      aporNoHabPro: num(ac.aporNoHabPro) + (esNoHabB ? totalAportes * fB : 0),
      aporNoHabFull: num(ac.aporNoHabFull) + (esNoHabB ? totalAportes : 0),
      sacReal: num(ac.sacReal) + (esSacPago ? totalRemun : 0),
      aporSacReal: num(ac.aporSacReal) + (esSacPago ? totalAportes : 0),
      retenidoAcum: num(ac.retenidoAcum),
      tieneConyuge: opts?.tieneConyuge, nroHijosMenores: opts?.nroHijosMenores,
      nroHijosIncapacitados: opts?.nroHijosIncapacitados, dedVoluntariasAnual: opts?.dedVoluntariasAnual,
      ganTabla: G, mes, anualizada,
    };
    const r = calcularGananciasAcum(comp);
    // El recibo de SAC no genera retención propia en el mes: ya se retiene mes a mes
    // mediante el 1/12 (RG 4003 ap. C). Sólo se reconcilia en la liquidación anual/final.
    if (esSacPago && !anualizada) {
      ganDetalle = { ...r, retencionPeriodo: 0, sacRecibo: true };
    } else {
      let ganRet = r.retencionPeriodo;
      let ganTopeada = false;
      if (ganRet > 0 && !anualizada) {
        const topePct = (p.gan_topeRetencionPct != null ? num(p.gan_topeRetencionPct) : 35);
        const tope = netoAntesGan * topePct / 100;
        if (ganRet > tope) { ganRet = round2(tope); ganTopeada = true; }
      }
      if (ganRet > 0) descuentos.push({ concepto: 'Impuesto a las Ganancias 4ª' + (ganTopeada ? ` — tope ${(p.gan_topeRetencionPct != null ? num(p.gan_topeRetencionPct) : 35)}%` : ''), monto: ganRet });
      else if (ganRet < 0) descuentos.push({ concepto: 'Devolución Impuesto a las Ganancias', monto: ganRet });
      ganDetalle = { ...r, retencionPeriodo: ganRet };
    }
  }

  // Descuento del anticipo de ajuste de sueldo abonado durante el mes (regularización).
  const antAjDesc = (tipo === 'mensual' || esQuincenal) ? num(opts?.anticipoAjusteDesc) : 0;
  if (antAjDesc > 0) descuentos.push({ concepto: 'Descuento anticipo ajuste de sueldo', monto: round2(antAjDesc) });
  // Recupero del ajuste por neto negativo generado en la liquidación anterior.
  const ajRecuperar = (tipo === 'mensual' || esQuincenal) ? num(opts?.ajusteNetoRecuperar) : 0;
  if (ajRecuperar > 0) descuentos.push({ concepto: 'Recupero ajuste de sueldo (neto negativo período anterior)', monto: round2(ajRecuperar) });

  // Suspensiones / ausencias (días no trabajados → descuento) + embargos.
  if ((tipo === 'mensual' || esQuincenal)) {
    const valorDia = (basico + presentismo + antiguedad + complemento) / 30;
    const dSusp = num(opts?.diasSuspension);
    if (dSusp > 0) descuentos.push({ concepto: `Suspensión disciplinaria (${dSusp} días)`, monto: round2(valorDia * dSusp) });
    const dAus = num(opts?.ausenciasInjustificadas);
    if (dAus > 0) descuentos.push({ concepto: `Ausencias injustificadas (${dAus} días)`, monto: round2(valorDia * dAus) });
    // Licencia SIN goce de haberes (p. ej. enfermedad de familiar a cargo, art. 78 CCT 130/75).
    // NO hace perder el presentismo (es licencia convencional), por eso va aparte de las ausencias.
    const dSG = num(opts?.diasLicenciaSinGoce);
    if (dSG > 0) descuentos.push({ concepto: `Licencia sin goce de haberes (${dSG} días — art. 78 CCT 130/75)`, monto: round2(valorDia * dSG) });
    if (num(opts?.otrosDesc) > 0) descuentos.push({ concepto: opts?.otrosDescLabel || 'Otros descuentos', monto: round2(num(opts.otrosDesc)) });

    // Neto disponible para topes de embargo.
    const netoParcial = totalHaberes - descuentos.reduce((a, x) => a + x.monto, 0);
    // Embargo por alimentos: % del neto (sin tope del 20%).
    const aliPct = num(opts?.embargoAlimentosPct);
    let mAlim = num(opts?.cuotaAlimentaria);
    if (aliPct > 0) mAlim += round2(netoParcial * aliPct / 100);
    if (mAlim > 0) descuentos.push({ concepto: `Embargo/cuota alimentaria${aliPct > 0 ? ` (${aliPct}%)` : ''}`, monto: round2(mAlim) });
    // Embargo común: tope = 20% de (neto − SMVM) si neto > SMVM (Ley 27.586 / CPCCN).
    const embC = num(opts?.embargo);
    if (embC > 0) {
      const smvm = num(opts?.smvm) || num(p.smvm);
      let monto = embC, topeAplicado = false;
      if (smvm > 0) { const tope = netoParcial > smvm ? (netoParcial - smvm) * 0.20 : 0; if (embC > tope) { monto = round2(tope); topeAplicado = true; } }
      if (monto > 0) descuentos.push({ concepto: 'Embargo judicial' + (topeAplicado ? ' (con tope legal 20%)' : ''), monto: round2(monto) });
    }
  }

  // Cuotas de anticipos de sueldo aprobados (módulo Adelantos).
  if ((tipo === 'mensual' || esQuincenal) && Array.isArray(opts?.cuotasAnticipos)) {
    for (const c of opts.cuotasAnticipos) {
      if (num(c.monto) > 0) descuentos.push({ concepto: `Cuota anticipo de sueldo (${c.nro}/${c.cuotas})${c.motivo ? ' — ' + c.motivo : ''}`, monto: round2(c.monto) });
    }
  } else if ((tipo === 'mensual' || esQuincenal) && num(opts?.anticipoCuotaDesc) > 0) {
    descuentos.push({ concepto: 'Cuotas de anticipos de sueldo', monto: round2(num(opts.anticipoCuotaDesc)) });
  }

  const totalDescuentos = descuentos.reduce((s, x) => s + x.monto, 0);
  let neto = totalHaberes - totalDescuentos;
  // El neto NUNCA puede ser negativo: se agrega un ajuste no remunerativo que lo lleva a cero,
  // y se registra para recuperarlo (descontarlo) en la liquidación siguiente.
  let ajusteNetoNegativo = 0;
  if ((tipo === 'mensual' || esQuincenal) && round2(neto) < 0) {
    ajusteNetoNegativo = round2(-neto);
    haberes.push({ concepto: 'Ajuste de sueldo no remunerativo (neto negativo — a recuperar próx. liquidación)', tipo: 'norem', monto: ajusteNetoNegativo });
    totalNoRem += ajusteNetoNegativo;
    totalHaberes += ajusteNetoNegativo;
    neto = 0;
  }
  detalle.ajusteNetoNegativo = ajusteNetoNegativo;
  detalle.ajusteNetoRecuperado = round2(ajRecuperar);

  // Costo del empleador (contribuciones patronales + SCVO) — sobre remunerativos
  const contribuciones = [];
  const co = (pct) => round2(totalRemun * num(pct) / 100);
  // Detracción de la base de contribuciones de seguridad social (Ley 27.541, art. 22):
  // suma fija mensual por trabajador que reduce la base de SIPA/INSSJP/FNE (NO obra social,
  // NO ART, NO sindical). Se prorratea por quincena; no aplica a SAC/vacaciones/final.
  const detr = (tipo === 'mensual') ? num(p.detraccionContrib) : (esQuincenal ? num(p.detraccionContrib) * 0.5 : 0);
  const baseSegSoc = Math.max(0, totalRemun - detr);
  const coSeg = (pct) => round2(baseSegSoc * num(pct) / 100);
  const cJub = coSeg(p.pctJubPatronal), cOS = round2(baseAportesOs * num(p.pctOsPatronal) / 100), cPami = coSeg(p.pctPamiPatronal), cFne = coSeg(p.pctDesempleo), cArt = co(p.pctArt), cSind = esFC ? 0 : co((sind && Number(sind.pctPatronal) > 0) ? Number(sind.pctPatronal) : num(p.pctSindicatoPatronal));
  // El SCVO y el FFEP son per cápita mensuales: se cobran una sola vez con la liquidación
  // principal (mensual/quincena/SAC/vacaciones/final). No se re-cobran en extraordinarias,
  // anticipos ni ajustes complementarios del mismo período.
  const perCapitaAplica = (tipo === 'mensual' || esQuincenal || esSAConly || esVacaciones || esFinal);
  // Per cápita mensual: en quincena se prorratea 0,5 para que 1ª + 2ª sumen un solo cargo por mes.
  const perCapitaFactor = esQuincenal ? 0.5 : 1;
  const scvo = perCapitaAplica ? round2(num(p.scvoPercapita) * perCapitaFactor) : 0;  // Seguro de Vida Obligatorio (Dto. 1567/74)
  const ffep = perCapitaAplica ? round2(num(p.ffep) * perCapitaFactor) : 0;           // Fondo Fiduc. Enfermedades Profesionales (SRT)
  // Fondo de Asistencia Laboral (Ley 27.802 / Dto. 408/2026), desde 11/2026. NO es costo
  // adicional: se DETRAE de las contribuciones patronales de seguridad social (se redirige un
  // % de la base SIPA desde la jubilación patronal hacia el FAL). Alícuota: MiPyME 2,5% /
  // grandes 1% (override por empresa en empresaData.pctFal; si no, el parámetro pctFal).
  const _falVigente = (Number(anio) * 12 + Number(mes)) >= (2026 * 12 + 11);
  const _pctFal = _falVigente ? (num(emp.empresaData?.pctFal) || num(p.pctFal)) : 0;
  const cFal = _pctFal > 0 ? round2(baseSegSoc * _pctFal / 100) : 0;
  const cJubFal = cFal > 0 ? Math.max(0, round2(cJub - cFal)) : cJub;
  if (cJubFal > 0) contribuciones.push({ concepto: 'Jubilación patronal (SIPA)', monto: cJubFal });
  if (cFal > 0) contribuciones.push({ concepto: `Fondo de Asistencia Laboral (Ley 27.802 — ${_pctFal}%)`, monto: cFal });
  if (cOS > 0) contribuciones.push({ concepto: 'Obra Social patronal', monto: cOS });
  if (cPami > 0) contribuciones.push({ concepto: 'INSSJP patronal (PAMI)', monto: cPami });
  if (cFne > 0) contribuciones.push({ concepto: 'Fondo Nacional de Empleo', monto: cFne });
  if (cArt > 0) contribuciones.push({ concepto: 'ART', monto: cArt });
  if (cSind > 0) contribuciones.push({ concepto: 'Cuota sindical patronal', monto: cSind });
  if (scvo > 0) contribuciones.push({ concepto: 'SCVO — Seguro de Vida Obligatorio (Dto. 1567/74)', monto: scvo });
  if (ffep > 0) contribuciones.push({ concepto: 'FFEP — Fondo Fiduc. Enfermedades Profesionales (SRT)', monto: ffep });
  const fcese = (tipo === 'mensual' || esQuincenal) ? round2(totalRemun * num(p.fondoCesePct) / 100) : 0;
  if (fcese > 0) contribuciones.push({ concepto: 'Fondo de cese laboral (Ley Bases 27.742)', monto: fcese });
  const totalContrib = contribuciones.reduce((s, x) => s + x.monto, 0);

  // Domicilio del empleador (art. 140 LCT inc. a, Dto. 407/2026): se arma desde empresas.data
  const _ed = emp.empresaData || {};
  const _domPartes = [
    [_ed.dir, _ed.nro].filter(Boolean).join(' '),
    _ed.piso ? 'Piso ' + _ed.piso : '',
    _ed.depto ? 'Depto ' + _ed.depto : '',
    _ed.loc, _ed.prov,
    _ed.cp ? '(CP ' + _ed.cp + ')' : '',
  ].filter(Boolean);
  const _domicilioEmpleador = _domPartes.join(', ') || null;
  return {
    empleado: { legNum: emp.legNum, nom: emp.nom, empresa: emp.empresa, cuil: emp.cuil, cat: emp.cat, ingreso: emp.ingreso || null, antiguedadReconocida: emp.data?.antiguedadReconocida || null },
    empleador: { razonSocial: emp.empresa, cuit: emp.empresaCuit || null, domicilio: _domicilioEmpleador },
    periodo: { anio, mes, tipo, tipoLabel, fechaPago, ganPeriodo: G.periodo || null },
    haberes, descuentos, detalle, ganancias: ganDetalle,
    totales: {
      totalRemun: round2(totalRemun), totalNoRem: round2(totalNoRem), totalExento: round2(totalExento),
      totalHaberes: round2(totalHaberes), totalDescuentos: round2(totalDescuentos), neto: round2(neto),
    },
    costoEmpleador: { contribuciones, totalContrib: round2(totalContrib), costoTotal: round2(totalHaberes + totalContrib) },
    composicion: {
      remun: round2(totalRemun), noRem: round2(totalNoRem), exento: round2(totalExento), descuentos: round2(totalDescuentos), neto: round2(neto),
      // Detalle por concepto (empleador + trabajador) — Decreto 407/2026
      cargas: {
        seguridadSocial: { empleador: round2(cJub + cFne), trabajador: round2(aJub) },
        obraSocial:      { empleador: round2(cOS),          trabajador: round2(aOS + aAnssal) },
        inssjp:          { empleador: round2(cPami),        trabajador: round2(aPami) },
        sindical:        { empleador: round2(cSind),        trabajador: round2(aSind) },
        art:             { empleador: round2(cArt),         trabajador: 0 },
        scvo:            { empleador: round2(scvo),         trabajador: 0 },
      },
      costoTotal: round2(totalHaberes + totalContrib),
    },
    nota: 'Liquidación estimada (Ganancias sin SIRADIG; sin feriados/horas extra/embargos). En migración.',
  };
}
