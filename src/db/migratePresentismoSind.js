// Configuración de aportes/adicionales POR CONVENIO (fuente única de las fórmulas del motor).
// Los empleados usan códigos SEC, PLASTICO, UOM, ASIMRA, UECARA (y FC = fuera de convenio).
// Esta migración garantiza que existan las filas con los códigos reales y sus valores, y agrega
// los campos nuevos que las fórmulas leen desde Sindicatos:
//   - monto_antig_por_anio: antigüedad como MONTO fijo por año (UECARA $13.332); si es 0, se usa el %.
//   - complemento_sin_norem: el complemento función NO resta el No Rem (UECARA).
//   - pct_art37_1 / pct_art37_2: aportes especiales Art. 37 I y II (UECARA), en vez de ANSSAL/cuota.
//   - titulo_secundario / titulo_universitario: adicional por título (monto fijo).
// Idempotente (upsert por codigo): fija los valores esperados en cada arranque.
import { query } from '../db.js';

// Config por convenio. pctSolidario = aporte solidario del NO afiliado (0 = cobra cuota).
const CFG = [
  { cod: 'SEC', nom: 'Empleados de Comercio (SEC/FAECYS)', pctPres: 8.33, pctAntig: 1, presBase: 'basico+antig+titulo', titAdic: true, pEmp: 2.5, pPat: 0.5, nota: 'Cuota sindical 2% + FAECYS 0,5%', nrAP: true, pSolid: 0, montoAntig: 0, compSinNR: false, art1: 0, art2: 0, titSec: 0, titUni: 0 },
  { cod: 'PLASTICO', nom: 'Unión Obreros y Emp. Plásticos', pctPres: 10, pctAntig: 2, presBase: 'basico', titAdic: false, pEmp: 2, pPat: 1.5, nota: 'Aporte UOYEP', nrAP: false, pSolid: 1.4, montoAntig: 0, compSinNR: false, art1: 0, art2: 0, titSec: 0, titUni: 0 },
  { cod: 'UOM', nom: 'Unión Obrera Metalúrgica', pctPres: 10, pctAntig: 1, presBase: 'basico+antig', titAdic: true, pEmp: 2.5, pPat: 1.5, nota: 'Cuota sindical + FONDO', nrAP: false, pSolid: 0, montoAntig: 0, compSinNR: false, art1: 0, art2: 0, titSec: 0, titUni: 0 },
  { cod: 'ASIMRA', nom: 'Sup. Industria Metalmecánica', pctPres: 0, pctAntig: 1, presBase: 'basico+antig', titAdic: true, pEmp: 3, pPat: 1.5, nota: 'Cuota sindical + fondo cultura', nrAP: false, pSolid: 0, montoAntig: 0, compSinNR: false, art1: 0, art2: 0, titSec: 0, titUni: 0 },
  // UECARA (CCT 660/13): antigüedad FIJA $13.332/año, presentismo 10% s/básico, complemento SIN No Rem,
  // aportes especiales Art. 37 I 1,5% y II 1% (no ANSSAL ni cuota), adicional título 49.820 / 72.944.
  { cod: 'UECARA', nom: 'Empl. de Conducción (UECARA)', pctPres: 10, pctAntig: 0, presBase: 'basico', titAdic: true, pEmp: 0, pPat: 0, nota: 'Antig. fija $/año · Art.37 I/II · complemento sin No Rem', nrAP: false, pSolid: 0, montoAntig: 13332, compSinNR: true, art1: 1.5, art2: 1, titSec: 49820, titUni: 72944, premio: 0 },
  // UOCRA (jornal, CCT 76/75): cuota afiliado 2,5% · aporte solidario no afiliado 2% · premio asistencia 20%.
  { cod: 'UOCRA', nom: 'Unión Obrera de la Construcción (UOCRA)', pctPres: 0, pctAntig: 1, presBase: 'basico', titAdic: false, pEmp: 2.5, pPat: 2, nota: 'Jornal · premio 20% · cuota 2,5% / solidario 2%', nrAP: false, pSolid: 2, montoAntig: 0, compSinNR: false, art1: 0, art2: 0, titSec: 0, titUni: 0, premio: 20 },
];

export async function migrarPresentismoSind() {
  await query(`ALTER TABLE sindicatos ADD COLUMN IF NOT EXISTS pct_presentismo NUMERIC(6,2) NOT NULL DEFAULT 0`);
  await query(`ALTER TABLE sindicatos ADD COLUMN IF NOT EXISTS no_rem_con_antig_pres BOOLEAN NOT NULL DEFAULT false`);
  await query(`ALTER TABLE sindicatos ADD COLUMN IF NOT EXISTS pct_solidario NUMERIC(6,2) NOT NULL DEFAULT 0`);
  await query(`ALTER TABLE sindicatos ADD COLUMN IF NOT EXISTS monto_antig_por_anio NUMERIC(14,2) NOT NULL DEFAULT 0`);
  await query(`ALTER TABLE sindicatos ADD COLUMN IF NOT EXISTS complemento_sin_norem BOOLEAN NOT NULL DEFAULT false`);
  await query(`ALTER TABLE sindicatos ADD COLUMN IF NOT EXISTS pct_art37_1 NUMERIC(6,2) NOT NULL DEFAULT 0`);
  await query(`ALTER TABLE sindicatos ADD COLUMN IF NOT EXISTS pct_art37_2 NUMERIC(6,2) NOT NULL DEFAULT 0`);
  await query(`ALTER TABLE sindicatos ADD COLUMN IF NOT EXISTS pct_premio NUMERIC(6,2) NOT NULL DEFAULT 0`);
  let tocadas = 0;
  for (const c of CFG) {
    const r = await query(
      `INSERT INTO sindicatos (codigo, nombre, pct_empleado, pct_patronal, pct_antig_por_anio, nota, tiene_adicional_titulo, pres_base, pct_presentismo, no_rem_con_antig_pres, pct_solidario, monto_antig_por_anio, complemento_sin_norem, pct_art37_1, pct_art37_2, titulo_secundario, titulo_universitario, pct_premio)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       ON CONFLICT (codigo) DO UPDATE SET
         nombre=EXCLUDED.nombre, pct_empleado=EXCLUDED.pct_empleado, pct_patronal=EXCLUDED.pct_patronal,
         pct_antig_por_anio=EXCLUDED.pct_antig_por_anio, nota=EXCLUDED.nota,
         tiene_adicional_titulo=EXCLUDED.tiene_adicional_titulo, pres_base=EXCLUDED.pres_base,
         pct_presentismo=EXCLUDED.pct_presentismo, no_rem_con_antig_pres=EXCLUDED.no_rem_con_antig_pres,
         pct_solidario=EXCLUDED.pct_solidario, monto_antig_por_anio=EXCLUDED.monto_antig_por_anio,
         complemento_sin_norem=EXCLUDED.complemento_sin_norem, pct_art37_1=EXCLUDED.pct_art37_1,
         pct_art37_2=EXCLUDED.pct_art37_2, titulo_secundario=EXCLUDED.titulo_secundario,
         titulo_universitario=EXCLUDED.titulo_universitario, pct_premio=EXCLUDED.pct_premio`,
      [c.cod, c.nom, c.pEmp, c.pPat, c.pctAntig, c.nota, c.titAdic, c.presBase, c.pctPres, c.nrAP, c.pSolid, c.montoAntig, c.compSinNR, c.art1, c.art2, c.titSec, c.titUni, c.premio || 0]);
    tocadas += r.rowCount;
  }
  return { skip: false, tocadas };
}
