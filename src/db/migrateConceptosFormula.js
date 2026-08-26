// Migración a conceptos EJECUTABLES por fórmula (proyecto por fases).
// Da de alta / actualiza conceptos con `esFormula=true` y un `rol` que enlaza cada concepto con
// el cálculo nativo del motor. Cuando un concepto con rol está activo, el motor SALTEA el nativo
// (ver liquidacion.js, _rolActivo). Con red de seguridad: si el concepto no existe o su fórmula
// falla, corre el nativo. Idempotente: upsert por código (a diferencia del seed, que hace DO NOTHING).
//
// FASE 1: SAC (aguinaldo) = 50% de la mejor remuneración del semestre. Variable: sacBase.
// FASE 2: APORTES del trabajador (jubilación, PAMI, obra social, ANSSAL, cuota/solidario).
//   Se evalúan en 2ª pasada con la base ya calculada. Variables: baseAportes, baseAportesOs,
//   pctJubilacion, pctPami, pctObraSocial, pctAnssal, pctCuotaSindical, pctSolidario, afiliado, noAfiliado.
import { query } from '../db.js';

// data: { esFormula, base, rol, tipos?, condicion?, orden }
const CONCEPTOS = [
  { codigo: '9101', descripcion: 'SAC (50% mejor remuneración)', formula: 'sacBase / 2',
    base_legal: 'Ley 23.041 / Art. 121 LCT', data: { esFormula: true, base: 'rem', rol: 'sac', tipos: ['sac1', 'sac2'], orden: 10 } },

  // ── Aportes del trabajador (base = descuento; rol = enlace al nativo) ──
  { codigo: '20000', descripcion: 'Jubilación', formula: 'baseAportes * pctJubilacion / 100',
    base_legal: 'Ley 24.241 (SIPA) — 11%', data: { esFormula: true, base: 'descuento', rol: 'jubilacion', orden: 100 } },
  { codigo: '20100', descripcion: 'INSSJP (PAMI)', formula: 'baseAportes * pctPami / 100',
    base_legal: 'Ley 19.032 — 3%', data: { esFormula: true, base: 'descuento', rol: 'pami', orden: 101 } },
  { codigo: '20200', descripcion: 'Obra Social', formula: 'baseAportesOs * pctObraSocial / 100',
    base_legal: 'Ley 23.660 — 3% (2,55% OS)', data: { esFormula: true, base: 'descuento', rol: 'obra_social', orden: 102 } },
  { codigo: '20400', descripcion: 'ANSSAL', formula: 'baseAportesOs * pctAnssal / 100',
    base_legal: 'Ley 23.661 — 0,45%', data: { esFormula: true, base: 'descuento', rol: 'anssal', orden: 103 } },
  { codigo: '20900', descripcion: 'Cuota sindical', formula: 'baseAportes * pctCuotaSindical / 100',
    base_legal: 'CCT — cuota afiliado', data: { esFormula: true, base: 'descuento', rol: 'sindical', condicion: 'afiliado', orden: 104 } },
  { codigo: '20902', descripcion: 'Aporte solidario', formula: 'baseAportes * pctSolidario / 100',
    base_legal: 'CCT — aporte solidario no afiliado', data: { esFormula: true, base: 'descuento', rol: 'sindical', condicion: 'noAfiliado && pctSolidario > 0', orden: 105 } },

  // ── FASE 3: Feriados y plus LCT (formato cantidad × valor, para mostrar la cantidad de días) ──
  // Feriado trabajado: un jornal adicional (básico/30) por feriado trabajado.
  { codigo: '6600', descripcion: 'Feriados trabajados', formula: 'feriados * basico / 30',
    base_legal: 'Art. 166/168 LCT', data: { esFormula: true, base: 'rem', rol: 'feriado_trab', cantidad: 'feriados', valorUnit: 'basico / 30', unidad: 'feriados', orden: 40 } },
  // Feriado NO trabajado (escala unificada): se paga a mes/25 y se resta lo que ya venía en el sueldo (mes/30).
  { codigo: '6610', descripcion: 'Feriado', formula: 'feriadosNoTrab * (basico + antiguedad_monto) / 25',
    base_legal: 'Plus LCT — feriado no trabajado', data: { esFormula: true, base: 'rem', rol: 'feriado_no_trab', cantidad: 'feriadosNoTrab', valorUnit: '(basico + antiguedad_monto) / 25', unidad: 'días', orden: 41 } },
  { codigo: '6611', descripcion: 'Reducción feriado', formula: '-feriadosNoTrab * (basico + antiguedad_monto) / 30',
    base_legal: 'Plus LCT — reducción feriado (mes/30)', data: { esFormula: true, base: 'rem', rol: 'feriado_no_trab', cantidad: 'feriadosNoTrab', valorUnit: '-(basico + antiguedad_monto) / 30', unidad: 'días', orden: 42 } },
  // Licencia con goce, DETALLADA POR TIPO (mes/25 sobre básico + antig + complemento, menos mes/30).
  // Todas comparten rol 'licencia_goce' → reemplazan al nativo. Cada una usa su variable de días.
  // Vacaciones:
  { codigo: '5801', descripcion: 'Vacaciones', formula: 'diasVacaciones * (basico + antiguedad_monto + complemento) / 25',
    base_legal: 'Art. 150/155 LCT — plus vacaciones', data: { esFormula: true, base: 'rem', rol: 'licencia_goce', cantidad: 'diasVacaciones', valorUnit: '(basico + antiguedad_monto + complemento) / 25', unidad: 'días', orden: 43 } },
  { codigo: '5802', descripcion: 'Reducción vacaciones', formula: '-diasVacaciones * (basico + antiguedad_monto + complemento) / 30',
    base_legal: 'Plus LCT — reducción (mes/30)', data: { esFormula: true, base: 'rem', rol: 'licencia_goce', cantidad: 'diasVacaciones', valorUnit: '-(basico + antiguedad_monto + complemento) / 30', unidad: 'días', orden: 44 } },
  // Examen (Art. 158 inc. d):
  { codigo: '5803', descripcion: 'Licencia Examen', formula: 'diasExamen * (basico + antiguedad_monto + complemento) / 25',
    base_legal: 'Art. 158 inc. d LCT', data: { esFormula: true, base: 'rem', rol: 'licencia_goce', cantidad: 'diasExamen', valorUnit: '(basico + antiguedad_monto + complemento) / 25', unidad: 'días', orden: 45 } },
  { codigo: '5804', descripcion: 'Reducción examen', formula: '-diasExamen * (basico + antiguedad_monto + complemento) / 30',
    base_legal: 'Plus LCT — reducción (mes/30)', data: { esFormula: true, base: 'rem', rol: 'licencia_goce', cantidad: 'diasExamen', valorUnit: '-(basico + antiguedad_monto + complemento) / 30', unidad: 'días', orden: 46 } },
  // Otras licencias con goce (matrimonio, nacimiento, fallecimiento, mudanza, etc.):
  { codigo: '5805', descripcion: 'Licencia con goce (otras)', formula: 'diasLicOtras * (basico + antiguedad_monto + complemento) / 25',
    base_legal: 'Art. 158 LCT — otras licencias con goce', data: { esFormula: true, base: 'rem', rol: 'licencia_goce', cantidad: 'diasLicOtras', valorUnit: '(basico + antiguedad_monto + complemento) / 25', unidad: 'días', orden: 47 } },
  { codigo: '5806', descripcion: 'Reducción licencias (otras)', formula: '-diasLicOtras * (basico + antiguedad_monto + complemento) / 30',
    base_legal: 'Plus LCT — reducción (mes/30)', data: { esFormula: true, base: 'rem', rol: 'licencia_goce', cantidad: 'diasLicOtras', valorUnit: '-(basico + antiguedad_monto + complemento) / 30', unidad: 'días', orden: 48 } },

  // ── FASE 4: haberes "valor interno" (alimentan otros cálculos; se muestran en su línea nativa) ──
  // El concepto define su VALOR (fórmula editable); el motor lo realimenta. La ANTIGÜEDAD queda fuera
  // de la escala; el PRESENTISMO es el pleno (base × %); el COMPLEMENTO puentea hasta la escala.
  // Antigüedad: si el convenio tiene monto fijo por año (UECARA) lo usa; si no, el % del básico.
  { codigo: '100', descripcion: 'Antigüedad', formula: 'SI(montoAntigPorAnio > 0, montoAntigPorAnio * anios, basico * anios * pctAntigPorAnio / 100)',
    base_legal: 'CCT — % por año o monto fijo por año (UECARA)', data: { esFormula: true, base: 'rem', rol: 'antiguedad', orden: 20 } },
  { codigo: '8000', descripcion: 'Presentismo', formula: 'basePres * pctPresentismo / 100',
    base_legal: 'CCT — presentismo pleno', data: { esFormula: true, base: 'rem', rol: 'presentismo', orden: 21 } },
  // Complemento: resta el No Rem salvo que el convenio lo excluya (UECARA → complementoSinNoRem).
  { codigo: '8700', descripcion: 'Complemento función', formula: 'MAXIMO(0, escalaObjetivo - (basico + presentismoPleno + aCuenta + SI(complementoSinNoRem, 0, norem)))',
    base_legal: 'Escala (mejor de convenio vs escala); UECARA sin No Rem', data: { esFormula: true, base: 'rem', rol: 'complemento', condicion: 'escalaObjetivo > 0', orden: 22 } },
  // Adicional por título (rol 'titulo'): el importe sale de la tabla Sindicatos por convenio
  // (titulo_secundario / titulo_universitario) según el nivel cargado en el legajo. El TERCIARIO
  // liquida con el monto de secundario/técnico. Fuera de convenio no lo cobra (es beneficio de CCT).
  { codigo: '8800', descripcion: 'Adicional por título', formula: 'SI(esTituloUniversitario, tituloUniversitario, SI(esTituloSecundario + esTituloTerciario > 0, tituloSecundario, 0))',
    base_legal: 'CCT — adicional por título (monto por convenio en Sindicatos)', data: { esFormula: true, base: 'rem', rol: 'titulo', condicion: 'esFueraConvenio == 0', orden: 23 } },

  // ── SUELDO BÁSICO (rol 'basico'). Sale de la ESCALA del convenio segun la categoria del legajo;
  //    si esa categoria no matchea en la escala vigente, cae al basico cargado en el legajo.
  //    La matriz de antiguedad queda disponible como variable (basicoMatriz) pero YA NO tiene prioridad.
  { codigo: '1', descripcion: 'Sueldo básico', formula: 'SI(convBasico > 0, convBasico, SI(basicoLegajo > 0, basicoLegajo, SI(sueldoLegajo > 0, sueldoLegajo, brutoLegajo)))',
    base_legal: 'Escala del convenio por categoría (Escalas/convenios)', data: { esFormula: true, base: 'rem', rol: 'basico', orden: 10 } },

  // ── ASIGNACIÓN NO REMUNERATIVA (rol 'norem'). Sale del bono de acuerdo cargado en la escala del
  //    convenio (bloque "NR" de Escalas/convenios); si el convenio no tiene ninguno vigente, usa el
  //    monto cargado en el legajo. Se actualiza con las paritarias junto con los basicos.
  { codigo: '58500', descripcion: 'Asignación no remunerativa (acuerdo paritario)', formula: 'SI(noRemConvenio > 0, noRemConvenio, noRemLegajo)',
    base_legal: 'Acuerdo paritario del convenio — suma no remunerativa', data: { esFormula: true, base: 'norem', rol: 'norem', orden: 30 } },

  // ── A CUENTA DE FUTUROS AUMENTOS (rol 'acuenta'). Monto por empleado, cargado en el legajo.
  //    Si el legajo no tiene monto, el concepto no trae nada (condicion aCuentaLegajo > 0).
  { codigo: '8810', descripcion: 'A cuenta de futuros aumentos', formula: 'aCuentaLegajo',
    base_legal: 'Monto a cuenta acordado con el empleado', data: { esFormula: true, base: 'rem', rol: 'acuenta', condicion: 'aCuentaLegajo > 0', orden: 24 } },

  // ── FASE 5: UECARA (alcance UECARA). Con "aportes propios", solo estos aportes aplican (sin ANSSAL/cuota).
  //    Los % se leen de Sindicatos (pctArt37_1/2); jub y PAMI de parámetros. Plus feriado = remun/150.
  { codigo: 'UEC-FER', descripcion: 'Plus feriado NT', formula: 'feriadosNoTrab * remun / 150',
    base_legal: 'UECARA — plus feriado no trabajado', data: { esFormula: true, base: 'rem', rol: 'feriado_no_trab', alcanceConvenio: 'UECARA', cantidad: 'feriadosNoTrab', valorUnit: 'remun / 150', unidad: 'feriados', orden: 45 } },
  { codigo: 'UEC-JUB', descripcion: 'Jubilación 11%', formula: 'baseAportes * pctJubilacion / 100',
    base_legal: 'Ley 24.241', data: { esFormula: true, base: 'descuento', rol: 'jubilacion', alcanceConvenio: 'UECARA', orden: 110 } },
  { codigo: 'UEC-PAMI', descripcion: 'Ley 19.032 3%', formula: 'baseAportes * pctPami / 100',
    base_legal: 'Ley 19.032', data: { esFormula: true, base: 'descuento', rol: 'pami', alcanceConvenio: 'UECARA', orden: 111 } },
  { codigo: 'UEC-OS', descripcion: 'Obra Social 3%', formula: 'baseAportes * 3 / 100',
    base_legal: 'Ley 23.660 — UECARA 3%', data: { esFormula: true, base: 'descuento', rol: 'obra_social', alcanceConvenio: 'UECARA', orden: 112 } },
  { codigo: 'UEC-A37I', descripcion: 'Aporte especial Art.37 I 1,5%', formula: 'baseAportes * pctArt37_1 / 100',
    base_legal: 'CCT 660/13 Art. 37 I', data: { esFormula: true, base: 'descuento', rol: 'art37_1', alcanceConvenio: 'UECARA', orden: 113 } },
  { codigo: 'UEC-A37II', descripcion: 'Aporte solidario Art.37 II 1%', formula: 'baseAportes * pctArt37_2 / 100',
    base_legal: 'CCT 660/13 Art. 37 II', data: { esFormula: true, base: 'descuento', rol: 'art37_2', alcanceConvenio: 'UECARA', orden: 114 } },
  { codigo: 'UEC-OSNR', descripcion: 'Obra Social 3% s/No Rem', formula: 'norem * 3 / 100',
    base_legal: 'OS 3% sobre suma no remunerativa', data: { esFormula: true, base: 'descuento', rol: 'os_norem', alcanceConvenio: 'UECARA', condicion: 'norem > 0', orden: 115 } },

  // ── FASE 6: Fuera de convenio IDEE (alcance FC). Básico = escala BIM; aportes jub 11% + PAMI 3% + OS 3%
  //    (sin ANSSAL/cuota/Art.37). El socio/monto fijo se marca en el legajo con data.sinAportes = true.
  { codigo: 'FC-JUB', descripcion: 'Jubilación 11%', formula: 'baseAportes * pctJubilacion / 100',
    base_legal: 'Ley 24.241', data: { esFormula: true, base: 'descuento', rol: 'jubilacion', alcanceConvenio: 'FC', orden: 120 } },
  { codigo: 'FC-PAMI', descripcion: 'Ley 19.032 3%', formula: 'baseAportes * pctPami / 100',
    base_legal: 'Ley 19.032', data: { esFormula: true, base: 'descuento', rol: 'pami', alcanceConvenio: 'FC', orden: 121 } },
  { codigo: 'FC-OS', descripcion: 'Obra Social 3%', formula: 'baseAportes * 3 / 100',
    base_legal: 'Ley 23.660 — 3%', data: { esFormula: true, base: 'descuento', rol: 'obra_social', alcanceConvenio: 'FC', orden: 122 } },

  // ── FASE 7: JORNAL UOCRA (alcance UOCRA). Base = horas × valor hora; el resto, conceptos.
  //    Variables: valorHora, horasNormales, he50/he100 (horas extra), feriadosNoTrab, diasLicenciaConGoce,
  //    jornadaHoras, snrJornal, esQuincena, ausencias, pctPremio (todas expuestas por el motor).
  { codigo: 'J-HORAS', descripcion: 'Horas trabajadas', formula: 'horasNormales * valorHora',
    base_legal: 'Jornal UOCRA — horas normales × valor hora', data: { esFormula: true, base: 'rem', alcanceConvenio: 'UOCRA', cantidad: 'horasNormales', valorUnit: 'valorHora', unidad: 'hs', orden: 10 } },
  { codigo: 'J-EXT50', descripcion: 'Horas extra 50%', formula: 'he50 * valorHora * 1.5',
    base_legal: 'Horas extra 50%', data: { esFormula: true, base: 'rem', alcanceConvenio: 'UOCRA', cantidad: 'he50', valorUnit: 'valorHora * 1.5', unidad: 'hs', orden: 11 } },
  { codigo: 'J-EXT100', descripcion: 'Horas extra 100%', formula: 'he100 * valorHora * 2',
    base_legal: 'Horas extra 100%', data: { esFormula: true, base: 'rem', alcanceConvenio: 'UOCRA', cantidad: 'he100', valorUnit: 'valorHora * 2', unidad: 'hs', orden: 12 } },
  { codigo: 'J-PREMIO', descripcion: 'Premio asistencia', formula: 'SI(ausencias == 0, horasNormales * valorHora * pctPremio / 100, 0)',
    base_legal: 'Premio asistencia (se pierde con injustificadas)', data: { esFormula: true, base: 'rem', alcanceConvenio: 'UOCRA', condicion: 'ausencias == 0', orden: 13 } },
  { codigo: 'J-FER', descripcion: 'Horas feriado', formula: 'feriadosNoTrab * valorHora * jornadaHoras * 30 / 25',
    base_legal: 'Feriado no trabajado (jornal)', data: { esFormula: true, base: 'rem', rol: 'feriado_no_trab', alcanceConvenio: 'UOCRA', condicion: 'feriadosNoTrab > 0', orden: 14 } },
  { codigo: 'J-LIC', descripcion: 'Licencia (jornal)', formula: 'diasLicenciaConGoce * valorHora * jornadaHoras',
    base_legal: 'Días de licencia paga × valor día', data: { esFormula: true, base: 'rem', rol: 'licencia_goce', alcanceConvenio: 'UOCRA', condicion: 'diasLicenciaConGoce > 0', orden: 15 } },
  { codigo: 'J-BONO', descripcion: 'Bono no remunerativo (acuerdo UOCRA)', formula: 'snrJornal * SI(esQuincena, 0.5, 1)',
    base_legal: 'SNR por mitades por quincena', data: { esFormula: true, base: 'norem', alcanceConvenio: 'UOCRA', condicion: 'snrJornal > 0', orden: 16 } },
  { codigo: 'J-OSNR', descripcion: 'Obra Social s/No Rem', formula: 'snrJornal * SI(esQuincena, 0.5, 1) * 3 / 100',
    base_legal: 'OS 3% sobre el bono no remunerativo', data: { esFormula: true, base: 'descuento', rol: 'os_norem', alcanceConvenio: 'UOCRA', condicion: 'snrJornal > 0', orden: 130 } },
  // Aportes del jornal (base = total remunerativo con tope). Con "aportes propios" no se cuela ANSSAL.
  { codigo: 'J-JUB', descripcion: 'Jubilación 11%', formula: 'baseAportes * pctJubilacion / 100',
    base_legal: 'Ley 24.241', data: { esFormula: true, base: 'descuento', rol: 'jubilacion', alcanceConvenio: 'UOCRA', orden: 131 } },
  { codigo: 'J-PAMI', descripcion: 'Ley 19.032 3%', formula: 'baseAportes * pctPami / 100',
    base_legal: 'Ley 19.032', data: { esFormula: true, base: 'descuento', rol: 'pami', alcanceConvenio: 'UOCRA', orden: 132 } },
  { codigo: 'J-OS', descripcion: 'Obra Social 3%', formula: 'baseAportes * 3 / 100',
    base_legal: 'Ley 23.660 — 3%', data: { esFormula: true, base: 'descuento', rol: 'obra_social', alcanceConvenio: 'UOCRA', orden: 133 } },
  { codigo: 'J-COMPOS', descripcion: 'Comp. Obra Social', formula: 'baseAportes * 3 / 100',
    base_legal: 'Complemento OS jornada reducida (duplica el 3%)', data: { esFormula: true, base: 'descuento', rol: 'os_comp', alcanceConvenio: 'UOCRA', condicion: 'esParcial', orden: 136 } },
  { codigo: 'J-CUOTA', descripcion: 'Cuota sindical UOCRA', formula: 'baseAportes * pctCuotaSindical / 100',
    base_legal: 'CCT — cuota afiliado', data: { esFormula: true, base: 'descuento', rol: 'sindical', alcanceConvenio: 'UOCRA', condicion: 'afiliado', orden: 134 } },
  { codigo: 'J-SOL', descripcion: 'Aporte solidario UOCRA', formula: 'baseAportes * pctSolidario / 100',
    base_legal: 'CCT — aporte solidario no afiliado', data: { esFormula: true, base: 'descuento', rol: 'sindical', alcanceConvenio: 'UOCRA', condicion: 'noAfiliado', orden: 135 } },
];

export async function migrarConceptosFormula() {
  let tocados = 0;
  for (const c of CONCEPTOS) {
    const r = await query(
      `INSERT INTO conceptos (codigo, descripcion, tipo, formula, base_legal, data, activo)
       VALUES ($1,$2,$3,$4,$5,$6,true)
       ON CONFLICT (codigo) DO UPDATE SET
         descripcion=EXCLUDED.descripcion, formula=EXCLUDED.formula, base_legal=EXCLUDED.base_legal,
         data = COALESCE(conceptos.data,'{}'::jsonb) || EXCLUDED.data, activo=true`,
      [c.codigo, c.descripcion, c.data.base === 'descuento' ? 'descuento' : c.data.base === 'norem' ? 'no_remunerativo' : 'remunerativo',
       c.formula, c.base_legal || null, JSON.stringify(c.data)]);
    tocados += r.rowCount;
  }
  return { skip: false, tocados };
}
