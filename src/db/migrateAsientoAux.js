// Migración idempotente de las tablas auxiliares del asiento de sueldos.
//
//   · obras_sociales_aportes — TABLA OS: % e importe fijo de aporte y de retención
//     por obra social, con el MISMO código que lleva el legajo (OSECAC, UOM, OSDE…),
//     que no es el código RNOS del padrón `obras_sociales`.
//   · categoria_params      — CATEGORIAS: horas normales, horas y días mínimos
//     imponibles y aplicación de tope por categoría de convenio.
//   · conceptos_sindicales  — aportes y contribuciones propios de cada gremio que
//     el asiento imputa a cuenta separada (INACAP, La Estrella, OSECAC, UOM).
//
// Los valores sembrados salen del Excel mensual de Contabilidad y quedan marcados
// como NO confirmados: hay que validarlos contra el convenio antes de liquidar con
// ellos. Editable desde Liquidación → Tablas auxiliares del asiento.
import { query } from '../db.js';

// [cod, descripcion, hs_normal, hs_min_imp, di_min_imp, aplica_tope]
const CATEGORIAS = [
  ['ADMA', 'ADMINISTRATIVO A', 45.0, 45.0, 0.0, true],
  ['APODERADO', 'ADM A 1/2 JORNADA', 45.0, 45.0, 0.0, true],
  ['SOCIO', 'Asesor Comercial', 45.0, 45.0, 0.0, true],
  ['OPESP', 'AUXILIAR ESPEC. B', 45.0, 45.0, 0.0, true],
  ['AUXESP-A', 'AUXILIAR ESPEC. A', 45.0, 45.0, 0.0, true],
  ['CONTADOR', 'CONTADOR', 45.0, 45.0, 0.0, true],
  ['GCO', 'DIBUJANTE TECNICO', 45.0, 45.0, 0.0, true],
  ['MAE-A', 'MAESTRANZA A', 45.0, 45.0, 0.0, true],
  ['OPCALIF', 'PERSONAL AUXILIAR A', 45.0, 45.0, 0.0, true],
  ['GERENTE-SS', 'GERENTE-SS', 45.0, 45.0, 0.0, true],
  ['ADM-A', 'OPERARIO CALIFICADO', 45.0, 45.0, 0, true],
  ['2JEFE', 'VENDEDOR D', 45.0, 45.0, 0.0, true],
  ['OFICIAL', 'OFICIAL', 45.0, 45.0, 0, true],
  ['ASESCOM', 'ASESCOM', 45.0, 45.0, 0, true],
  ['ADM-A', 'OPERARIO', 45.0, 45.0, 0, true],
  ['OPCALIF', 'INGRESANTE', 45.0, 45.0, 0, true],
  ['OPLIMP', 'ASIST. OF. TECNICA', 45.0, 45.0, 0, true],
  ['VENDEDOR', 'ASIST. COMERCIAL', 45.0, 45.0, 0, true],
  ['ADMA', '2º JEFE', 45.0, 45.0, 0, true],
  ['MAEA', 'OP LIMPIEZA 1/2 JOR', 45.0, 45.0, 0.0, true],
  ['ADMA', '2º JEFE', 45.0, 45.0, 0, true],
  ['ADMA', 'ADMINISTRATIVO TALLER', 45.0, 45.0, 0, true],
  ['VENDEDOR', 'GERENTE COMERCIAL', 45.0, 45.0, 0, true],
  ['ASISCOM', 'ASISTENTE', 45.0, 45.0, 0, true],
  ['AUXA', 'AUXILIAR A', 45.0, 45.0, 0, true],
  ['ABOGADO', 'ABOGADO', 45.0, 45.0, 0, true],
  ['GERPOSVENT', 'GERPOSVENT', 45.0, 45.0, 0, true],
  ['GERJUNIOR', 'GERJUNIOR', 45.0, 45.0, 0, true],
  ['GER', 'GER', 45.0, 45.0, 0, true],
  ['AUX-A', 'AUXILIAR . A', 45.0, 45.0, 0, true],
  ['GERRHH', 'GERRRHH', 45.0, 45.0, 0, true],
  ['AUXESPA', 'AUXILIAR ESPEC. A', 45.0, 45.0, 0.0, true],
  ['VENDEDOR B', 'VENDEDOR B', 45.0, 45.0, 0.0, true],
  ['AUXB', 'AUXILIAR B', 45.0, 45.0, 0.0, true],
  ['GERENTEJR', 'GERENTE-JR', 45.0, 45.0, 0.0, true],
  ['GERENTESR', 'GERENTE-SR', 45.0, 45.0, 0, true],
  ['GERREG-CRS', 'GERENTE-SS', 45.0, 45.0, 0, true],
  ['GERREGCM', 'GERREG-CM', 45.0, 45.0, 0, true],
  ['MAEA JR', 'MAEA JR', 24.0, 48.0, 0, true],
  ['GERREGCRS', 'GERREG-CRS', 45.0, 45.0, 0, true],
  ['GSOBSJM', 'GERENTE COMERCIAL', 45.0, 45.0, 0, true],
  ['MAEAJR', 'MAESTRANZA JOR REDUC', 22.5, 45.0, 0, true]
];

// [cod_os, nombre, por_aporte, imp_aporte, por_reten, imp_reten]
const OBRAS_SOCIALES = [
  ['BAN', 'O.S. BANCARIA ARGENTINA', 6.0, 0.0, 3.0, 0.0],
  ['COM', 'COMI', 9.0, 85.0, 3.0, 0.0],
  ['CAPULTRA', 'O.S. CAPITANES ULTRAMAR Y OF M', 6.0, 0.0, 3.0, 0.0],
  ['DCP', 'O.S. DOCENTES PARTICULARES', 6.0, 0.0, 3.0, 0.0],
  ['EAI', 'O.S. EMPLEADOS AGENCIAS INFORM', 6.0, 0.0, 3.0, 0.0],
  ['FIA', 'FIAT RAHMI', 9.0, 0.0, 3.0, 0.0],
  ['MAE', 'O.S. PERSONAL DE MAESTRANZA', 6.0, 0.0, 3.0, 0.0],
  ['SIN O.S.', 'Ninguna', 0.0, 0.0, 0.0, 0.0],
  ['OSECAC', 'OSECAC', 6.0, 0.0, 3.0, 0.0],
  ['OMI', 'OSPOCE', 6.0, 0.0, 3.0, 0.0],
  ['OSA', 'OSPACA', 9.0, 0.0, 3.0, 0.0],
  ['COMNAV', 'OS COMISARIOS NAVALES', 9.0, 0.0, 3.0, 0.0],
  ['OSDE', 'O.S.D.E.', 9.0, 85.0, 3.0, 0.0],
  ['OSM', 'O.SOCIAL MEDICOS BS AS', 9.0, 85.0, 3.0, 0.0],
  ['OSP', 'OSPLAD', 6.0, 0.0, 3.0, 0.0],
  ['OSR', 'OSADRA Obra Soc.Arbitros de Fú', 6.0, 0.0, 3.0, 0.0],
  ['PBL', 'O.S. PERS. DE BARRACAS DE LANA', 6.0, 0.0, 3.0, 0.0],
  ['MERBENZ', 'OSP Sup.Mercedes Benz Arg.', 6.0, 0.0, 3.0, 0.0],
  ['SEG', 'OSSEG (Obra Soc.Pers.Seg)', 9.0, 0.0, 3.0, 0.0],
  ['SPP', 'OSPP', 9.0, 0.0, 3.0, 0.0],
  ['UOM', 'OS UNION OBRERA METALURG', 6.0, 0.0, 3.0, 0.0],
  ['TVL', '', 6.0, 0.0, 3.0, 0.0],
  ['MINISTROS', 'OS MINISTROS SECRETARIOS SUB', 6.0, 0.0, 3.0, 0.0],
  ['PERCIVIL', 'OS PERSONAL CIVIL DE LA NACION', 6.0, 0.0, 3.0, 0.0],
  ['OSE', 'OSECAC', 6.0, 0.0, 3.0, 0.0],
  ['TTH', 'UNION TRAB TURISMO', 6.0, 0.0, 3.0, 0.0],
  ['CAM', 'OS DE CONDUCTORES CAMIONEROS', 6.0, 0.0, 3.0, 0.0],
  ['MOLINERA', 'OS PERSONAL IND MOLINERA', 6.0, 0.0, 3.0, 0.0],
  ['EAR', 'REMISES', 6.0, 0.0, 3.0, 0.0],
  ['CAP', 'CAPATACES Y ESTIBADORES PORTUARIOS', 6.0, 0.0, 3.0, 0.0],
  ['POC', 'PERSONAL DEL ORGANISMO DE CONTROL EXTERNO', 6.0, 0.0, 3.0, 0.0],
  ['PERCONTEX', 'O.S. MUTUALIDAD INDUSTRIA TEXTIL ARG.', 6.0, 0.0, 3.0, 0.0],
  ['AERO', 'PERS. AERONAVEGANTES', 6.0, 0.0, 3.0, 0.0],
  ['MARINAMERC', 'OS MARINA MERCANTE', 6.0, 0.0, 3.0, 0.0],
  ['OSSDEB', 'P.S. PETROLEROS', 6.0, 0.0, 3.0, 0.0],
  ['MUTUALSANC', 'O.S. PERS.ASOC. MUTUAL SANCOR', 6.0, 0.0, 3.0, 0.0],
  ['PRM', 'O.S.PROGRAMAS MEDICOS SOC. ARG. CONS. MU', 6.0, 0.0, 3.0, 0.0],
  ['AUTCLUBARG', 'OS DEL PERSONAL DEL AUTOMOVIL CLUB ARG.', 6.0, 0.0, 3.0, 0.0],
  ['CAMEMPREM', 'O.S. CAMARA EMP AGENCIAS DE REMISES', 6.0, 0.0, 3.0, 0.0],
  ['PERS.MOSAI', 'O.S. DEL PERSONAL MOSAISTA', 6.0, 0.0, 3.0, 0.0],
  ['TURF', 'O.S. PERSONAL ACTIVIDAD DEL TURF', 6.0, 0.0, 3.0, 0.0],
  ['AUT', 'O.S.PERSONAL SEC. DE AUTORES Y AFINES', 6.0, 0.0, 3.0, 0.0],
  ['MMT', 'OS  DE MANDOS MEDIOS DE LAS TELECOMUNICA', 6.0, 0.0, 3.0, 0.0],
  ['TECVUELO', 'OS DE TECNICOS DE VUELO DE LINEAS AEREA', 6.0, 0.0, 3.0, 0.0],
  ['PATCABO', 'O.S. PATRONES DE CABOTAJE DE RIOS Y PUER', 6.0, 0.0, 3.0, 0.0],
  ['PERSALIM', 'O.S. PERSONAL DE LA IND. DE LA ALIMENTAC', 6.0, 0.0, 3.0, 0.0],
  ['PETROLEROS', 'O.S. PETROLEROS', 6.0, 0.0, 3.0, 0.0],
  ['OSPEDEA', 'OSPEDEA', 6.0, 0.0, 3.0, 0.0],
  ['OMINT', 'OMINT SOCIEDAD ANONlMA DE SERVICIOS', 6.0, 0.0, 3.0, 0.0],
  ['SUPMBENZ', 'OSP Sup.Mercedes Benz Arg.', 6.0, 0.0, 3.0, 0.0],
  ['PROGMED', 'O.S.PROGRAMAS MEDICOS SOC. ARG. CONS. MU', 6.0, 0.0, 3.0, 0.0],
  ['OSMMEDT', 'OS  DE MANDOS MEDIOS DE LAS TELECOMUNICA', 6.0, 0.0, 3.0, 0.0],
  ['902108', 'ASOCIACION MUTUAL SANCOR SALUD', 6.0, 0.0, 3.0, 0.0],
  ['900805', 'SWISS MEDICAL SA', 6.0, 0.0, 3.0, 0.0],
  ['901600', 'ASISTENCIA SANITARIA INTEGRAL S.A', 6.0, 0.0, 3.0, 0.0],
  ['901501', 'MEDICINA PREPAGA HOMINIS S.A', 6.0, 0.0, 3.0, 0.0],
  ['903507', 'PREVENCIÓN SALUD S.A.', 6.0, 0.0, 3.0, 0.0],
  ['904906', 'NOBIS S.A.', 6.0, 0.0, 3.0, 0.0],
  ['901105', 'GALENO ARGENTINA SOCIEDAD ANONIMA', 6.0, 0.0, 3.0, 0.0],
  ['2402', 'O.S. DEL PERSONAL JERARQUICO DEL TRANSPORTE AUTOMOTOR DE PASAJEROS DE CORDOBA Y AFINES', 6.0, 0.0, 3.0, 0.0],
  ['118804', 'O.S DE RECIBIDORES DE GRANOS Y ANEXOS', 6.0, 0.0, 3.0, 0.0],
  ['106609', 'O.S DE RECIBIDORES DE GRANOS Y ANEXOS', 6.0, 0.0, 3.0, 0.0],
  ['903309', 'O.S DE RECIBIDORES DE GRANOS Y ANEXOS', 6.0, 0.0, 3.0, 0.0],
  ['CIUDAD', 'OS. DE LOS MEDICOS DE LA CIUDAD DE BS AS', 6.0, 0.0, 3.0, 0.0]
];

// [columna, descripcion, cod_sindicato, tipo, base, pct, importe, cuenta, nota]
const SINDICALES = [
  ['CONT_INACAP',  'Contribución INACAP',                         null,    'contribucion', 'fijo',         0,      0, '288', 'Asignar gremio y monto vigente'],
  ['CONT_ESTRELLA','La Estrella — seguro de vida y sepelio',       'COMERCIO','contribucion','fijo',        0,      0, '191', 'Confirmar prima vigente'],
  ['CONT_OSECAC',  'Aporte extraordinario OSECAC',                 'COMERCIO','contribucion','fijo',        0,    100, '239', 'Por trabajador y por mes — confirmar'],
  ['CONT_UOM_CC',  'Cont. CC UOM SSRL 227/01',                     'UOM',   'contribucion', 'remunerativo', 0,      0, '307', 'Confirmar alícuota sobre remunerativo'],
  ['CONT_UOM_SV',  'Seguro de vida colectivo y sepelio UOM',       'UOM',   'contribucion', 'fijo',         0, 377.62, '308', 'Valor tomado del Excel de agosto 2026'],
  ['CONT_UOM_OS',  'Aportes y contribuciones no rem. OS UOM',      'UOM',   'contribucion', 'fijo',         0,      0, '309', 'Completar'],
  ['CONT_UOM_EXT', 'Contribución extraordinaria UOM (cuota)',      'UOM',   'contribucion', 'fijo',         0,    300, '310', 'Cuota 1/2 y 2/2 — verificar vigencia'],
  ['CONT_UOM_NR',  'Aporte y contribución no rem. UOM',            'UOM',   'contribucion', 'fijo',         0,      0, '311', 'Completar'],
  ['APO_SINDIC',   'Aporte solidario adicional UOM',               'UOM',   'aporte',       'fijo',         0,   2000, '189', 'Valor tomado del Excel de agosto 2026'],
];

export async function migrarAsientoAux() {
  await query(`
    CREATE TABLE IF NOT EXISTS obras_sociales_aportes (
      cod_os     TEXT PRIMARY KEY,
      nombre     TEXT NOT NULL DEFAULT '',
      por_aporte NUMERIC(6,2)  NOT NULL DEFAULT 0,
      imp_aporte NUMERIC(12,2) NOT NULL DEFAULT 0,
      por_reten  NUMERIC(6,2)  NOT NULL DEFAULT 0,
      imp_reten  NUMERIC(12,2) NOT NULL DEFAULT 0,
      direccion  TEXT, localidad TEXT, cp TEXT, telefono TEXT,
      activo     BOOLEAN NOT NULL DEFAULT true,
      updated_by TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await query(`
    CREATE TABLE IF NOT EXISTS categoria_params (
      cod_categoria TEXT PRIMARY KEY,
      descripcion   TEXT NOT NULL DEFAULT '',
      hs_normal     NUMERIC(6,2) NOT NULL DEFAULT 0,
      hs_min_imp    NUMERIC(6,2) NOT NULL DEFAULT 0,
      di_min_imp    NUMERIC(6,2) NOT NULL DEFAULT 0,
      aplica_tope   BOOLEAN NOT NULL DEFAULT true,
      updated_by    TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await query(`
    CREATE TABLE IF NOT EXISTS conceptos_sindicales (
      id            SERIAL PRIMARY KEY,
      columna       TEXT NOT NULL UNIQUE,
      descripcion   TEXT NOT NULL,
      cod_sindicato TEXT,
      tipo          TEXT NOT NULL DEFAULT 'contribucion',
      base          TEXT NOT NULL DEFAULT 'fijo',
      pct           NUMERIC(8,4)  NOT NULL DEFAULT 0,
      importe       NUMERIC(12,2) NOT NULL DEFAULT 0,
      cuenta        TEXT,
      confirmado    BOOLEAN NOT NULL DEFAULT false,
      nota          TEXT,
      activo        BOOLEAN NOT NULL DEFAULT true,
      updated_by    TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

  const res = { os: 0, categorias: 0, sindicales: 0 };

  if (!(await query('SELECT COUNT(*)::int AS n FROM obras_sociales_aportes')).rows[0].n) {
    for (const [cod, nombre, pa, ia, pr, ir] of OBRAS_SOCIALES) {
      await query(
        `INSERT INTO obras_sociales_aportes (cod_os, nombre, por_aporte, imp_aporte, por_reten, imp_reten)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (cod_os) DO NOTHING`, [cod, nombre, pa, ia, pr, ir]);
      res.os++;
    }
  }
  if (!(await query('SELECT COUNT(*)::int AS n FROM categoria_params')).rows[0].n) {
    for (const [cod, desc, hs, hsMin, diMin, tope] of CATEGORIAS) {
      await query(
        `INSERT INTO categoria_params (cod_categoria, descripcion, hs_normal, hs_min_imp, di_min_imp, aplica_tope)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (cod_categoria) DO NOTHING`, [cod, desc, hs, hsMin, diMin, tope]);
      res.categorias++;
    }
  }
  if (!(await query('SELECT COUNT(*)::int AS n FROM conceptos_sindicales')).rows[0].n) {
    for (const [col, desc, sind, tipo, base, pct, imp, cta, nota] of SINDICALES) {
      await query(
        `INSERT INTO conceptos_sindicales (columna, descripcion, cod_sindicato, tipo, base, pct, importe, cuenta, nota)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (columna) DO NOTHING`,
        [col, desc, sind, tipo, base, pct, imp, cta, nota]);
      res.sindicales++;
    }
  }
  return res;
}

export default migrarAsientoAux;
