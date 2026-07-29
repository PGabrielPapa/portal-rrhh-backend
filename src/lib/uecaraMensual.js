// Liquidación mensual UECARA / fuera de convenio con escala IDEE-BIM.
// Estructura decodificada de los recibos reales (validada al peso):
//   Sueldo (básico) + Presentismo 10% (Bonif. asist. perfecta) + Complemento función + Antigüedad
//   + Adicional título + Plus feriado NT ; menos aportes ; más Suma No Remunerativa (con OS 3%).
//
//   • UECARA con escala BIM: básico = básico de convenio; complemento = escalaBIM − básico − presentismo.
//   • Fuera de convenio con escala BIM: básico = escala BIM completa (sin presentismo ni complemento).
//   • Solo convenio UECARA: básico de convenio + presentismo (sin complemento).
//   • Socio monto fijo: básico = monto fijo.
//
//   Antigüedad = $13.332 × años (valor jul-2026). Título: secundario 49.820 / terciario-univ 72.944.
//   Aportes: Jubilación 11% + Ley 19.032 3% + Obra Social 3% + Aporte esp. art.37 I 1,5% + Aporte solid. art.37 II 1%.
//   Suma No Remunerativa: solo UECARA, valor por categoría; se le descuenta solo Obra Social 3%.

const r2 = (x) => Math.round((Number(x) || 0) * 100) / 100;
const n = (x) => Number(x) || 0;

export const ANTIGUEDAD_ANUAL_UECARA = 13332;       // $ por año (jul-2026)
export const TITULO_UECARA = { secundario: 49820, terciario: 72944, universitario: 72944 };
export const PRESENTISMO_PCT = 10;                  // % sobre básico
// Aportes (sobre remunerativo)
export const APORTES_UECARA = [
  { concepto: 'Jubilación 11%', pct: 11 },
  { concepto: 'Ley 19.032 3%', pct: 3 },
  { concepto: 'Obra Social 3%', pct: 3 },
  { concepto: 'Aporte especial art.37 I 1,5%', pct: 1.5 },
  { concepto: 'Aporte solidario art.37 II 1%', pct: 1 },
];
const OS_SNR_PCT = 3;

// inp: { tipoLiq:'uecara_bim'|'fuera_bim'|'solo_convenio'|'fijo',
//        basicoConvenio, escalaBim, montoFijo, aniosAntiguedad, titulo, snr, plusFeriado }
export function calcUecara(inp) {
  const tipo = inp.tipoLiq;
  const esUecara = tipo === 'uecara_bim' || tipo === 'solo_convenio';
  // Básico
  let basico;
  if (tipo === 'fijo') basico = n(inp.montoFijo);
  else if (tipo === 'fuera_bim') basico = n(inp.escalaBim);
  else basico = n(inp.basicoConvenio);
  basico = r2(basico);
  // Presentismo 10% (solo UECARA)
  const presentismo = esUecara ? r2(basico * PRESENTISMO_PCT / 100) : 0;
  // Complemento función (solo UECARA con escala BIM)
  const complemento = tipo === 'uecara_bim' ? r2(n(inp.escalaBim) - basico - presentismo) : 0;
  // Antigüedad y adicional título: SOLO UECARA (los fuera de convenio no cobran beneficios de convenio).
  const antiguedad = esUecara ? r2(ANTIGUEDAD_ANUAL_UECARA * n(inp.aniosAntiguedad)) : 0;
  const tituloAdic = esUecara ? r2(TITULO_UECARA[String(inp.titulo || '').toLowerCase()] || 0) : 0;
  const plusFeriado = r2(inp.plusFeriado);   // feriado no trabajado: aplica a todos (input/novedad)

  const haberes = [];
  haberes.push({ concepto: 'Sueldo', tipo: 'rem', monto: basico });
  if (complemento) haberes.push({ concepto: 'Complemento función', tipo: 'rem', monto: complemento });
  if (tituloAdic) haberes.push({ concepto: inp.titulo && String(inp.titulo).toLowerCase() === 'secundario' ? 'Adicional título secundario' : 'Adicional título terc./univ.', tipo: 'rem', monto: tituloAdic });
  if (presentismo) haberes.push({ concepto: 'Bonific. asist. perfecta (presentismo 10%)', tipo: 'rem', monto: presentismo });
  if (antiguedad) haberes.push({ concepto: 'Antigüedad', tipo: 'rem', monto: antiguedad });
  if (plusFeriado) haberes.push({ concepto: 'Plus feriado NT', tipo: 'rem', monto: plusFeriado });

  const totalRemun = r2(haberes.reduce((s, h) => s + h.monto, 0));

  // Suma No Remunerativa (solo UECARA)
  const snr = esUecara ? r2(inp.snr) : 0;
  if (snr) haberes.push({ concepto: 'Suma no remunerativa', tipo: 'norem', monto: snr });

  // Aportes sobre remunerativo
  const descuentos = APORTES_UECARA.map((a) => ({ concepto: a.concepto, monto: r2(totalRemun * a.pct / 100) }));
  const osSnr = r2(snr * OS_SNR_PCT / 100);
  if (osSnr) descuentos.push({ concepto: 'Obra Social 3% s/No Rem.', monto: osSnr });

  const totalDescuentos = r2(descuentos.reduce((s, d) => s + d.monto, 0));
  const totalNoRem = snr;
  const totalHaberes = r2(totalRemun + totalNoRem);
  const neto = r2(totalHaberes - totalDescuentos);

  return {
    haberes, descuentos,
    totales: { totalRemun, totalNoRem, totalExento: 0, totalHaberes, totalDescuentos, neto },
    detalle: { basico, presentismo, complemento, antiguedad, tituloAdic, plusFeriado, snr },
  };
}
