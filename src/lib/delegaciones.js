// Delegaciones: un gerente delega una tarea de aprobación en otro empleado.
// El delegado opera esa tarea sobre el equipo del gerente que delegó.
import { query } from '../db.js';
import { idsEquipoDe, idsDirectosDe } from './equipo.js';

export const TAREAS = ['adelantos', 'fichadas', 'licencias', 'evaluaciones'];
export const TAREA_LABEL = {
  adelantos: 'Adelantos (recomendar)',
  fichadas: 'Fichadas (autorizar)',
  licencias: 'Licencias (aprobar)',
  evaluaciones: 'Evaluaciones',
};

// Condición SQL de delegación vigente (activa y dentro de fechas).
const VIGENTE = `estado='activa' AND (desde IS NULL OR desde <= CURRENT_DATE) AND (hasta IS NULL OR hasta >= CURRENT_DATE)`;

// Delegaciones VIGENTES recibidas por un empleado (opcionalmente filtrando por tarea).
export async function delegacionesRecibidas(delegadoId, tarea = null) {
  const params = [delegadoId];
  let cond = `d.delegado_id = $1 AND ${VIGENTE}`;
  if (tarea) { params.push(tarea); cond += ` AND d.tarea = $2`; }
  const { rows } = await query(
    `SELECT d.id, d.delegante_id, d.tarea, d.desde, d.hasta,
            e.nom AS delegante_nom, em.nombre AS delegante_empresa
       FROM delegaciones d
       JOIN empleados e ON e.id = d.delegante_id
       JOIN empresas em ON em.id = e.empresa_id
      WHERE ${cond}
      ORDER BY d.tarea`, params);
  return rows;
}

// Set de empleados sobre los que `user` puede operar la `tarea`:
//   su propio equipo (si es gerente) + el equipo de cada gerente que le delegó la tarea.
// ownFn define el alcance propio (idsEquipoDe = subárbol; idsDirectosDe = directos).
export async function equipoEfectivo(user, tarea, ownFn = idsEquipoDe) {
  const ids = new Set();
  if (user.role === 'manager') for (const x of await ownFn(user.id)) ids.add(x);
  for (const d of await delegacionesRecibidas(user.id, tarea)) {
    for (const x of await idsEquipoDe(d.delegante_id)) ids.add(x);
  }
  return ids;
}

// ¿El usuario puede actuar como gerente en esta tarea? (gerente/admin nativo, o delegado vigente)
export async function esGestorDeTarea(user, tarea) {
  if (user.role === 'manager' || user.role === 'admin') return true;
  return (await delegacionesRecibidas(user.id, tarea)).length > 0;
}

// ¿Tiene alguna delegación vigente de esta tarea? (para sumar acceso a gestores nativos)
export async function tieneDelegacion(user, tarea) {
  return (await delegacionesRecibidas(user.id, tarea)).length > 0;
}

// Texto para auditoría cuando actúa un delegado: "por delegación de A, B".
export async function notaDelegacion(user, tarea) {
  if (user.role === 'manager' || user.role === 'admin') return null;
  const dels = await delegacionesRecibidas(user.id, tarea);
  return dels.length ? `por delegación de ${dels.map((d) => d.delegante_nom).join(', ')}` : null;
}

export { idsDirectosDe };
