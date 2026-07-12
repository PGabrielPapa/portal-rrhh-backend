// src/lib/sicoss.js
//
// Generador del archivo posicional SICOSS (F.931 de ARCA/AFIP) — diseño de
// registro versión 42. Registro de 499 caracteres, 60 campos, sin delimitadores.
//
// Layout tomado del diseño de registro oficial (AFIP) documentado por
// SIU-Mapuche v3.28.2. Las longitudes se DERIVAN de las posiciones DESDE
// (la fuente trae una errata en el campo 2: declara 40 pero las posiciones dan
// 30). El total cierra exacto en 499; el módulo lo verifica al cargarse.
//
// Formato por campo:
//   int  -> entero, derecha, ceros a la izquierda
//   char -> texto, izquierda, espacios a la derecha (ASCII sin tildes, mayúsc.)
//   dec  -> importe, derecha, ceros, con punto y 2 decimales (long = enteros+3)

// [Nº, DESDE, formato, srcKey, etiqueta]
const LAYOUT = [
  [1, 1, 'int', 'cuil', 'CUIL'],
  [2, 12, 'char', 'nombre', 'Apellido y Nombre'],
  [3, 42, 'int', 'conyuge', 'Conyuge'],
  [4, 43, 'int', 'hijos', 'Cantidad de Hijos'],
  [5, 45, 'int', 'codigoSituacion', 'Codigo de Situacion'],
  [6, 47, 'int', 'codigoCondicion', 'Codigo de Condicion'],
  [7, 49, 'int', 'codigoActividad', 'Codigo de Actividad'],
  [8, 52, 'int', 'codigoZona', 'Codigo de Zona'],
  [9, 54, 'dec', 'porcAporteAdicSS', 'Porcentaje de Aporte Adicional SS'],
  [10, 59, 'int', 'codigoModalidad', 'Codigo de Modalidad de Contratacion'],
  [11, 62, 'int', 'codigoObraSocial', 'Codigo de Obra Social'],
  [12, 68, 'int', 'adherentes', 'Cantidad de Adherentes'],
  [13, 70, 'dec', 'remTotal', 'Remuneracion Total'],
  [14, 82, 'dec', 'remImp1', 'Remuneracion Imponible 1'],
  [15, 94, 'dec', 'asigFamiliares', 'Asignaciones Familiares Pagadas'],
  [16, 103, 'dec', 'aporteVoluntario', 'Importe Aporte Voluntario'],
  [17, 112, 'dec', 'adicionalOS', 'Importe Adicional OS'],
  [18, 121, 'dec', 'excedentesSS', 'Importe Excedentes Aportes SS'],
  [19, 130, 'dec', 'excedentesOS', 'Importe Excedentes Aportes OS'],
  [20, 139, 'char', 'provinciaLocalidad', 'Provincia Localidad'],
  [21, 189, 'dec', 'remImp2', 'Remuneracion Imponible 2'],
  [22, 201, 'dec', 'remImp3', 'Remuneracion Imponible 3'],
  [23, 213, 'dec', 'remImp4', 'Remuneracion Imponible 4'],
  [24, 225, 'int', 'codigoSiniestrado', 'Codigo de Siniestrado'],
  [25, 227, 'int', 'marcaReduccion', 'Marca de Corresponde Reduccion'],
  [26, 228, 'dec', 'capitalLRT', 'Capital de Recomposicion de LRT'],
  [27, 237, 'int', 'tipoEmpresa', 'Tipo de empresa'],
  [28, 238, 'dec', 'aporteAdicOS', 'Aporte Adicional de Obra Social'],
  [29, 247, 'int', 'regimen', 'Regimen'],
  [30, 248, 'int', 'sitRevista1', 'Situacion de Revista 1'],
  [31, 250, 'int', 'diaSitRevista1', 'Dia inicio Situacion de Revista 1'],
  [32, 252, 'int', 'sitRevista2', 'Situacion de Revista 2'],
  [33, 254, 'int', 'diaSitRevista2', 'Dia inicio Situacion de Revista 2'],
  [34, 256, 'int', 'sitRevista3', 'Situacion de Revista 3'],
  [35, 258, 'int', 'diaSitRevista3', 'Dia inicio Situacion de Revista 3'],
  [36, 260, 'dec', 'sueldoAdicionales', 'Sueldo + Adicionales'],
  [37, 272, 'dec', 'sac', 'SAC'],
  [38, 284, 'dec', 'horasExtras', 'Horas Extras'],
  [39, 296, 'dec', 'zonaDesfavorable', 'Zona desfavorable'],
  [40, 308, 'dec', 'vacaciones', 'Vacaciones'],
  [41, 320, 'int', 'diasTrabajados', 'Cantidad de dias trabajados'],
  [42, 329, 'dec', 'remImp5', 'Remuneracion Imponible 5'],
  [43, 341, 'int', 'trabajadorConvencionado', 'Trabajador Convencionado'],
  [44, 342, 'dec', 'remImp6', 'Remuneracion Imponible 6'],
  [45, 354, 'int', 'tipoOperacion', 'Tipo de Operacion'],
  [46, 355, 'dec', 'importeAdicionales', 'Importe Adicionales'],
  [47, 367, 'dec', 'importePremios', 'Importe Premios'],
  [48, 379, 'dec', 'remImp8', 'Remuneracion 788/05 - Rem. Imp. 8'],
  [49, 391, 'dec', 'rem7', 'Remuneracion 7'],
  [50, 403, 'int', 'cantHorasExtras', 'Cantidad de Horas Extras'],
  [51, 406, 'dec', 'noRemunerativo', 'Conceptos no remunerativos'],
  [52, 418, 'dec', 'maternidad', 'Maternidad'],
  [53, 430, 'dec', 'rectificacion', 'Rectificacion de remuneracion'],
  [54, 439, 'dec', 'remImp9', 'Remuneracion Imponible 9'],
  [55, 451, 'dec', 'contribTareaDif', 'Contribucion tarea Diferencial'],
  [56, 460, 'int', 'horasTrabajadas', 'Horas trabajadas'],
  [57, 463, 'int', 'seguroVida', 'Seguro de Vida Obligatorio'],
  [58, 464, 'dec', 'detraccion27430', 'Importe a detraer Ley 27430'],
  [59, 476, 'dec', 'incrementoSalarial', 'Incremento salarial'],
  [60, 488, 'dec', 'remImp11', 'Remuneracion imponible 11'],
];

export const RECORD_LEN = 499;

export const FIELDS = LAYOUT.map((f, i) => {
  const [n, desde, fmt, src, label] = f;
  const nextDesde = i + 1 < LAYOUT.length ? LAYOUT[i + 1][1] : RECORD_LEN + 1;
  return { n, desde, long: nextDesde - desde, fmt, src, label };
});

// Verificación de integridad del layout (corre al importar el módulo).
(function assertLayout() {
  let pos = 1;
  for (const f of FIELDS) {
    if (f.desde !== pos) throw new Error(`SICOSS layout: campo ${f.n} DESDE=${f.desde} esperado ${pos}`);
    if (f.long <= 0) throw new Error(`SICOSS layout: campo ${f.n} long invalida ${f.long}`);
    if (f.fmt === 'dec' && f.long < 4) throw new Error(`SICOSS layout: campo ${f.n} decimal corto (${f.long})`);
    pos += f.long;
  }
  if (pos - 1 !== RECORD_LEN) throw new Error(`SICOSS layout: total ${pos - 1} != ${RECORD_LEN}`);
})();

export function fmtInt(value, long) {
  let n = Math.round(Number(value) || 0);
  if (n < 0) n = 0;
  const s = String(n);
  if (s.length > long) throw new Error(`SICOSS: entero ${n} excede longitud ${long}`);
  return s.padStart(long, '0');
}

export function fmtChar(value, long) {
  let s = String(value == null ? '' : value)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7E]/g, ' ')
    .toUpperCase();
  if (s.length > long) s = s.slice(0, long);
  return s.padEnd(long, ' ');
}

export function fmtDec(value, long) {
  const intLen = long - 3;
  let v = Number(value) || 0;
  if (v < 0) v = 0;
  const cents = Math.round(v * 100);
  const ent = Math.floor(cents / 100);
  const dec = cents % 100;
  const entStr = String(ent);
  if (entStr.length > intLen) throw new Error(`SICOSS: importe ${v} excede parte entera (${intLen} dig.)`);
  return entStr.padStart(intLen, '0') + '.' + String(dec).padStart(2, '0');
}

function fmtField(field, value) {
  if (field.fmt === 'int') return fmtInt(value, field.long);
  if (field.fmt === 'char') return fmtChar(value, field.long);
  if (field.fmt === 'dec') return fmtDec(value, field.long);
  throw new Error(`SICOSS: formato desconocido ${field.fmt}`);
}

export function buildRecord(rec) {
  let line = '';
  for (const f of FIELDS) line += fmtField(f, rec[f.src]);
  if (line.length !== RECORD_LEN) throw new Error(`SICOSS: registro de ${line.length} chars (esperado ${RECORD_LEN})`);
  return line;
}

export function buildFile(records) {
  return records.map(buildRecord).join('\r\n') + '\r\n';
}

function topear(valor, tope) {
  if (!tope || tope <= 0) return valor;
  return Math.min(valor, tope);
}

// emp: códigos SICOSS del legajo (ver DEFAULTS_SICOSS)
// liq: { remunerativo, noRemunerativo, sac, horasExtras, vacaciones, zonaDesfavorable, asigFamiliares, ... }
// topes: { jubilatorioPersonal, jubilatorioPatronal, otrosAportesPersonales }
export function mapEmpleado(emp, liq, topes = {}) {
  const rem = Number(liq.remunerativo) || 0;
  const noRem = Number(liq.noRemunerativo) || 0;
  const sac = Number(liq.sac) || 0;
  const horasExtras = Number(liq.horasExtras) || 0;
  const vacaciones = Number(liq.vacaciones) || 0;
  const zonaDesf = Number(liq.zonaDesfavorable) || 0;

  const impJub = topear(rem, topes.jubilatorioPersonal);
  const impPat = topear(rem, topes.jubilatorioPatronal);
  const impOtros = topear(rem, topes.otrosAportesPersonales);
  const remImp8 = rem;
  const remImp9 = remImp8 + noRem;

  return {
    cuil: emp.cuil,
    nombre: emp.nombre,
    conyuge: emp.conyuge,
    hijos: emp.hijos,
    codigoSituacion: emp.codigoSituacion,
    codigoCondicion: emp.codigoCondicion,
    codigoActividad: emp.codigoActividad,
    codigoZona: emp.codigoZona,
    porcAporteAdicSS: emp.porcAporteAdicSS,
    codigoModalidad: emp.codigoModalidad,
    codigoObraSocial: emp.codigoObraSocial,
    adherentes: emp.adherentes,
    provinciaLocalidad: emp.provinciaLocalidad,
    codigoSiniestrado: emp.codigoSiniestrado,
    marcaReduccion: emp.marcaReduccion,
    tipoEmpresa: emp.tipoEmpresa,
    regimen: emp.regimen,
    sitRevista1: emp.codigoSituacion,
    diaSitRevista1: 1,
    sitRevista2: 0,
    diaSitRevista2: 0,
    sitRevista3: 0,
    diaSitRevista3: 0,
    diasTrabajados: emp.diasTrabajados != null ? emp.diasTrabajados : 30,
    trabajadorConvencionado: emp.trabajadorConvencionado,
    seguroVida: emp.seguroVida != null ? emp.seguroVida : 1,
    horasTrabajadas: 0,
    remTotal: rem + noRem,   // Remuneración Total: bruto sin topear (rem + no rem)
    remImp1: impJub,
    remImp2: impJub,
    remImp3: impJub,
    remImp4: impPat,
    remImp5: impOtros,
    remImp6: 0,
    remImp8,
    remImp9,
    remImp11: 0,
    rem7: 0,
    sueldoAdicionales: rem - sac - horasExtras - vacaciones - zonaDesf,
    sac,
    horasExtras,
    vacaciones,
    zonaDesfavorable: zonaDesf,
    noRemunerativo: noRem,
    asigFamiliares: Number(liq.asigFamiliares) || 0,
    aporteVoluntario: 0,
    adicionalOS: 0,
    excedentesSS: 0,
    excedentesOS: 0,
    capitalLRT: 0,
    aporteAdicOS: 0,
    importeAdicionales: 0,
    importePremios: 0,
    cantHorasExtras: 0,
    maternidad: 0,
    rectificacion: 0,
    contribTareaDif: 0,
    tipoOperacion: 0,
    detraccion27430: Number(liq.detraccion27430) || 0,
    incrementoSalarial: Number(liq.incrementoSalarial) || 0,
  };
}

export const DEFAULTS_SICOSS = {
  conyuge: 0,
  hijos: 0,
  codigoSituacion: 1,
  codigoCondicion: 1,
  codigoActividad: 0,
  codigoZona: 0,
  porcAporteAdicSS: 0,
  codigoModalidad: 8,
  codigoObraSocial: 0,
  adherentes: 0,
  codigoSiniestrado: 0,
  marcaReduccion: 0,
  tipoEmpresa: 0,
  regimen: 1,
  trabajadorConvencionado: 1,
  seguroVida: 1,
  diasTrabajados: 30,
  provinciaLocalidad: '',
};
