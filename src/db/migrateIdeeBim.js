// Escala IDEE (UECARA / fuera de convenio) — roles BIM con niveles de seniority.
// El monto de cada nivel YA incluye el presentismo (sólo el bono no remunerativo va aparte).
// Se siembra como convenio 'IDEE-BIM' en convenio_versiones para que la liquidación mensual
// tome el básico por 'categoria_convenio' = 'Escala IDEE Jul-2026||<ROL NIVEL>'.
import { query } from '../db.js';

const TITULO = 'Escala IDEE Jul-2026';
// Validada contra la planilla: JR = Inicial×1,05 ; SSR = JR×1,10 ; SR = SSR×1,10 (Gerente JR = 0%).
const ESCALA = [
  ['MAESTRANZA INICIAL', 1117141.47], ['MAESTRANZA JR', 1172864.81], ['MAESTRANZA SSR', 1290151.29], ['MAESTRANZA SR', 1419166.42],
  ['ASISTENTE INICIAL', 1460339.73], ['ASISTENTE JR', 1533356.72], ['ASISTENTE SSR', 1686692.39], ['ASISTENTE SR', 1855361.63],
  ['ANALISTA INICIAL', 1855361.63], ['ANALISTA JR', 1948129.71], ['ANALISTA SSR', 2142942.68], ['ANALISTA SR', 2357236.95],
  ['JEFE DE EQUIPO INICIAL', 2357236.95], ['JEFE DE EQUIPO JR', 2475098.80], ['JEFE DE EQUIPO SSR', 2722608.68], ['JEFE DE EQUIPO SR', 2994869.55],
  ['JEFE DE DEPARTAMENTO INICIAL', 2994869.55], ['JEFE DE DEPARTAMENTO JR', 3144613.03], ['JEFE DE DEPARTAMENTO SSR', 3459074.33], ['JEFE DE DEPARTAMENTO SR', 3804981.76],
  ['GERENTE INICIAL', 3845442.49], ['GERENTE JR', 3845442.49], ['GERENTE SSR', 4229986.74], ['GERENTE SR', 4652985.42],
  ['GERENCIA (SOCIO)', 3082155.00],   // legajo 5014: base que sube con el mismo % de paritaria
];

export async function migrarIdeeBim() {
  const existe = await query("SELECT 1 FROM convenio_versiones WHERE codigo='IDEE-BIM' AND vigencia='2026-07-01'");
  if (existe.rowCount > 0) return { skip: true };
  const data = {
    tablas: [{ titulo: TITULO, subtitulo: 'Monto incluye básico + presentismo (bono NR aparte)', tipo: 'mensual',
      cats: ESCALA.map(([cat, basico]) => ({ cat, basico, ok: true })) }],
    adicionales: [], noRemunerativos: [],
  };
  await query(
    `INSERT INTO convenio_versiones (codigo, vigencia, mes_label, origen, data, creado_por)
     VALUES ('IDEE-BIM','2026-07-01','Julio 2026','inicial',$1,'seed')`,
    [JSON.stringify(data)]);

  // Básicos de convenio UECARA (CCT 660/13) por categoría — jul-2026 (de los recibos reales).
  const uec = await query("SELECT 1 FROM convenio_versiones WHERE codigo='UECARA' AND vigencia='2026-07-01'");
  if (uec.rowCount === 0) {
    const dataU = {
      tablas: [{ titulo: 'UECARA Jul-2026', subtitulo: 'CCT 660/13', tipo: 'mensual', cats: [
        { cat: 'ANALISTA ADM. 1° CAT', basico: 1579990, ok: true },
        { cat: 'AUXILIAR ADM. 2° CAT', basico: 1461443, ok: true },
        { cat: 'AY. TECNICO 3° CAT', basico: 1476305, ok: true },
        { cat: 'AUXILIAR TECNICO 2°', basico: 1603918, ok: true },
      ] }],
      adicionales: [{ concepto: 'Suma no remunerativa', detalle: '$67.100 (solo OS 3%)', rem: false }],
      noRemunerativos: [],
    };
    await query(
      `INSERT INTO convenio_versiones (codigo, vigencia, mes_label, origen, data, creado_por)
       VALUES ('UECARA','2026-07-01','Julio 2026','inicial',$1,'seed')`,
      [JSON.stringify(dataU)]);
  }
  return { skip: false, cats: ESCALA.length };
}
