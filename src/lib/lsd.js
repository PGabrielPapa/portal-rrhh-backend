// src/lib/lsd.js
//
// Generador del archivo de importación del LIBRO DE SUELDOS DIGITAL (LSD) de
// ARCA/AFIP — "Interfaz Usuario / Liquidación de SyJ - DJ F931 (.TXT)".
//
// Diseño oficial: ARCA → Libro de Sueldos Digital → Ayuda → Diseños →
//   "Diseño de interfaz – liquidación" (LSDiseInterfazLiquidacion.pdf)
//   "Diseño de interfaz – conceptos"   (LSDiseInterfazConceptos.pdf)
//
// El archivo es posicional, multi-registro, una línea por registro (CRLF):
//   '01' Datos referenciales del envío .......... 35 chars   (1 por archivo)
//   '02' Datos referenciales del trabajador ..... 115 chars  (1 por trabajador)
//   '03' Detalle de conceptos liquidados ........ 51 chars   (n por trabajador)
//   '04' Datos del trabajador para la DJ F931 ... 370 chars  (1 por trabajador)
// Orden: 01 ; luego por trabajador: 02, sus 03, y 04.
//
// IMPORTANTE: los importes NO llevan separador decimal. "13 enteros y 2
// decimales" = 15 dígitos; los 2 últimos son los centavos. (Se diferencia del
// SICOSS, que sí usa punto.)
//
// Marca de la versión del diseño con la que se construyó (para verificación).
export const DISENO = {
  version: '2024.1',
  fuente: 'ARCA - Diseño de interfaz – liquidación (LSDiseInterfazLiquidacion.pdf)',
  url: 'https://www.afip.gob.ar/LibrodeSueldosDigital/ayuda/disenios.asp',
  registros: { '01': 35, '02': 115, '03': 51, '04': 370 },
};

// ---------------------------------------------------------------------------
// Layouts. Cada fila: [Nº, DESDE, formato, srcKey, etiqueta]. La longitud se
// deriva del DESDE del campo siguiente (último: hasta RECORD_LEN).
//   int  -> entero, derecha, ceros a la izquierda
//   char -> texto, izquierda, espacios a la derecha (ASCII sin tildes, MAYÚSC)
//   dec  -> importe SIN punto: valor*100, derecha, ceros (long = enteros+2)
//   date -> AAAAMMDD ó AAAAMM, numérico, ceros
// ---------------------------------------------------------------------------

const LAYOUT_01 = [
  [1, 1, 'char', '_tipo', "Tipo de registro ('01')"],
  [2, 3, 'int', 'cuit', 'CUIT del empleador'],
  [3, 14, 'char', 'idEnvio', "Identificación del envío ('SJ'/'RE')"],
  [4, 16, 'date', 'periodo', 'Período (AAAAMM)'],
  [5, 22, 'char', 'tipoLiq', "Tipo de liquidación ('M'/'Q'/'S')"],
  [6, 23, 'int', 'nroLiq', 'Número de liquidación'],
  [7, 28, 'char', 'diasBase', "Días base ('30')"],
  [8, 30, 'int', 'cantTrab', "Cantidad de trabajadores (registros '04')"],
];
const LEN_01 = 35;

const LAYOUT_02 = [
  [1, 1, 'char', '_tipo', "Tipo de registro ('02')"],
  [2, 3, 'int', 'cuil', 'CUIL del trabajador'],
  [3, 14, 'char', 'legajo', 'Legajo del trabajador'],
  [4, 24, 'char', 'dependencia', 'Dependencia de revista'],
  [5, 74, 'char', 'cbu', 'CBU de acreditación (si forma de pago=3)'],
  [6, 96, 'int', 'diasTope', 'Cantidad de días para proporcionar tope'],
  [7, 99, 'date', 'fechaPago', 'Fecha de pago (AAAAMMDD)'],
  [8, 107, 'date', 'fechaRubrica', 'Fecha de rúbrica (AAAAMMDD)'],
  [9, 115, 'char', 'formaPago', 'Forma de pago (1=efectivo..4)'],
];
const LEN_02 = 115;

const LAYOUT_03 = [
  [1, 1, 'char', '_tipo', "Tipo de registro ('03')"],
  [2, 3, 'int', 'cuil', 'CUIL del trabajador'],
  [3, 14, 'char', 'codConcepto', 'Código de concepto del empleador'],
  [4, 24, 'dec', 'cantidad', 'Cantidad (3 ent + 2 dec)'],
  [5, 29, 'char', 'unidad', 'Unidad de medida'],
  [6, 30, 'dec', 'importe', 'Importe (13 ent + 2 dec)'],
  [7, 45, 'char', 'indicadorDC', 'Indicador Débito/Crédito (D/C)'],
  [8, 46, 'char', 'periodoAjuste', 'Período de ajuste retroactivo (AAAAMM)'],
];
const LEN_03 = 51;

const LAYOUT_04 = [
  [1, 1, 'char', '_tipo', "Tipo de registro ('04')"],
  [2, 3, 'int', 'cuil', 'CUIL del trabajador'],
  [3, 14, 'char', 'conyuge', 'Marca de cónyuge (0/1)'],
  [4, 15, 'int', 'hijos', 'Cantidad de hijos'],
  [5, 17, 'char', 'marcaCCT', 'Marca de trabajador en CCT (0/1)'],
  [6, 18, 'char', 'marcaSCVO', 'Marca de cobertura SCVO (0/1)'],
  [7, 19, 'char', 'marcaReduccion', 'Marca corresponde reducción (0/1)'],
  [8, 20, 'char', 'tipoEmpleador', 'Código de tipo de empleador'],
  [9, 21, 'char', 'tipoOperacion', 'Código de tipo de operación (0/1)'],
  [10, 22, 'char', 'codSitRevista', 'Código de situación de revista'],
  [11, 24, 'char', 'codCondicion', 'Código de condición'],
  [12, 26, 'char', 'codActividad', 'Código de actividad'],
  [13, 29, 'char', 'codModalidad', 'Código de modalidad de contratación'],
  [14, 32, 'char', 'codSiniestrado', 'Código de siniestrado'],
  [15, 34, 'char', 'codLocalidad', 'Código de localidad'],
  [16, 36, 'char', 'sitRevista1', 'Situación de revista 1'],
  [17, 38, 'int', 'diaSitRevista1', 'Día inicio situación de revista 1'],
  [18, 40, 'char', 'sitRevista2', 'Situación de revista 2'],
  [19, 42, 'int', 'diaSitRevista2', 'Día inicio situación de revista 2'],
  [20, 44, 'char', 'sitRevista3', 'Situación de revista 3'],
  [21, 46, 'int', 'diaSitRevista3', 'Día inicio situación de revista 3'],
  [22, 48, 'int', 'diasTrabajados', 'Cantidad de días trabajados'],
  [23, 50, 'int', 'horasTrabajadas', 'Cantidad de horas trabajadas'],
  [24, 53, 'dec', 'porcAporteAdicSS', 'Porcentaje de aporte adicional SS (3+2)'],
  [25, 58, 'dec', 'porcContribTareaDif', 'Porcentaje de contribución tarea diferencial (3+2)'],
  [26, 63, 'char', 'codObraSocial', 'Código de obra social'],
  [27, 69, 'int', 'adherentes', 'Cantidad de adherentes de obra social'],
  [28, 71, 'dec', 'aporteAdicOS', 'Aporte adicional de obra social'],
  [29, 86, 'dec', 'contribAdicOS', 'Contribución adicional de obra social'],
  [30, 101, 'dec', 'baseDifAporteOS', 'Base diferencial aporte OS y FSR'],
  [31, 116, 'dec', 'baseDifContribOS', 'Base diferencial contribuciones OS y FSR'],
  [32, 131, 'dec', 'baseDifLRT', 'Base diferencial Ley de Riesgos del Trabajo'],
  [33, 146, 'dec', 'remMaternidad', 'Remuneración maternidad para ANSeS'],
  [34, 161, 'dec', 'remBruta', 'Remuneración bruta'],
  [35, 176, 'dec', 'baseImp1', 'Base imponible 1'],
  [36, 191, 'dec', 'baseImp2', 'Base imponible 2'],
  [37, 206, 'dec', 'baseImp3', 'Base imponible 3'],
  [38, 221, 'dec', 'baseImp4', 'Base imponible 4'],
  [39, 236, 'dec', 'baseImp5', 'Base imponible 5'],
  [40, 251, 'dec', 'baseImp6', 'Base imponible 6'],
  [41, 266, 'dec', 'baseImp7', 'Base imponible 7'],
  [42, 281, 'dec', 'baseImp8', 'Base imponible 8'],
  [43, 296, 'dec', 'baseImp9', 'Base imponible 9'],
  [44, 311, 'dec', 'baseDifAporteSS', 'Base diferencial aporte Seg. Social'],
  [45, 326, 'dec', 'baseDifContribSS', 'Base diferencial contribuciones Seg. Social'],
  [46, 341, 'dec', 'baseImp10', 'Base imponible 10'],
  [47, 356, 'dec', 'importeDetraer', 'Importe a detraer (Ley 26.473)'],
];
const LEN_04 = 370;

function buildFields(layout, recordLen) {
  return layout.map((f, i) => {
    const [n, desde, fmt, src, label] = f;
    const next = i + 1 < layout.length ? layout[i + 1][1] : recordLen + 1;
    return { n, desde, long: next - desde, fmt, src, label };
  });
}

export const FIELDS = {
  '01': buildFields(LAYOUT_01, LEN_01),
  '02': buildFields(LAYOUT_02, LEN_02),
  '03': buildFields(LAYOUT_03, LEN_03),
  '04': buildFields(LAYOUT_04, LEN_04),
};
export const RECORD_LEN = { '01': LEN_01, '02': LEN_02, '03': LEN_03, '04': LEN_04 };

// Verificación de integridad del layout (corre al importar el módulo).
(function assertLayouts() {
  for (const tipo of Object.keys(FIELDS)) {
    let pos = 1;
    for (const f of FIELDS[tipo]) {
      if (f.desde !== pos) throw new Error(`LSD ${tipo}: campo ${f.n} DESDE=${f.desde} esperado ${pos}`);
      if (f.long <= 0) throw new Error(`LSD ${tipo}: campo ${f.n} long inválida ${f.long}`);
      if (f.fmt === 'dec' && f.long < 3) throw new Error(`LSD ${tipo}: campo ${f.n} decimal corto (${f.long})`);
      pos += f.long;
    }
    if (pos - 1 !== RECORD_LEN[tipo]) throw new Error(`LSD ${tipo}: total ${pos - 1} != ${RECORD_LEN[tipo]}`);
  }
})();

// --- formateadores ---------------------------------------------------------
export function fmtInt(value, long) {
  let n = Math.round(Number(value) || 0);
  if (n < 0) n = 0;
  const s = String(n);
  if (s.length > long) throw new Error(`LSD: entero ${n} excede longitud ${long}`);
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

// Importe SIN separador: valor*100, ceros a la izquierda. long = enteros+2.
export function fmtDec(value, long) {
  let v = Number(value) || 0;
  if (v < 0) v = 0;
  const cents = Math.round(v * 100);
  const s = String(cents);
  if (s.length > long) throw new Error(`LSD: importe ${v} excede longitud ${long}`);
  return s.padStart(long, '0');
}

export function fmtDate(value, long) {
  // value puede venir como número/string ya en AAAAMMDD/AAAAMM, o Date.
  if (value == null || value === '') return ''.padEnd(long, long === 6 ? '0' : '0').padStart(long, '0');
  let s;
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    s = long === 6 ? `${y}${m}` : `${y}${m}${d}`;
  } else {
    s = String(value).replace(/\D/g, '');
  }
  if (s.length > long) s = s.slice(0, long);
  return s.padStart(long, '0');
}

function fmtField(field, value) {
  if (field.fmt === 'int') return fmtInt(value, field.long);
  if (field.fmt === 'char') return fmtChar(value, field.long);
  if (field.fmt === 'dec') return fmtDec(value, field.long);
  if (field.fmt === 'date') return fmtDate(value, field.long);
  throw new Error(`LSD: formato desconocido ${field.fmt}`);
}

export function buildRecord(tipo, rec) {
  const fields = FIELDS[tipo];
  let line = '';
  for (const f of fields) line += fmtField(f, f.src === '_tipo' ? tipo : rec[f.src]);
  if (line.length !== RECORD_LEN[tipo]) {
    throw new Error(`LSD ${tipo}: registro de ${line.length} chars (esperado ${RECORD_LEN[tipo]})`);
  }
  return line;
}

// records: array de { tipo: '01'|'02'|'03'|'04', ...campos }
export function buildFile(records) {
  return records.map((r) => buildRecord(r.tipo, r)).join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------------------
// Clasificador de conceptos → código del empleador para el registro '03'.
// El "código de concepto del empleador" debe estar dado de alta en el LSD y
// relacionado al código ARCA (vía la interfaz de conceptos). Acá emitimos un
// código interno estable por tipo de concepto; el empleador lo da de alta una
// sola vez en el servicio LSD.
// Cada regla: { re, codigo, dc } (dc: 'C'=crédito/haber, 'D'=débito/descuento).
// ---------------------------------------------------------------------------
export const CONCEPTOS_LSD = [
  { re: /b[áa]sico|sueldo/i, codigo: '1', dc: 'C' },
  { re: /antig[üu]edad/i, codigo: '100', dc: 'C' },
  { re: /presentismo/i, codigo: '8000', dc: 'C' },
  { re: /hora.?\s*extra.*100|extra.*100/i, codigo: '3', dc: 'C' },
  { re: /hora.?\s*extra/i, codigo: '2', dc: 'C' },
  { re: /sac|aguinaldo/i, codigo: '500', dc: 'C' },
  { re: /vacacion/i, codigo: '600', dc: 'C' },
  { re: /feriado/i, codigo: '610', dc: 'C' },
  { re: /zona/i, codigo: '700', dc: 'C' },
  { re: /preaviso/i, codigo: '800', dc: 'C' },
  { re: /integraci[óo]n/i, codigo: '810', dc: 'C' },
  { re: /indemnizaci[óo]n/i, codigo: '820', dc: 'C' },
  { re: /asignaci[óo]n.*familiar|asig\.?\s*fam/i, codigo: '900', dc: 'C' },
  { re: /no\s*rem|no\s*remunerativ/i, codigo: '950', dc: 'C' },
  { re: /complement|adicional|bono|premio|gratific/i, codigo: '200', dc: 'C' },
  { re: /anticipo/i, codigo: '300', dc: 'C' },
  { re: /ajuste/i, codigo: '210', dc: 'C' },
  // descuentos
  { re: /jubilaci[óo]n/i, codigo: '2001', dc: 'D' },
  { re: /obra\s*social/i, codigo: '2002', dc: 'D' },
  { re: /anssal/i, codigo: '2003', dc: 'D' },
  { re: /pami|inssjp/i, codigo: '2004', dc: 'D' },
  { re: /sindical|cuota\s*gremial|gremio/i, codigo: '2005', dc: 'D' },
  { re: /ganancias/i, codigo: '2010', dc: 'D' },
  { re: /seguro.*vida/i, codigo: '2006', dc: 'D' },
];

export function clasificarConcepto(nombre, esDescuento) {
  for (const c of CONCEPTOS_LSD) {
    if (c.re.test(nombre || '')) return c;
  }
  // genéricos por defecto
  return esDescuento
    ? { codigo: '2999', dc: 'D' }
    : { codigo: '999', dc: 'C' };
}

// ---------------------------------------------------------------------------
// Armado de los registros de un trabajador a partir de:
//   sicossRec: salida de sicoss.mapEmpleado(emp, liq, topes) (reusa el F.931)
//   emp:       códigos del legajo (edata) + cuil/nombre/legajo
//   recibo:    { haberes:[{concepto,tipo,monto}], descuentos:[{concepto,monto}], totales }
//   ctx:       { fechaPago, fechaRubrica, periodo(AAAAMM), formaPago, cbu, diasTope }
// ---------------------------------------------------------------------------
export function reg02(emp, ctx) {
  const formaPago = ctx.formaPago || '1';
  return {
    tipo: '02',
    cuil: String(emp.cuil || '').replace(/\D/g, ''),
    legajo: emp.legajo != null ? String(emp.legajo) : '',
    dependencia: emp.dependencia || '',
    cbu: formaPago === '3' ? (ctx.cbu || emp.cbu || '') : '',
    diasTope: ctx.diasTope != null ? ctx.diasTope : 30,
    fechaPago: ctx.fechaPago,
    fechaRubrica: ctx.fechaRubrica || ctx.fechaPago,
    formaPago,
  };
}

export function regs03(emp, recibo, ctx) {
  const cuil = String(emp.cuil || '').replace(/\D/g, '');
  const out = [];
  const push = (nombre, monto, esDescuento, cantidad, unidad) => {
    const val = Number(monto) || 0;
    const m = Math.abs(val);
    if (m <= 0) return;
    const c = clasificarConcepto(nombre, esDescuento);
    // Un importe negativo (p. ej. devolución de Ganancias) invierte el indicador D/C.
    const dc = val < 0 ? (c.dc === 'D' ? 'C' : 'D') : c.dc;
    out.push({
      tipo: '03', cuil,
      codConcepto: c.codigo,
      cantidad: cantidad || 0,
      unidad: unidad || '',
      importe: m,
      indicadorDC: dc,
      periodoAjuste: '',
    });
  };
  for (const h of (recibo.haberes || [])) push(h.concepto, h.monto, false, h.cantidad, h.unidad);
  for (const d of (recibo.descuentos || [])) push(d.concepto, d.monto, true, d.cantidad, d.unidad);
  return out;
}

export function reg04(emp, sicossRec) {
  const s = sicossRec || {};
  const b = (v) => Number(v) || 0;
  return {
    tipo: '04',
    cuil: String(emp.cuil || '').replace(/\D/g, ''),
    conyuge: emp.conyuge ? '1' : '0',
    hijos: emp.hijos || 0,
    marcaCCT: (emp.trabajadorConvencionado != null ? emp.trabajadorConvencionado : 1) ? '1' : '0',
    marcaSCVO: (emp.seguroVida != null ? emp.seguroVida : 1) ? '1' : '0',
    marcaReduccion: emp.marcaReduccion ? '1' : '0',
    tipoEmpleador: emp.tipoEmpresa != null ? String(emp.tipoEmpresa) : '0',
    tipoOperacion: emp.tipoOperacion != null ? String(emp.tipoOperacion) : '0',
    codSitRevista: emp.codigoSituacion != null ? String(emp.codigoSituacion) : '1',
    codCondicion: emp.codigoCondicion != null ? String(emp.codigoCondicion) : '1',
    codActividad: emp.codigoActividad != null ? String(emp.codigoActividad) : '',
    codModalidad: emp.codigoModalidad != null ? String(emp.codigoModalidad) : '',
    codSiniestrado: emp.codigoSiniestrado != null ? String(emp.codigoSiniestrado) : '0',
    codLocalidad: emp.codigoLocalidad != null ? String(emp.codigoLocalidad) : '',
    sitRevista1: emp.codigoSituacion != null ? String(emp.codigoSituacion) : '1',
    diaSitRevista1: 1,
    sitRevista2: '', diaSitRevista2: 0,
    sitRevista3: '', diaSitRevista3: 0,
    diasTrabajados: emp.diasTrabajados != null ? emp.diasTrabajados : 30,
    horasTrabajadas: emp.horasTrabajadas || 0,
    porcAporteAdicSS: b(emp.porcAporteAdicSS),
    porcContribTareaDif: b(emp.porcContribTareaDif),
    codObraSocial: emp.codigoObraSocial != null ? String(emp.codigoObraSocial) : '',
    adherentes: emp.adherentes || 0,
    aporteAdicOS: 0,
    contribAdicOS: 0,
    baseDifAporteOS: 0,
    baseDifContribOS: 0,
    baseDifLRT: 0,
    remMaternidad: b(s.maternidad),
    remBruta: b(s.remTotal),
    baseImp1: b(s.remImp1),
    baseImp2: b(s.remImp2),
    baseImp3: b(s.remImp3),
    baseImp4: b(s.remImp4),
    baseImp5: b(s.remImp5),
    baseImp6: b(s.remImp6),
    baseImp7: b(s.rem7),
    baseImp8: b(s.remImp8),
    baseImp9: b(s.remImp9),
    baseDifAporteSS: 0,
    baseDifContribSS: 0,
    baseImp10: b(s.remImp11),
    importeDetraer: b(s.detraccion27430),
  };
}

// Cabecera reg '01'
export function reg01({ cuit, periodo, tipoLiq, nroLiq, cantTrab }) {
  return {
    tipo: '01',
    cuit: String(cuit || '').replace(/\D/g, ''),
    idEnvio: 'SJ',
    periodo,
    tipoLiq: tipoLiq || 'M',
    nroLiq: nroLiq || 1,
    diasBase: '30',
    cantTrab: cantTrab || 0,
  };
}
