// Escala unificada de Grupo LEITEN (LEITEN / SINIS / BARTON) — jul-2026.
// Es el "monto final" objetivo por categoría × nivel (incluye el No Rem). El recibo se compone:
//   Sueldo (básico convenio) + Presentismo + Complemento función + No Rem = ESCALA UNIFICADA
// con "el mejor de las dos": si el básico de convenio supera la escala, el complemento es 0.
// Se siembra como convenio 'ESCALA-UNIF' en convenio_versiones (misma mecánica que IDEE-BIM).
import { query } from '../db.js';

const TITULO = 'Escala unificada Jul-2026';
// Claves = CATEGUNIF + ' ' + TRAMO (INI/JUN/SEMI/SEN), como vienen en el archivo de empleados.
const ESCALA = [
  ['OP INI', 1366190.00], ['OP JUN', 1434499.51], ['OP SEMI', 1577949.46], ['OP SEN', 1735744.40],
  ['OF INI', 1386733.02], ['OF JUN', 1456069.67], ['OF SEMI', 1601676.63], ['OF SEN', 1761844.30],
  ['ASI INI', 1406890.67], ['ASI JUN', 1477235.21], ['ASI SEMI', 1624958.73], ['ASI SEN', 1787454.60],
  ['ANA INI', 1787454.60], ['ANA JUN', 1876827.33], ['ANA SEMI', 2064510.06], ['ANA SEN', 2270961.07],
  ['COO INI', 2270961.07], ['COO JUN', 2453092.15], ['COO SEMI', 2698401.36], ['COO SEN', 2968241.50],
  ['JEF INI', 2968241.50], ['JEF JUN', 3116653.57], ['JEF SEMI', 3428318.93], ['JEF SEN', 3771150.82],
  ['GER INI', 3845442.49], ['GER JUN', 3845442.49], ['GER SEMI', 4229986.74], ['GER SEN', 4652985.42],
  // Regionales (valor único por región).
  ['REGIONAL NCM', 2970858.09],   // Neuquén/Córdoba-Mendoza/Rosario-Sta Fe-Ctes
  ['REGIONAL BSAS', 2659051.24],  // Buenos Aires - 3F
  ['REGIONAL JM', 3565029.71],    // Buenos Aires - JM
];

export async function migrarEscalaUnif() {
  const existe = await query("SELECT 1 FROM convenio_versiones WHERE codigo='ESCALA-UNIF' AND vigencia='2026-07-01'");
  if (existe.rowCount > 0) return { skip: true };
  const data = {
    tablas: [{ titulo: TITULO, subtitulo: 'Monto final por categoría × nivel (incluye No Rem)', tipo: 'mensual',
      cats: ESCALA.map(([cat, basico]) => ({ cat, basico, ok: true })) }],
    adicionales: [], noRemunerativos: [],
  };
  await query(
    `INSERT INTO convenio_versiones (codigo, vigencia, mes_label, origen, data, creado_por)
     VALUES ('ESCALA-UNIF','2026-07-01','Julio 2026','inicial',$1,'seed')`,
    [JSON.stringify(data)]);
  return { skip: false, cats: ESCALA.length };
}
