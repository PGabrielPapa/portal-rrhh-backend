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
  const presentismo = esFC ? 0 : (basico + antiguedad) * num(p.pctPresentismo) / 100;
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

export function calcularRecibo(emp, params, { anio, mes }) {
  const p = params || {};
  const d = emp.data || {};
  const esFC = !d.cod_sindicato || String(d.cod_sindicato).toUpperCase() === 'FC';

  const basico = num(d.basico) || num(d.sueldo) || num(emp.bruto);
  const anios = aniosAntiguedad(emp.ingreso, anio, mes);
  const antiguedad = esFC ? 0 : basico * anios * num(p.pctAntiguedadPorAnio) / 100;
  const presentismo = esFC ? 0 : (basico + antiguedad) * num(p.pctPresentismo) / 100;
  const complemento = num(d.complemento);
  const noRem = num(d.norem);

  const regularRemun = basico + antiguedad + presentismo + complemento;
  const esSAC = (mes === 6 || mes === 12);
  const sac = esSAC ? regularRemun * 0.5 : 0;

  const haberes = [{ concepto: 'Sueldo básico', tipo: 'rem', monto: round2(basico) }];
  if (antiguedad > 0) haberes.push({ concepto: `Antigüedad (${anios} año${anios !== 1 ? 's' : ''})`, tipo: 'rem', monto: round2(antiguedad) });
  if (presentismo > 0) haberes.push({ concepto: 'Presentismo', tipo: 'rem', monto: round2(presentismo) });
  if (complemento > 0) haberes.push({ concepto: 'Complemento variable', tipo: 'rem', monto: round2(complemento) });
  if (sac > 0) haberes.push({ concepto: `SAC (aguinaldo ${mes === 6 ? '1er' : '2do'} sem.)`, tipo: 'rem', monto: round2(sac) });
  if (noRem > 0) haberes.push({ concepto: 'Asignación no remunerativa', tipo: 'norem', monto: round2(noRem) });

  const totalRemun = regularRemun + sac;
  const totalNoRem = noRem;
  const totalHaberes = totalRemun + totalNoRem;

  // Aportes del trabajador (sobre remunerativos, incl. SAC)
  const descuentos = [];
  const aporte = (label, pct) => { const m = totalRemun * num(pct) / 100; if (m > 0) descuentos.push({ concepto: label, monto: round2(m) }); };
  aporte('Jubilación', p.pctJubilacion);
  aporte('Obra Social', p.pctObraSocial);
  aporte('ANSSAL', p.pctAnssal);
  aporte('INSSJP (PAMI)', p.pctPamiEmp);
  if (!esFC) aporte('Cuota sindical', p.pctSindicatoEmp);
  const totalAportes = descuentos.reduce((s, x) => s + x.monto, 0);

  const netoAntesGan = totalHaberes - totalAportes;

  // ── Ganancias 4ª (estimación anualizada) con tope del 35% ──
  // Base anual ≈ remuneración regular × 13 (12 + SAC). Deducciones: aportes +
  // MNI + deducción especial. Retención mensual = impuesto anual / 12, topeada
  // al 35% del neto del mes.
  const baseAnual = regularRemun * 13;
  const aportesAnual = (regularRemun * (num(p.pctJubilacion) + num(p.pctObraSocial) + num(p.pctAnssal) + num(p.pctPamiEmp) + (esFC ? 0 : num(p.pctSindicatoEmp))) / 100) * 13;
  const ganSujeta = Math.max(0, baseAnual - aportesAnual - num(GAN.mniAnual) - num(GAN.dedEspAnual) - num(GAN.dedEsp2Anual));
  const impAnual = impuestoEscala(ganSujeta, GAN.escala);
  let ganRet = impAnual / 12;
  const topePct = (p.gan_topeRetencionPct != null ? num(p.gan_topeRetencionPct) : 35);
  const tope = netoAntesGan * topePct / 100;
  let ganTopeada = false;
  if (ganRet > tope) { ganRet = tope; ganTopeada = true; }
  if (ganRet > 0) descuentos.push({ concepto: 'Impuesto a las Ganancias 4ª (estimación)' + (ganTopeada ? ` — tope ${topePct}%` : ''), monto: round2(ganRet) });

  const totalDescuentos = descuentos.reduce((s, x) => s + x.monto, 0);
  const neto = totalHaberes - totalDescuentos;

  // ── Costo del empleador (contribuciones patronales + SCVO) — no afecta el neto ──
  const contribuciones = [];
  const contrib = (label, pct) => { const m = totalRemun * num(pct) / 100; if (m > 0) contribuciones.push({ concepto: label, monto: round2(m) }); };
  contrib('Jubilación patronal (SIPA)', p.pctJubPatronal);
  contrib('Obra Social patronal', p.pctOsPatronal);
  contrib('INSSJP patronal (PAMI)', p.pctPamiPatronal);
  contrib('Fondo Nacional de Empleo', p.pctDesempleo);
  contrib('ART', p.pctArt);
  contrib('Cuota sindical patronal', p.pctSindicatoPatronal);
  const scvo = num(p.scvoPercapita);
  if (scvo > 0) contribuciones.push({ concepto: 'SCVO (Dto. 1567/74)', monto: round2(scvo) });
  const totalContrib = contribuciones.reduce((s, x) => s + x.monto, 0);

  return {
    empleado: { legNum: emp.legNum, nom: emp.nom, empresa: emp.empresa, cuil: emp.cuil, cat: emp.cat },
    periodo: { anio, mes },
    haberes, descuentos,
    totales: {
      totalRemun: round2(totalRemun), totalNoRem: round2(totalNoRem),
      totalHaberes: round2(totalHaberes), totalDescuentos: round2(totalDescuentos), neto: round2(neto),
    },
    costoEmpleador: { contribuciones, totalContrib: round2(totalContrib), costoTotal: round2(totalHaberes + totalContrib) },
    nota: 'Ganancias e antigüedad/SAC estimadas (sin SIRADIG ni embargos). En migración.',
  };
}
