// Generación del informe de retenciones/devoluciones de Impuesto a las Ganancias
// de 4ª categoría (relación de dependencia) para ARCA.
//   · Régimen 602 (rentas del trabajo en relación de dependencia — RG 2233/SICORE).
//   · Impuesto 217 (Impuesto a las Ganancias — retenciones).
// Produce el detalle (para consulta/CSV) y un archivo de texto de ancho fijo con el
// diseño de registro de comprobantes de SICORE. Ante la migración al SIRE, los
// anchos/campos se centralizan acá para ajustarlos si ARCA actualiza el diseño.
const DEFAULTS = { impuesto: '217', regimen: '602', codComprobante: '07', condicion: '01', tipoDocRetenido: '86', codOperacion: '1' };

// ── Helpers de formato de ancho fijo ──
const soloDig = (s) => String(s == null ? '' : s).replace(/\D/g, '');
const num = (n) => { const x = Number(n); return Number.isFinite(x) ? x : 0; };
// Entero(sin coma) con 2 decimales, ceros a la izquierda, en `len` posiciones. |importe| (el signo lo da la operación).
function impFijo(valor, len) {
  const cent = Math.round(Math.abs(num(valor)) * 100);
  return String(cent).padStart(len, '0').slice(-len);
}
const alfa = (s, len) => String(s == null ? '' : s).slice(0, len).padEnd(len, ' ');
const numIzq = (s, len) => soloDig(s).slice(0, len).padStart(len, '0');
function fechaDDMMAAAA(iso) {                       // 'AAAA-MM-DD' -> 'DD/MM/AAAA'
  const s = String(iso || '').slice(0, 10);
  const [a, m, d] = s.split('-');
  return (d && m && a) ? `${d}/${m}/${a}` : ''.padEnd(10, ' ');
}

// Arma una línea de comprobante SICORE a partir de un ítem de retención/devolución.
// item: { cuil, fecha(AAAA-MM-DD), importe(+ret / -devol), comprobanteNro }
export function lineaSicore(item, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const esDevol = num(item.importe) < 0;
  const f = fechaDDMMAAAA(item.fecha);
  return [
    alfa(o.codComprobante, 3),                       // código de comprobante
    f.padEnd(10, ' '),                               // fecha de emisión del comprobante (DD/MM/AAAA)
    numIzq(item.comprobanteNro || '1', 16),          // número de comprobante
    impFijo(item.importeComprobante ?? item.importe, 16), // importe del comprobante (base del pago)
    alfa(o.impuesto, 3),                             // código de impuesto (217)
    alfa(o.regimen, 3),                              // código de régimen (602)
    alfa(esDevol ? '2' : o.codOperacion, 1),         // operación: 1 = retención, 2 = devolución
    impFijo(item.baseCalculo ?? item.importe, 14),   // base de cálculo
    f.padEnd(10, ' '),                               // fecha de la retención
    alfa(o.condicion, 2),                            // código de condición (01 inscripto)
    'N',                                             // ¿sujeto suspendido/excluido?
    impFijo(item.importe, 14),                       // importe de la retención/devolución (valor absoluto)
    '000000',                                        // porcentaje de exclusión
    ''.padEnd(10, ' '),                              // fecha del boletín/resolución (n/a)
    alfa(o.tipoDocRetenido, 2),                      // tipo de documento (86 = CUIL)
    numIzq(item.cuil, 20),                           // número de documento (CUIL)
  ].join('');
}

// Construye el archivo completo (una línea por ítem) y un resumen.
export function generarSicore(items, opts = {}) {
  const lineas = items.filter((i) => Math.round(Math.abs(num(i.importe)) * 100) > 0).map((i) => lineaSicore(i, opts));
  const retenciones = items.filter((i) => num(i.importe) > 0);
  const devoluciones = items.filter((i) => num(i.importe) < 0);
  const totalRet = retenciones.reduce((a, i) => a + num(i.importe), 0);
  const totalDev = devoluciones.reduce((a, i) => a + Math.abs(num(i.importe)), 0);
  return {
    txt: lineas.join('\r\n') + (lineas.length ? '\r\n' : ''),
    resumen: { registros: lineas.length, retenciones: retenciones.length, devoluciones: devoluciones.length,
      totalRetenido: Math.round(totalRet * 100) / 100, totalDevuelto: Math.round(totalDev * 100) / 100 },
  };
}

export { DEFAULTS as SICORE_DEFAULTS };

// ── Calendario de diseños de registro (como el de valores legales / Ganancias) ──
// Cuando ARCA cambia el diseño o migra de SICORE a SIRE, se agrega una entrada acá
// con su vigencia y el sistema adopta la nueva versión sola en/después de esa fecha.
import { query } from '../db.js';
export const DISENO_CALENDARIO = [
  { version: 1, modo: 'SICORE', vigenciaDesde: '2007-01-01',
    descripcion: 'SICORE (RG 2233) — comprobantes de retención. Régimen 602 (relación de dependencia), impuesto 217. Retención = operación 1; devolución = operación 2.',
    urlArca: 'https://www.afip.gob.ar/sicore/' },
  // Migración al SIRE (agregar cuando ARCA la fije para Ganancias 4ª):
  // { version: 2, modo: 'SIRE', vigenciaDesde: 'AAAA-MM-01', descripcion: 'SIRE — Retenciones de Ganancias 4ª…', urlArca: 'https://www.afip.gob.ar/sire/' },
];

// Diseño vigente a una fecha: el de mayor vigenciaDesde <= fecha (por defecto, hoy).
export function disenoVigente(fechaISO) {
  const ref = String(fechaISO || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const aplic = DISENO_CALENDARIO.filter((d) => d.vigenciaDesde <= ref).sort((a, b) => b.version - a.version);
  return aplic[0] || DISENO_CALENDARIO[DISENO_CALENDARIO.length - 1];
}

// Actualiza automáticamente la fila sicore_diseno al diseño vigente si quedó atrasada.
// Devuelve { version, modo, cambiada }. Se corre en el arranque y una vez por día.
export async function autoActualizarSicoreDiseno() {
  const v = disenoVigente();
  await query(
    `INSERT INTO sicore_diseno (id, version, modo, descripcion, url_arca, actualizado_por)
       VALUES (1,$1,$2,$3,$4,'auto') ON CONFLICT (id) DO NOTHING`,
    [v.version, v.modo, v.descripcion, v.urlArca]);
  const cur = (await query('SELECT version FROM sicore_diseno WHERE id=1')).rows[0];
  if (cur && cur.version < v.version) {
    await query('UPDATE sicore_diseno SET version=$1, modo=$2, descripcion=$3, url_arca=$4, actualizado_por=$5, actualizado_at=now() WHERE id=1',
      [v.version, v.modo, v.descripcion, v.urlArca, 'auto']);
    return { version: v.version, modo: v.modo, cambiada: true };
  }
  return { version: v.version, modo: v.modo, cambiada: false };
}
