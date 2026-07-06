// Migración idempotente: siembra la tabla `puestos` a partir del organigrama
// actual (reglas name-based de getValidador) y asigna empleados.puesto_id.
// Se ejecuta en el arranque; si ya hay puestos cargados, no hace nada.
//
// Reproduce fielmente el árbol que hoy ve el usuario:
//   • cada NODO del organigrama (un gerente / bucket de área) → un "puesto de
//     jefatura", ocupado por esa persona;
//   • los DIRECTOS de ese nodo → un "puesto de equipo" que reporta a la
//     jefatura, con todos los directos como ocupantes (un puesto puede
//     compartirse entre varios empleados);
//   • reporta_a se arma por la relación nodo → nodo padre.
// A partir de acá RR.HH. edita la estructura y agrega mandos medios.
import { pool } from '../db.js';
import { construirOrganigrama, getValidador } from '../lib/organigrama.js';

export async function migrarPuestos() {
  const ya = await pool.query('SELECT count(*)::int AS n FROM puestos');
  if (ya.rows[0].n > 0) return { creados: 0, skip: true };

  const { rows } = await pool.query(
    `SELECT e.id, e.nom, e.cat, e.tramo, e.leg_num, em.nombre AS empresa, e.data
       FROM empleados e JOIN empresas em ON em.id = e.empresa_id
      WHERE e.activo = true`);
  if (!rows.length) return { creados: 0, skip: true };

  const nomina = rows.map((r) => {
    const d = r.data || {};
    return {
      id: r.id, nom: r.nom, cat: r.cat, tramo: r.tramo, legNum: r.leg_num, empresa: r.empresa,
      lugar: d.lugar, tarea: d.tarea, foto: d.foto,
      validador: d.validador, areaOrg: d.areaOrg, area: d.area,
      validadorGoToHR: d.validadorGoToHR, validadorAutoApproved: d.validadorAutoApproved,
    };
  });

  const { nodos } = construirOrganigrama(nomina);
  const nombres = Object.keys(nodos);

  // Padre de cada nodo (nombre → nombre del superior).
  const padreDe = {};
  for (const n of nombres) for (const sub of Object.keys(nodos[n].subManagers)) padreDe[sub] = n;

  const client = await pool.connect();
  let seq = 0;
  const codigo = () => 'P' + String(++seq).padStart(3, '0');
  try {
    await client.query('BEGIN');

    // Fase 1: crear puestos (jefatura + equipo) sin reporta_a.
    const jefaturaId = {};   // nombre de nodo → id del puesto de jefatura
    const equipoId = {};     // nombre de nodo → id del puesto de equipo (si tiene directos)
    for (const nombre of nombres) {
      const nodo = nodos[nombre];
      const emp = nodo.empleado;
      // El nombre/área del puesto de jefatura sale del área PROPIA del titular
      // (getValidador del gerente), no del área que traen sus subordinados.
      const vEmp = emp ? getValidador({ ...emp, emp: emp.empresa }) : null;
      const goHR = vEmp ? !!vEmp.goToHR : true;
      const areaJef = (vEmp && vEmp.area && vEmp.area.trim()) ? vEmp.area.trim() : (nodo.area || '').trim();
      const nombrePuesto = areaJef || nombre;
      const jef = await client.query(
        'INSERT INTO puestos (codigo, nombre, area, go_to_hr, orden) VALUES ($1,$2,$3,$4,$5) RETURNING id',
        [codigo(), nombrePuesto, areaJef || null, goHR, 0]);
      jefaturaId[nombre] = jef.rows[0].id;
      if (emp && emp.id != null) await client.query('UPDATE empleados SET puesto_id=$1 WHERE id=$2', [jef.rows[0].id, emp.id]);

      // Directos reales: excluye al propio titular cuando es su propio validador (raíces auto-aprobadas).
      const directos = nodo.directos.filter((d) => d.emp && String(d.emp.nom).toUpperCase().trim() !== nombre);
      if (directos.length) {
        const goHRd = !!getValidador({ ...directos[0].emp, emp: directos[0].emp.empresa }).goToHR;
        const eq = await client.query(
          'INSERT INTO puestos (codigo, nombre, area, go_to_hr, orden) VALUES ($1,$2,$3,$4,$5) RETURNING id',
          [codigo(), `${nombrePuesto} — Equipo`, areaJef || null, goHRd, 1]);
        equipoId[nombre] = eq.rows[0].id;
        for (const d of directos) if (d.emp && d.emp.id != null) await client.query('UPDATE empleados SET puesto_id=$1 WHERE id=$2', [eq.rows[0].id, d.emp.id]);
      }
    }

    // Fase 2: reporta_a. Jefatura → jefatura del nodo padre. Equipo → su jefatura.
    for (const nombre of nombres) {
      const padre = padreDe[nombre];
      if (padre && jefaturaId[padre]) await client.query('UPDATE puestos SET reporta_a=$1 WHERE id=$2', [jefaturaId[padre], jefaturaId[nombre]]);
      if (equipoId[nombre]) await client.query('UPDATE puestos SET reporta_a=$1 WHERE id=$2', [jefaturaId[nombre], equipoId[nombre]]);
    }

    await client.query('COMMIT');
    const total = (await pool.query('SELECT count(*)::int AS n FROM puestos')).rows[0].n;
    return { creados: total, skip: false };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
