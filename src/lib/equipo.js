import { query } from '../db.js';
import { idsACargo, idsDirectos } from './organigrama.js';

// Devuelve el Set de IDs de empleados a cargo del usuario (gerente) según el organigrama.
export async function idsEquipoDe(empleadoId) {
  const me = (await query('SELECT nom FROM empleados WHERE id=$1', [empleadoId])).rows[0];
  if (!me) return new Set();
  const emps = (await query(
    `SELECT e.id, e.nom, e.cat, em.nombre AS empresa, e.data
       FROM empleados e JOIN empresas em ON em.id=e.empresa_id WHERE e.activo=true`)).rows
    .map((r) => ({ id: r.id, nom: r.nom, cat: r.cat, empresa: r.empresa, lugar: r.data?.lugar, validador: r.data?.validador, areaOrg: r.data?.areaOrg, area: r.data?.area }));
  return idsACargo(emps, me.nom);
}

// Igual que idsEquipoDe pero SOLO reportes directos (sin todo el subárbol).
export async function idsDirectosDe(empleadoId) {
  const me = (await query('SELECT nom FROM empleados WHERE id=$1', [empleadoId])).rows[0];
  if (!me) return new Set();
  const emps = (await query(
    `SELECT e.id, e.nom, e.cat, em.nombre AS empresa, e.data
       FROM empleados e JOIN empresas em ON em.id=e.empresa_id WHERE e.activo=true`)).rows
    .map((r) => ({ id: r.id, nom: r.nom, cat: r.cat, empresa: r.empresa, lugar: r.data?.lugar, validador: r.data?.validador, areaOrg: r.data?.areaOrg, area: r.data?.area }));
  return idsDirectos(emps, me.nom);
}
