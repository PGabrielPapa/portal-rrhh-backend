// Motor de liquidación — incluye: haberes (básico, antigüedad, presentismo,
// complemento, no rem), SAC (jun/dic), aportes del trabajador, contribuciones
// patronales + SCVO (costo del empleador), y Ganancias 4ª con tope del 35%
// (estimación anualizada). Pendiente: embargos, regímenes especiales, SIRADIG.
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
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

function aniosAntiguedad(ingreso, anio, mes) {
  if (!ingreso) return 0;
  const ing = new Date(ingreso); if (isNaN(ing)) return 0;
  const ref = new Date(anio, mes - 1, 1);
  let a = ref.getFullYear() - ing.getFullYear();
  if (ref.getMonth() < ing.getMonth()) a--;
  return Math.max(0, a);
}

// Impuesto anual según escala progresiva (Art. 94 LIG)
function impuestoEscala(base, escala) {
  if (base <= 0 || !escala?.length) return 0;
  for (const t of escala) {
    const hasta = t.hasta == null ? Infinity : t.hasta;
    if (base > t.desde && base <= hasta) return t.fijo + (base - t.desde) * t.alicuota / 100;
  }
  const last = escala[escala.length - 1];
  return last.fijo + (base - last.desde) * last.alicuota / 100;
}

// ── F.1357: Liquidación del Impuesto a las Ganancias (estimación anualizada) ──
// Reproduce las secciones del formulario AFIP F.1357 con el desglose que el
// motor puede computar (sin SIRADIG/embargos). Las cargas de familia salen de
// la tabla `familiares`. Devuelve una estructura por secciones lista para render.
export function calcularF1357(emp, params, familiares, { anio, mes }) {
  const p = params || {};
  const d = emp.data || {};
  const esFC = !d.cod_sindicato || String(d.cod_sindicato).toUpperCase() === 'FC';

  const basico = num(d.basico) || num(d.sueldo) || num(emp.bruto);
  const anios = aniosAntiguedad(emp.ingreso, anio, mes);
  const antiguedad = esFC ? 0 : basico * anios * num(p.pctAntiguedadPorAnio) / 100;
  const pierdePresentismo = num(opts?.diasSuspension) > 0 || num(opts?.ausenciasInjustificadas) > 0;
  const presentismo = (esFC || pierdePresentismo) ? 0 : (basico + antiguedad) * num(p.pctPresentismo) / 100;
  const complemento = num(d.complemento);
  const regularRemun = basico + antiguedad + presentismo + complemento;

  // Acumulado del año: remuneración regular × meses transcurridos + SAC proporcional.
  const meses = Math.min(12, Math.max(1, num(mes)));
  const remGravAcum = regularRemun * meses;
  const sacAcum = regularRemun * 0.5 * (meses >= 6 ? (meses >= 12 ? 2 : 1) : 0); // SAC jun/dic
  const remBrutaNoHab = remGravAcum;
  const totalRemGravada = remGravAcum + sacAcum;

  // Deducciones generales (aportes del trabajador, acumulados).
  const pctJub = num(p.pctJubilacion), pctOS = num(p.pctObraSocial) + num(p.pctAnssal) + num(p.pctPamiEmp), pctSind = esFC ? 0 : num(p.pctSindicatoEmp);
  const jubAcum = remGravAcum * pctJub / 100;
  const osAcum = remGravAcum * pctOS / 100;
  const sindAcum = remGravAcum * pctSind / 100;
  const totDedGen = jubAcum + osAcum + sindAcum;

  // Deducciones personales proporcionales a los meses transcurridos.
  const propMes = meses / 12;
  const mni = num(GAN.mniAnual) * propMes;
  const dedEsp = num(GAN.dedEspAnual) * propMes;
  const dedEsp2 = num(GAN.dedEsp2Anual) * propMes;

  // Cargas de familia desde la tabla `familiares` (vigentes).
  const fams = (familiares || []).filter((x) => !x.vigencia_hasta);
  const esConyuge = (t) => ['conyuge', 'cónyuge', 'concubino', 'concubina'].includes(String(t || '').toLowerCase());
  const esHijo = (t) => ['hijo', 'hija', 'hijastro', 'hijastra'].includes(String(t || '').toLowerCase());
  const tieneConyuge = fams.some((x) => esConyuge(x.tipo));
  const hijos = fams.filter((x) => esHijo(x.tipo) && !x.discapacidad).length;
  const hijosInc = fams.filter((x) => esHijo(x.tipo) && x.discapacidad).length;
  const cargaConyuge = (tieneConyuge ? num(GAN.cargaConyugeAnual) : 0) * propMes;
  const cargaHijos = hijos * num(GAN.cargaHijoAnual) * propMes;
  const cargaHijosInc = hijosInc * num(GAN.cargaHijoIncAnual) * propMes;
  const totalCargasFam = cargaConyuge + cargaHijos + cargaHijosInc;
  const totDedPers = mni + totalCargasFam + dedEsp + dedEsp2;

  const totDed = totDedGen + totDedPers;
  const remSujeta = Math.max(0, totalRemGravada - totDed);
  const impDeterminado = impuestoEscala(remSujeta, GAN.escala);
  // Alícuota marginal del tramo.
  let alicuota = 0;
  for (const t of (GAN.escala || [])) { const hasta = t.hasta == null ? Infinity : t.hasta; if (remSujeta > t.desde && remSujeta <= hasta) { alicuota = t.alicuota; break; } }
  if (remSujeta > 0 && !alicuota && GAN.escala?.length) alicuota = GAN.escala[GAN.escala.length - 1].alicuota;

  return {
    empleado: { legNum: emp.legNum, nom: emp.nom, empresa: emp.empresa, cuil: emp.cuil, cat: emp.cat },
    periodo: { anio, mes, periodoLabel: `${String(mes).padStart(2, '0')}/${anio}`, tablas: GAN.periodo || '' },
    gravadas: { remBrutaNoHab: round2(remBrutaNoHab), sac: round2(sacAcum), totalGravada: round2(totalRemGravada) },
    dedGenerales: { jubilacion: round2(jubAcum), obraSocial: round2(osAcum), cuotaSindical: round2(sindAcum), total: round2(totDedGen) },
    dedPersonales: {
      mni: round2(mni),
      cargasFamilia: { conyuge: round2(cargaConyuge), hijos: round2(cargaHijos), hijosIncapacitados: round2(cargaHijosInc), total: round2(totalCargasFam), nHijos: hijos, nHijosInc: hijosInc, tieneConyuge },
      dedEspecial: round2(dedEsp), dedEspecial2: round2(dedEsp2), total: round2(totDedPers),
    },
    determinacion: { remSujeta: round2(remSujeta), alicuota, impuestoDeterminado: round2(impDeterminado) },
    nota: 'Estimación anualizada (sin SIRADIG, otros empleos ni embargos). En migración.',
  };
}

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

  const basico = num(d.basico) || num(d.sueldo) || num(emp.bruto);
  const anios = aniosAntiguedad(emp.ingreso, anio, mes);
  const antiguedad = esFC ? 0 : basico * anios * num(p.pctAntiguedadPorAnio) / 100;
  const pierdePresentismo = num(opts?.diasSuspension) > 0 || num(opts?.ausenciasInjustificadas) > 0;
  const presentismo = (esFC || pierdePresentismo) ? 0 : (basico + antiguedad) * num(p.pctPresentismo) / 100;
  const complemento = num(d.complemento);
  const noRem = num(d.norem);
  const regularRemun = basico + antiguedad + presentismo + complemento;
  const mejorRem = num(opts?.mejorRem) || (regularRemun + noRem);
  const fechaPago = opts?.fechaPago || `${anio}-${String(mes).padStart(2, '0')}-01`;
  const G = opts?.ganTabla || ganParaFecha(fechaPago);

  const haberes = [];
  const tipoLabel = {
    mensual: 'Mensual', quincenal_1: 'Quincena 1ª (1–15)', quincenal_2: 'Quincena 2ª (16–fin)',
    sac1: 'SAC 1° semestre', sac2: 'SAC 2° semestre', vacaciones: 'Vacaciones', final: 'Liquidación final',
    anticipo: 'Anticipo de haberes', complementaria: 'Ajuste de sueldo (remunerativo)', anticipo_ajuste: 'Anticipo ajuste de sueldo (no rem.)',
  }[tipo] || tipo;

  const esQuincenal = tipo === 'quincenal_1' || tipo === 'quincenal_2';
  const esSAConly = tipo === 'sac1' || tipo === 'sac2';
  const esVacaciones = tipo === 'vacaciones';
  const esFinal = tipo === 'final';
  const esAnticipo = tipo === 'anticipo';
  const esComplementaria = tipo === 'complementaria';
  const esAnticipoAjuste = tipo === 'anticipo_ajuste';
  const detalle = {};

  if (esSAConly) {
    const sac = regularRemun * 0.5;
    haberes.push({ concepto: `SAC ${tipo === 'sac1' ? '1°' : '2°'} semestre (50% mejor remuneración)`, tipo: 'rem', monto: round2(sac) });
  } else if (esVacaciones) {
    const diasCorr = anios < 5 ? 14 : anios < 10 ? 21 : anios < 20 ? 28 : 35;
    const diasVac = num(opts?.diasVac) > 0 ? num(opts.diasVac) : diasCorr;
    const valorDia = (regularRemun + noRem) / 25; // Art. 155 LCT
    haberes.push({ concepto: `Vacaciones (${diasVac} días × $${round2(valorDia)})`, tipo: 'rem', monto: round2(diasVac * valorDia) });
    detalle.vacaciones = { dias: diasVac, valorDia: round2(valorDia), diasCorresponden: diasCorr };
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
    const conIndemPlena = motivo === 'sin_causa';
    const conMediaIndem = motivo === 'mutuo' || motivo === 'fallecimiento'; // Art. 241 / 248: 50%
    const conPreaviso = motivo === 'sin_causa';
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
      if (conIndemPlena) {
        haberes.push({ concepto: `Indemnización por antigüedad — Art. 245 (${ind.anios} años${ind.topeAplicado ? ', con tope CCT' : ''})`, tipo: 'exento', monto: round2(ind.monto) });
        detalle.indemnizacion = { ...(detalle.indemnizacion || {}), art245: round2(ind.monto), anios: ind.anios };
      } else if (conMediaIndem) {
        const m = round2(ind.monto * 0.5);
        haberes.push({ concepto: `Indemnización ${motivo === 'mutuo' ? 'Art. 241 (mutuo acuerdo)' : 'Art. 248 (fallecimiento)'} — 50% del Art. 245`, tipo: 'exento', monto: m });
        detalle.indemnizacion = { ...(detalle.indemnizacion || {}), art245Media: m, anios: ind.anios };
      }
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
    // Conceptos exentos (no tributan aportes ni Ganancias): bono productividad, indemnizaciones, otros
    if (num(opts?.bonoProductividadExento) > 0) haberes.push({ concepto: 'Bono productividad (exento)', tipo: 'exento', monto: round2(num(opts.bonoProductividadExento)) });
    if (num(opts?.indemnizaciones) > 0) haberes.push({ concepto: 'Indemnizaciones (exento)', tipo: 'exento', monto: round2(num(opts.indemnizaciones)) });
    if (num(opts?.otrosExentos) > 0) haberes.push({ concepto: opts?.otrosExentosLabel || 'Otros conceptos exentos', tipo: 'exento', monto: round2(num(opts.otrosExentos)) });
    const ajB = num(opts?.ajusteSueldoBruto);
    if (ajB > 0) haberes.push({ concepto: 'Ajuste de sueldo', tipo: 'rem', monto: round2(ajB) });
  }

  const totalRemun = haberes.filter((h) => h.tipo === 'rem').reduce((s, h) => s + h.monto, 0);
  const totalNoRem = haberes.filter((h) => h.tipo === 'norem').reduce((s, h) => s + h.monto, 0);
  const totalExento = haberes.filter((h) => h.tipo === 'exento').reduce((s, h) => s + h.monto, 0);
  const totalAnticipo = haberes.filter((h) => h.tipo === 'anticipo').reduce((s, h) => s + h.monto, 0);
  const totalHaberes = totalRemun + totalNoRem + totalExento + totalAnticipo;

  // Aportes del trabajador (solo sobre remunerativos)
  const descuentos = [];
  const ap = (pct) => round2(totalRemun * num(pct) / 100);
  const aJub = ap(p.pctJubilacion), aOS = ap(p.pctObraSocial), aAnssal = ap(p.pctAnssal), aPami = ap(p.pctPamiEmp), aSind = esFC ? 0 : ap(p.pctSindicatoEmp);
  if (aJub > 0) descuentos.push({ concepto: 'Jubilación', monto: aJub });
  if (aOS > 0) descuentos.push({ concepto: 'Obra Social', monto: aOS });
  if (aAnssal > 0) descuentos.push({ concepto: 'ANSSAL', monto: aAnssal });
  if (aPami > 0) descuentos.push({ concepto: 'INSSJP (PAMI)', monto: aPami });
  if (aSind > 0) descuentos.push({ concepto: 'Cuota sindical', monto: aSind });
  const totalAportes = descuentos.reduce((s, x) => s + x.monto, 0);
  const netoAntesGan = totalHaberes - totalAportes;

  // ── Impuesto a las Ganancias 4ª — modelo ACUMULADO (RG 4003/17) ──
  // Impuesto sobre el acumulado del año menos lo ya retenido = retención del mes.
  // Mensual/quincenal/SAC/vacaciones: deducciones personales proporcionales a los meses
  // transcurridos. Final/anual: anualizadas (proporción completa).
  const aplicaGan = ['mensual', 'quincenal_1', 'quincenal_2', 'sac1', 'sac2', 'vacaciones', 'final', 'anual'].includes(tipo);
  let ganDetalle = null;
  if (aplicaGan && opts?.calcularGanancias !== false) {
    const ac = opts?.acumGanancias || { remGravAcum: 0, aportesAcum: 0, retenidoAcum: 0 };
    const anualizada = esFinal || tipo === 'anual' || !!opts?.gananciasAnualizada;
    const meses = anualizada ? 12 : Number(mes);
    const prop = anualizada ? 1 : Math.min(1, Math.max(0, meses / 12));
    const remAcum = num(ac.remGravAcum) + totalRemun;
    const aportesAcum = num(ac.aportesAcum) + totalAportes;
    const cargasFamAnual = (opts?.tieneConyuge ? num(G.cargaConyugeAnual) : 0)
      + num(opts?.nroHijosMenores) * num(G.cargaHijoAnual)
      + num(opts?.nroHijosIncapacitados) * num(G.cargaHijoIncAnual);
    const mniProp = num(G.mniAnual) * prop;
    const dedEspProp = num(G.dedEspAnual) * prop;
    const dedEsp2Prop = num(G.dedEsp2Anual) * prop;
    const cargasProp = cargasFamAnual * prop;
    const dedVolProp = num(opts?.dedVoluntariasAnual) * prop;
    const remSujeta = Math.max(0, remAcum - aportesAcum - mniProp - dedEspProp - dedEsp2Prop - cargasProp - dedVolProp);
    const impDetAcum = impuestoEscala(remSujeta, G.escala);
    let ganRet = round2(impDetAcum - num(ac.retenidoAcum)); // retención del período (negativo = devolución)
    let ganTopeada = false;
    if (ganRet > 0 && !anualizada) {
      const topePct = (p.gan_topeRetencionPct != null ? num(p.gan_topeRetencionPct) : 35);
      const tope = netoAntesGan * topePct / 100;
      if (ganRet > tope) { ganRet = round2(tope); ganTopeada = true; }
    }
    if (ganRet > 0) descuentos.push({ concepto: 'Impuesto a las Ganancias 4ª' + (ganTopeada ? ` — tope ${(p.gan_topeRetencionPct != null ? num(p.gan_topeRetencionPct) : 35)}%` : ''), monto: ganRet });
    else if (ganRet < 0) descuentos.push({ concepto: 'Devolución Impuesto a las Ganancias', monto: ganRet });
    ganDetalle = { remGravAcum: round2(remAcum), aportesAcum: round2(aportesAcum), mesesTranscurridos: meses, anualizada,
      mni: round2(mniProp), dedEspecial: round2(dedEspProp), dedEspecial2: round2(dedEsp2Prop), cargasFamilia: round2(cargasProp), dedVoluntarias: round2(dedVolProp),
      remSujeta: round2(remSujeta), impuestoDeterminado: round2(impDetAcum), retenidoAnterior: round2(num(ac.retenidoAcum)), retencionPeriodo: ganRet, periodo: G.periodo || null };
  }

  // Descuento del anticipo de ajuste de sueldo abonado durante el mes (regularización).
  const antAjDesc = (tipo === 'mensual' || esQuincenal) ? num(opts?.anticipoAjusteDesc) : 0;
  if (antAjDesc > 0) descuentos.push({ concepto: 'Descuento anticipo ajuste de sueldo', monto: round2(antAjDesc) });

  // Suspensiones / ausencias (días no trabajados → descuento) + embargos.
  if ((tipo === 'mensual' || esQuincenal)) {
    const valorDia = (basico + presentismo + antiguedad + complemento) / 30;
    const dSusp = num(opts?.diasSuspension);
    if (dSusp > 0) descuentos.push({ concepto: `Suspensión disciplinaria (${dSusp} días)`, monto: round2(valorDia * dSusp) });
    const dAus = num(opts?.ausenciasInjustificadas);
    if (dAus > 0) descuentos.push({ concepto: `Ausencias injustificadas (${dAus} días)`, monto: round2(valorDia * dAus) });
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
  const neto = totalHaberes - totalDescuentos;

  // Costo del empleador (contribuciones patronales + SCVO) — sobre remunerativos
  const contribuciones = [];
  const co = (pct) => round2(totalRemun * num(pct) / 100);
  const cJub = co(p.pctJubPatronal), cOS = co(p.pctOsPatronal), cPami = co(p.pctPamiPatronal), cFne = co(p.pctDesempleo), cArt = co(p.pctArt), cSind = co(p.pctSindicatoPatronal);
  const scvo = round2(num(p.scvoPercapita));
  if (cJub > 0) contribuciones.push({ concepto: 'Jubilación patronal (SIPA)', monto: cJub });
  if (cOS > 0) contribuciones.push({ concepto: 'Obra Social patronal', monto: cOS });
  if (cPami > 0) contribuciones.push({ concepto: 'INSSJP patronal (PAMI)', monto: cPami });
  if (cFne > 0) contribuciones.push({ concepto: 'Fondo Nacional de Empleo', monto: cFne });
  if (cArt > 0) contribuciones.push({ concepto: 'ART', monto: cArt });
  if (cSind > 0) contribuciones.push({ concepto: 'Cuota sindical patronal', monto: cSind });
  if (scvo > 0) contribuciones.push({ concepto: 'SCVO (Dto. 1567/74)', monto: scvo });
  const totalContrib = contribuciones.reduce((s, x) => s + x.monto, 0);

  return {
    empleado: { legNum: emp.legNum, nom: emp.nom, empresa: emp.empresa, cuil: emp.cuil, cat: emp.cat },
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
