// Presentismo por convenio + flag de antigüedad/presentismo sobre el No Rem.
// Los empleados del Grupo LEITEN usan los códigos de sindicato SEC, PLASTICO, UOM, ASIMRA
// (y FC = fuera de convenio). El catálogo original tenía 'COMERCIO' y 'UOYEP', que NO matcheaban,
// por eso el presentismo caía al 5% por defecto y la antigüedad al 1%. Esta migración garantiza que
// existan las filas con los códigos reales y sus valores correctos, y marca qué convenios calculan
// antigüedad + presentismo sobre la asignación no remunerativa (Comercio sí; el resto no).
//   - SEC (Comercio):  presentismo 8,33% · antig 1%/año · base básico+antig · SÍ antig/pres s/No Rem.
//   - PLASTICO:        presentismo 10%   · antig 2%/año · base básico       · NO.
//   - UOM:             presentismo 10%   · antig 1%/año · base básico+antig · NO.
//   - ASIMRA:          presentismo 0%    · antig 1%/año · base básico+antig · NO.
// Idempotente (upsert por codigo): fija los valores esperados en cada arranque.
import { query } from '../db.js';

// [codigo, nombre, pctPres, pctAntig, presBase, tituloAdic, pctEmpleado, pctPatronal, nota, noRemAntigPres, pctSolidario]
// pctSolidario = aporte solidario del trabajador NO afiliado (0 = no aplica; cobra cuota sindical).
const CFG = [
  ['SEC', 'Empleados de Comercio (SEC/FAECYS)', 8.33, 1, 'basico+antig+titulo', true, 2.5, 0.5, 'Cuota sindical 2% + FAECYS 0,5%', true, 0],
  ['PLASTICO', 'Unión Obreros y Emp. Plásticos', 10, 2, 'basico', false, 2, 1.5, 'Aporte UOYEP', false, 1.4],
  ['UOM', 'Unión Obrera Metalúrgica', 10, 1, 'basico+antig', true, 2.5, 1.5, 'Cuota sindical + FONDO', false, 0],
  ['ASIMRA', 'Sup. Industria Metalmecánica', 0, 1, 'basico+antig', true, 3, 1.5, 'Cuota sindical + fondo cultura', false, 0],
];

export async function migrarPresentismoSind() {
  await query(`ALTER TABLE sindicatos ADD COLUMN IF NOT EXISTS pct_presentismo NUMERIC(6,2) NOT NULL DEFAULT 0`);
  await query(`ALTER TABLE sindicatos ADD COLUMN IF NOT EXISTS no_rem_con_antig_pres BOOLEAN NOT NULL DEFAULT false`);
  await query(`ALTER TABLE sindicatos ADD COLUMN IF NOT EXISTS pct_solidario NUMERIC(6,2) NOT NULL DEFAULT 0`);
  let tocadas = 0;
  for (const [cod, nom, pctPres, pctAntig, presBase, titAdic, pEmp, pPat, nota, nrAP, pSolid] of CFG) {
    const r = await query(
      `INSERT INTO sindicatos (codigo, nombre, pct_empleado, pct_patronal, pct_antig_por_anio, nota, tiene_adicional_titulo, pres_base, pct_presentismo, no_rem_con_antig_pres, pct_solidario)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (codigo) DO UPDATE SET
         nombre=EXCLUDED.nombre, pct_empleado=EXCLUDED.pct_empleado, pct_patronal=EXCLUDED.pct_patronal,
         pct_antig_por_anio=EXCLUDED.pct_antig_por_anio, nota=EXCLUDED.nota,
         tiene_adicional_titulo=EXCLUDED.tiene_adicional_titulo, pres_base=EXCLUDED.pres_base,
         pct_presentismo=EXCLUDED.pct_presentismo, no_rem_con_antig_pres=EXCLUDED.no_rem_con_antig_pres,
         pct_solidario=EXCLUDED.pct_solidario`,
      [cod, nom, pEmp, pPat, pctAntig, nota, titAdic, presBase, pctPres, nrAP, pSolid]);
    tocadas += r.rowCount;
  }
  return { skip: false, tocadas };
}
