// Migración idempotente del módulo "Asiento de sueldos (libro completo)".
//
// Crea la tabla de mapeo columna-de-nómina → cuenta contable (con apertura por
// centro de costos) y la siembra con el plan que hoy usa Contabilidad en el
// Excel mensual "Asiento Leiten". Los números de cuenta quedan editables desde
// la pantalla: acá sólo se deja el punto de partida.
//
// Se ejecuta desde `npm run migrate` y, de forma perezosa, la primera vez que
// se pide el reporte.
import { query } from '../db.js';

// Cuentas de resultado que se abren por centro de costos.
// cc del legajo → cuenta contable. Confirmar con Contabilidad antes de usar en producción.
const SUELDOS_POR_CC = {
  com: ['413001', 'Sueldos y Jornales comercialización'],
  cos: ['413002', 'Sueldos y Jornales producción'],
  pro: ['413002', 'Sueldos y Jornales producción'],
  adm: ['413003', 'Sueldos y Jornales administración'],
  pv:  ['413014', 'Sueldos y Jornales Post Venta'],
  ser: ['413015', 'Sueldos y Jornales Marketing'],
  mkt: ['413015', 'Sueldos y Jornales Marketing'],
  des: ['413020', 'Sueldos y Jornales Desarrollo'],
};
const CARGAS_POR_CC = {
  com: ['413004', 'Cargas Sociales comercialización'],
  cos: ['413005', 'Cargas Sociales producción'],
  pro: ['413005', 'Cargas Sociales producción'],
  adm: ['413006', 'Cargas sociales administración'],
  pv:  ['413016', 'Cargas sociales Post Venta'],
  ser: ['413017', 'Cargas sociales Marketing'],
  mkt: ['413017', 'Cargas sociales Marketing'],
  des: ['413021', 'Cargas sociales Desarrollo'],
};

// Columnas de haberes/descuentos que van a la cuenta de sueldos del centro de costos.
const COLS_SUELDOS = [
  'R_ASIGNADA', 'COMP_FUNCION', 'HS_EXT_Y_A', 'PRESENTISM', 'VACACION',
  'LICENCIAS', 'SAC', 'OTROS_REM', 'REDUCCION', 'ACUERDO', 'OTROSNR',
];

// Columnas con cuenta única (sin apertura por centro de costos).
// [columna, cuenta, descripción, naturaleza sugerida]
const COLS_UNICAS = [
  ['COMISIONES',   '421002', 'Comisiones Abonadas',                    'debe'],
  ['INDEMNIZ_Y',   '412028', 'INDEMNIZACIONES',                        'debe'],
  ['DETRACCION',   'XXXX',   'Detracción art. 23 Ley 27.541',          'haber'],
  ['APO_JUB',      '174',    'SUSS A PAGAR',                           'haber'],
  ['LEY_19032',    '174',    'SUSS A PAGAR',                           'haber'],
  ['O_SOCIAL',     '174',    'SUSS A PAGAR',                           'haber'],
  ['O_S_ADHE',     '174',    'SUSS A PAGAR',                           'haber'],
  ['ANSSAL',       '174',    'SUSS A PAGAR',                           'haber'],
  ['APO_OS_S_A',   '174',    'SUSS A PAGAR',                           'haber'],
  ['SINDICATO',    '189',    'SINDICATO A PAGAR',                      'haber'],
  ['APO_SINDIC',   '189',    'SINDICATO A PAGAR',                      'haber'],
  ['FAECYS',       '190',    'FAECYS A PAGAR',                         'haber'],
  ['APO_FAECYS',   '190',    'FAECYS A PAGAR',                         'haber'],
  ['SEG_VIDA_Y',   '308',    'Ap. y Cont. SV Colectivo y Sepelio UOM', 'haber'],
  ['AJ_O_SOCIA',   '239',    'APORTE EXT OSECAC',                      'haber'],
  ['O_S_ADIC',     'SALFAM', 'Obra social adicional',                  'haber'],
  ['IMP_GCIAS',    '68',     'RETENCIONES DE GANANCIAS A DEPOSITAR',   'haber'],
  ['ANT_SDO_PR',   '178',    'ADELANTO DE SUELDO/PRESTAMO',            'haber'],
  ['EMBARGO',      'RECLAS1','EMBARGOS A PAGAR',                       'haber'],
  ['OTRAS_DED',    'RECLAS1','RECLASIFICAR',                           'haber'],
  ['NETO',         '173',    'REMUNERACIONES A PAGAR',                 'haber'],
  // Contribuciones patronales con cuenta de pasivo propia
  ['CONT_SS',      '174',    'SUSS A PAGAR',                           'haber'],
  ['CONT_ART',     '174',    'SUSS A PAGAR',                           'haber'],
  ['CONT_SIND',    '192',    'SINDICATO A PAGAR',                      'haber'],
  ['CONT_ESTRELLA','191',    'LA ESTRELLA A PAGAR',                    'haber'],
  ['CONT_INACAP',  '288',    'CONTRIBUCION INACAP',                    'haber'],
  ['CONT_OSECAC',  '239',    'APORTE EXT OSECAC',                      'haber'],
  ['CONT_UOM_CC',  '307',    'Cont. CC UOM SSRL 227/01',               'haber'],
  ['CONT_UOM_SV',  '308',    'Ap. y Cont. SV Colectivo y Sepelio UOM', 'haber'],
  ['CONT_UOM_OS',  '309',    'Aportes y Contrib No Rem OS UOM',        'haber'],
  ['CONT_UOM_EXT', '310',    'Cont. Extraordinarias UOM',              'haber'],
  ['CONT_UOM_NR',  '311',    'Aporte y Cont. NoRem UOM',               'haber'],
  ['RET_SUSS',     '242',    'RETENCIONES SUSS',                       'haber'],
  ['BENEFICIOS',   '266',    'BENEFICIOS SOCIALES AL PERSONAL',        'debe'],
  ['INTERESES',    '423005', 'INTERESES',                              'debe'],
];

export async function migrarAsiento() {
  await query(`
    CREATE TABLE IF NOT EXISTS asiento_cuentas (
      id           SERIAL PRIMARY KEY,
      columna      TEXT NOT NULL,                      -- clave de la columna de nómina
      centro_costo TEXT,                               -- NULL = aplica a todos los centros
      cuenta       TEXT NOT NULL,                      -- número de cuenta contable
      descripcion  TEXT NOT NULL DEFAULT '',
      naturaleza   TEXT NOT NULL DEFAULT 'auto',       -- auto | debe | haber
      orden        INTEGER NOT NULL DEFAULT 0,
      activo       BOOLEAN NOT NULL DEFAULT true,
      updated_by   TEXT,
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_asiento_cuentas
                 ON asiento_cuentas (columna, COALESCE(centro_costo, ''))`);

  const { rows } = await query('SELECT COUNT(*)::int AS n FROM asiento_cuentas');
  if (rows[0].n) return { creada: false, sembradas: 0 };

  let orden = 0, n = 0;
  const ins = async (columna, cc, cuenta, desc, nat) => {
    await query(
      `INSERT INTO asiento_cuentas (columna, centro_costo, cuenta, descripcion, naturaleza, orden)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
      [columna, cc, cuenta, desc, nat, ++orden]);
    n++;
  };

  for (const col of COLS_SUELDOS)
    for (const [cc, [cta, desc]] of Object.entries(SUELDOS_POR_CC))
      await ins(col, cc, cta, desc, 'debe');

  for (const [cc, [cta, desc]] of Object.entries(CARGAS_POR_CC))
    await ins('CONTRIBUCIONES', cc, cta, desc, 'debe');

  for (const [col, cta, desc, nat] of COLS_UNICAS) await ins(col, null, cta, desc, nat);

  return { creada: true, sembradas: n };
}

export default migrarAsiento;
