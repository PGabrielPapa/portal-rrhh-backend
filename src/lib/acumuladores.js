// ── Acumuladores configurables (inspirado en Tango Sueldos) ──
// Un acumulador suma/resta líneas de los recibos según REGLAS (sección + tipo de línea + patrón),
// sobre una VENTANA temporal (mensual, anual fiscal o rango). Todo configurable por el usuario.

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// Tipos de ventana
export const TIPOS_VENTANA = [
  ['MENSUAL', 'Mensual (el mes indicado)'],
  ['ANUAL_FISCAL', 'Acumulado anual (enero → mes)'],
  ['RANGO', 'Rango de meses'],
];
// Tipos de línea posibles en los recibos (atributo "tipo" de cada haber/descuento)
export const TIPOS_LINEA = [
  ['*', 'Cualquiera'],
  ['rem', 'Remunerativo'],
  ['norem', 'No remunerativo'],
  ['exento', 'Exento'],
  ['gravado', 'Gravado (Ganancias)'],
  ['aporte', 'Aporte'],
  ['anticipo', 'Anticipo'],
];
export const SECCIONES = [['haberes', 'Haberes'], ['descuentos', 'Descuentos']];

// Tipos de recibo incluidos por defecto en los acumulados (mismos que usa Ganancias).
export const TIPOS_RECIBO = ['mensual', 'quincenal_1', 'quincenal_2', 'vacaciones', 'complementaria', 'sac1', 'sac2', 'final'];

// Acumuladores por defecto (se siembran si la tabla está vacía).
export const DEFAULTS = [
  { codigo: 'TOTAL_REM', nombre: 'Total remunerativo', tipo: 'MENSUAL', afecta_ganancias: true, orden: 10,
    reglas: [{ seccion: 'haberes', tipoLinea: 'rem', patron: '', signo: 1 }] },
  { codigo: 'TOTAL_NOREM', nombre: 'Total no remunerativo', tipo: 'MENSUAL', afecta_ganancias: false, orden: 20,
    reglas: [{ seccion: 'haberes', tipoLinea: 'norem', patron: '', signo: 1 }] },
  { codigo: 'TOTAL_EXENTO', nombre: 'Total exento', tipo: 'MENSUAL', afecta_ganancias: false, orden: 30,
    reglas: [{ seccion: 'haberes', tipoLinea: 'exento', patron: '', signo: 1 }] },
  { codigo: 'TOTAL_BRUTO', nombre: 'Total bruto (haberes)', tipo: 'MENSUAL', afecta_ganancias: false, orden: 40,
    reglas: [{ seccion: 'haberes', tipoLinea: '*', patron: '', signo: 1 }] },
  { codigo: 'TOTAL_DESC', nombre: 'Total descuentos', tipo: 'MENSUAL', afecta_ganancias: false, orden: 50,
    reglas: [{ seccion: 'descuentos', tipoLinea: '*', patron: '', signo: 1 }] },
  { codigo: 'NETO', nombre: 'Neto a cobrar', tipo: 'MENSUAL', afecta_ganancias: false, orden: 60,
    reglas: [{ seccion: 'haberes', tipoLinea: '*', patron: '', signo: 1 }, { seccion: 'descuentos', tipoLinea: '*', patron: '', signo: -1 }] },
  { codigo: 'JUBILACION', nombre: 'Aportes Jubilación (acum.)', tipo: 'ANUAL_FISCAL', afecta_ganancias: true, orden: 70,
    reglas: [{ seccion: 'descuentos', tipoLinea: '*', patron: 'Jubilaci', signo: 1 }] },
  { codigo: 'OBRA_SOCIAL', nombre: 'Aportes Obra Social (acum.)', tipo: 'ANUAL_FISCAL', afecta_ganancias: true, orden: 80,
    reglas: [{ seccion: 'descuentos', tipoLinea: '*', patron: 'Obra Social|ANSSAL|INSSJP', signo: 1 }] },
  { codigo: 'SINDICAL', nombre: 'Cuota sindical (acum.)', tipo: 'ANUAL_FISCAL', afecta_ganancias: true, orden: 90,
    reglas: [{ seccion: 'descuentos', tipoLinea: '*', patron: 'sindical', signo: 1 }] },
  { codigo: 'RET_GANANCIAS', nombre: 'Retención Ganancias (acum.)', tipo: 'ANUAL_FISCAL', afecta_ganancias: false, orden: 100,
    reglas: [{ seccion: 'descuentos', tipoLinea: '*', patron: 'Ganancias', signo: 1 }] },
  { codigo: 'REM_GRAV_ACUM', nombre: 'Remuneración gravada (acum.)', tipo: 'ANUAL_FISCAL', afecta_ganancias: true, orden: 110,
    reglas: [{ seccion: 'haberes', tipoLinea: 'rem', patron: '', signo: 1 }] },
];

// ¿Una línea de recibo cumple alguna regla? Devuelve el signo (o 0 si no aplica).
function signoLinea(linea, seccion, reglas) {
  let s = 0;
  for (const r of reglas) {
    if (r.seccion !== seccion) continue;
    if (r.tipoLinea && r.tipoLinea !== '*' && String(linea.tipo || '') !== r.tipoLinea) continue;
    if (r.patron) { try { if (!new RegExp(r.patron, 'i').test(String(linea.concepto || ''))) continue; } catch { continue; } }
    s += Number(r.signo) || 0;
  }
  return s;
}

// Suma un acumulador sobre una lista de recibos (cada uno con data.haberes / data.descuentos).
export function sumarAcumulador(recibos, reglas) {
  let total = 0;
  for (const rec of recibos) {
    const data = rec.data || rec;
    for (const h of (data.haberes || [])) total += signoLinea(h, 'haberes', reglas) * (Number(h.monto) || 0);
    for (const d of (data.descuentos || [])) total += signoLinea(d, 'descuentos', reglas) * (Number(d.monto) || 0);
  }
  return round2(total);
}

// Filtra los recibos relevantes según la ventana del acumulador.
export function recibosDeVentana(recibos, tipoVentana, mes, mesDesde, mesHasta) {
  const m = Number(mes) || 12;
  if (tipoVentana === 'MENSUAL') return recibos.filter((r) => Number(r.mes) === m);
  if (tipoVentana === 'RANGO') { const a = Number(mesDesde) || 1, b = Number(mesHasta) || 12; return recibos.filter((r) => Number(r.mes) >= a && Number(r.mes) <= b); }
  return recibos.filter((r) => Number(r.mes) <= m); // ANUAL_FISCAL: enero..mes
}
