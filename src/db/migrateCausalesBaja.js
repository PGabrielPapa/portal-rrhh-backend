// Causales de baja de la relación laboral — tabla oficial de ARCA (Simplificación Registral,
// tabla 21 "Código de Situación", filas con utilización MOTIVO DE BAJA; edición 002 del 28/01/2026).
//
// Antes había TRES listas distintas y hardcodeadas (pantalla de Liquidación, Conceptos y Simulador
// de Ganancias) que no coincidían entre sí: por ejemplo el mutuo acuerdo se guardaba como 'mutuo' en
// Liquidación y como 'mutuo_acuerdo' en Conceptos, así que un concepto configurado para mutuo acuerdo
// nunca se aplicaba. Ahora la lista vive acá y las pantallas la leen de /api/causales-baja.
//
// `clave` es el valor que se guarda en el recibo (data.motivoBaja). Se conservan las claves que ya
// estaban en uso para no romper las liquidaciones finales ya emitidas.
//
// `indemnizacion`: 'plena' = Art. 245 completo · 'media' = 50% (Art. 247/248/212 1º-3º/250) ·
// 'ninguna' = no genera indemnización por antigüedad.
// `preaviso`: si corresponde preaviso (o su indemnización sustitutiva) e integración mes de despido.
//
// IMPORTANTE: los dos campos son EDITABLES. Los valores sembrados son el criterio general de la LCT
// y hay casos que dependen de la situación concreta (típicamente quiebra y concurso del Art. 251,
// donde la indemnización es plena si la quiebra resulta imputable al empleador).
import { query } from '../db.js';

const CAUSALES = [
  // cod ARCA, clave, nombre, indemnización, preaviso
  ['0',  'fallecimiento',            'Fallecimiento del trabajador (Art. 248)',                         'media',   false],
  ['2',  'otras_causales',           'Bajas otras causales',                                            'ninguna', false],
  ['7',  'despido_generico',         'Baja por despido',                                                'plena',   true],
  ['18', 'transferencia_contrato',   'Transferencia del contrato de trabajo (Art. 225)',                'ninguna', false],
  ['19', 'denuncia_transferencia',   'Denuncia por transferencia de establecimiento (Art. 226)',        'plena',   false],
  ['20', 'cesion_personal',          'Cesión del personal (Art. 229)',                                  'ninguna', false],
  ['21', 'renuncia',                 'Renuncia del trabajador (Art. 240)',                              'ninguna', false],
  ['22', 'voluntad_concurrente',     'Voluntad concurrente de las partes (Art. 241)',                   'ninguna', false],
  ['23', 'con_causa',                'Denuncia del contrato por el empleador (Art. 242)',               'ninguna', false],
  ['24', 'despido_indirecto',        'Denuncia del contrato por el trabajador (Art. 242)',              'plena',   true],
  ['25', 'abandono',                 'Abandono del trabajo (Art. 244)',                                 'ninguna', false],
  ['26', 'sin_causa',                'Despido sin justa causa (Art. 245)',                              'plena',   true],
  ['27', 'falta_trabajo',            'Falta o disminución de trabajo (Art. 247)',                       'media',   true],
  ['28', 'fuerza_mayor',             'Fuerza mayor (Art. 247)',                                         'media',   true],
  ['29', 'fallecimiento_empleador',  'Fallecimiento del empleador (Art. 249)',                          'media',   false],
  ['30', 'fin_contrato',             'Vencimiento de plazo (Art. 250)',                                 'media',   false],
  ['31', 'quiebra_empleador',        'Quiebra del empleador (Art. 251)',                                'media',   false],
  ['32', 'concurso_empleador',       'Concurso del empleador (Art. 251)',                               'media',   false],
  ['33', 'jubilacion',               'Jubilación (Art. 252)',                                           'ninguna', false],
  ['34', 'incapacidad_absoluta',     'Incapacidad absoluta (Art. 212 4º / 254)',                        'plena',   false],
  ['34', 'incapacidad_parcial',      'Incapacidad parcial (Art. 212 1º a 3º / 254)',                    'media',   false],
  ['35', 'voluntad_agrario',         'Voluntad concurrente — Agrario (Art. 64 b, Ley 22.248)',          'ninguna', false],
  ['36', 'despido_agrario',          'Despido con o sin justa causa — Agrario (Art. 64 c, Ley 22.248)',  'plena',   true],
  ['37', 'fuerza_mayor_agrario',     'Despido por fuerza mayor — Agrario (Art. 64 d, Ley 22.248)',      'media',   true],
  ['38', 'fin_aprendizaje',          'Fin de contrato de aprendizaje y pasantías',                      'ninguna', false],
  ['39', 'despido_25371',            'Despido Art. 5º Ley 25.371',                                      'plena',   true],
  ['40', 'cesantia',                 'Cesantía laboral',                                                'ninguna', false],
  ['41', 'exoneracion',              'Exoneración',                                                     'ninguna', false],
  ['46', 'retiro_voluntario_inicio', 'Inicio pago retiro voluntario (Dec. 263/2018)',                   'ninguna', false],
  ['47', 'retiro_voluntario_fin',    'Fin pago retiro voluntario (Dec. 263/2018)',                      'ninguna', false],
  ['52', 'mutuo',                    'Extinción por mutuo acuerdo (Art. 241)',                          'ninguna', false],
  ['53', 'baja_oficio',              'Baja de oficio por denuncia',                                     'ninguna', false],
  ['54', 'retiro_voluntario',        'Retiro anticipado o voluntario',                                  'ninguna', false],
  ['55', 'traspaso_rigi',            'Traspaso de personal (RIGI, Ley 27.742)',                         'ninguna', false],
  ['99', 'vencimiento_plazo',        'Vencimiento de contrato a plazo fijo o determinado',              'media',   false],
  // Período de prueba: NO tiene causal propia en la tabla de ARCA. Se deja sin código para que RR.HH.
  // defina con qué causal se comunica la baja. El preaviso especial de 15 días (Art. 92 bis) lo sigue
  // resolviendo el motor por la clave 'prueba'.
  [null, 'prueba',                   'Período de prueba (Art. 92 bis)',                                 'ninguna', false],
];

export async function migrarCausalesBaja() {
  await query(`CREATE TABLE IF NOT EXISTS causales_baja (
    id            SERIAL PRIMARY KEY,
    clave         TEXT NOT NULL UNIQUE,
    cod_arca      TEXT,
    nombre        TEXT NOT NULL,
    indemnizacion TEXT NOT NULL DEFAULT 'ninguna',
    preaviso      BOOLEAN NOT NULL DEFAULT false,
    orden         INTEGER NOT NULL DEFAULT 0,
    activo        BOOLEAN NOT NULL DEFAULT true,
    nota          TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);

  let creadas = 0;
  for (let i = 0; i < CAUSALES.length; i++) {
    const [cod, clave, nombre, indem, prev] = CAUSALES[i];
    // Solo INSERT: si la causal ya existe no se pisa, para no revertir los ajustes que haga RR.HH.
    const r = await query(
      `INSERT INTO causales_baja (clave, cod_arca, nombre, indemnizacion, preaviso, orden)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (clave) DO NOTHING`,
      [clave, cod, nombre, indem, prev, (i + 1) * 10]);
    creadas += r.rowCount;
  }
  return { creadas, total: CAUSALES.length };
}
