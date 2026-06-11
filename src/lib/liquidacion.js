// Motor de liquidación — versión base (haberes remunerativos + no remunerativos,
// aportes del trabajador). Pendiente de iterar: SAC, vacaciones, ganancias,
// embargos, regímenes especiales (UOCRA/SEC). Usa los parámetros vigentes.

const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : 0; };
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

function aniosAntiguedad(ingreso, anio, mes) {
  if (!ingreso) return 0;
  const ing = new Date(ingreso);
  if (isNaN(ing)) return 0;
  const ref = new Date(anio, mes - 1, 1);
  let a = ref.getFullYear() - ing.getFullYear();
  if (ref.getMonth() < ing.getMonth()) a--;
  return Math.max(0, a);
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

  const haberes = [{ concepto: 'Sueldo básico', tipo: 'rem', monto: round2(basico) }];
  if (antiguedad > 0) haberes.push({ concepto: `Antigüedad (${anios} año${anios !== 1 ? 's' : ''})`, tipo: 'rem', monto: round2(antiguedad) });
  if (presentismo > 0) haberes.push({ concepto: 'Presentismo', tipo: 'rem', monto: round2(presentismo) });
  if (complemento > 0) haberes.push({ concepto: 'Complemento variable', tipo: 'rem', monto: round2(complemento) });
  if (noRem > 0) haberes.push({ concepto: 'Asignación no remunerativa', tipo: 'norem', monto: round2(noRem) });

  const totalRemun = basico + antiguedad + presentismo + complemento;
  const totalNoRem = noRem;
  const totalHaberes = totalRemun + totalNoRem;

  const descuentos = [];
  const aporte = (label, pct) => { const m = totalRemun * num(pct) / 100; if (m > 0) descuentos.push({ concepto: label, monto: round2(m) }); };
  aporte('Jubilación', p.pctJubilacion);
  aporte('Obra Social', p.pctObraSocial);
  aporte('ANSSAL', p.pctAnssal);
  aporte('INSSJP (PAMI)', p.pctPamiEmp);
  if (!esFC) aporte('Cuota sindical', p.pctSindicatoEmp);

  const totalDescuentos = descuentos.reduce((s, x) => s + x.monto, 0);
  const neto = totalHaberes - totalDescuentos;

  return {
    empleado: { legNum: emp.legNum, nom: emp.nom, empresa: emp.empresa, cuil: emp.cuil, cat: emp.cat },
    periodo: { anio, mes },
    haberes, descuentos,
    totales: {
      totalRemun: round2(totalRemun), totalNoRem: round2(totalNoRem),
      totalHaberes: round2(totalHaberes), totalDescuentos: round2(totalDescuentos), neto: round2(neto),
    },
    nota: 'Cálculo base (sin SAC, ganancias ni embargos). En migración.',
  };
}
