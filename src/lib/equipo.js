import { query } from '../db.js';
import { idsACargo, idsDirectos } from './organigrama.js';

// ─────────────────────────────────────────────────────────────────────────
// Equipo / aprobadores POR PUESTO (organigrama fase 2).
// El equipo de un responsable se arma por la cadena de puestos (reporta_a):
// son sus subordinados los ocupantes de los puestos que cuelgan del suyo.
// Como un puesto puede tener varios ocupantes, cualquiera de ellos "ve" y
// aprueba a todo ese subárbol (todos comparten el mismo puesto_id).
// Si el responsable todavía NO tiene puesto asignado, se cae al organigrama
// por nombre (lógica histórica), para no dejar a nadie sin aprobador.
// ─────────────────────────────────────────────────────────────────────────

// Fallback por nombre (reglas name-based de getValidador).
async function porNombre(empleadoId, fn) {
  const me = (await query('SELECT nom FROM empleados WHERE id=$1', [empleadoId])).rows[0];
  if (!me) return new Set();
  const emps = (await query(
    `SELECT e.id, e.nom, e.cat, em.nombre AS empresa, e.data
       FROM empleados e JOIN empresas em ON em.id=e.empresa_id WHERE e.activo=true`)).rows
    .map((r) => ({ id: r.id, nom: r.nom, cat: r.cat, empresa: r.empresa, lugar: r.data?.lugar, validador: r.data?.validador, areaOrg: r.data?.areaOrg, area: r.data?.area }));
  return fn(emps, me.nom);
}

// Puestos que cuelgan (recursivamente o solo directos) de un puesto raíz.
function puestosDebajo(hijos, raizId, soloDirectos) {
  const out = new Set();
  const inmediatos = hijos.get(raizId) || [];
  if (soloDirectos) { for (const c of inmediatos) out.add(c); return out; }
  const stack = [...inmediatos];
  while (stack.length) {
    const id = stack.pop();
    if (out.has(id)) continue;
    out.add(id);
    for (const c of (hijos.get(id) || [])) stack.push(c);
  }
  return out;
}

// Equipo desde puestos. Devuelve un Set de IDs, o null si el responsable no
// tiene puesto asignado (para caer al fallback por nombre).
async function equipoDesdePuesto(empleadoId, soloDirectos) {
  const me = (await query('SELECT puesto_id FROM empleados WHERE id=$1', [empleadoId])).rows[0];
  if (!me || me.puesto_id == null) return null;
  const puestos = (await query('SELECT id, reporta_a FROM puestos')).rows;
  if (!puestos.length) return null;
  const hijos = new Map();
  for (const p of puestos) if (p.reporta_a != null) { if (!hijos.has(p.reporta_a)) hijos.set(p.reporta_a, []); hijos.get(p.reporta_a).push(p.id); }
  const debajo = puestosDebajo(hijos, me.puesto_id, soloDirectos);
  if (!debajo.size) return new Set();
  const { rows } = await query('SELECT id FROM empleados WHERE activo=true AND puesto_id = ANY($1)', [[...debajo]]);
  return new Set(rows.map((r) => r.id));
}

// Set de IDs de empleados a cargo del responsable (subárbol completo).
export async function idsEquipoDe(empleadoId) {
  try { const s = await equipoDesdePuesto(empleadoId, false); if (s) return s; } catch { /* fallback */ }
  return porNombre(empleadoId, idsACargo);
}

// Igual que idsEquipoDe pero SOLO reportes directos (sin descender el subárbol).
export async function idsDirectosDe(empleadoId) {
  try { const s = await equipoDesdePuesto(empleadoId, true); if (s) return s; } catch { /* fallback */ }
  return porNombre(empleadoId, idsDirectos);
}
