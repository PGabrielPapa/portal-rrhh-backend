// Bandeja unificada de aprobaciones pendientes del usuario (adelantos, licencias,
// sanciones) según su rol/puesto/equipo. Alimenta la página "Aprobaciones
// pendientes" y el contador del menú.
import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { equipoEfectivo } from '../lib/delegaciones.js';
import { pasoActual, puedeResolver } from '../lib/workflowEngine.js';

const router = Router();
router.use(requireAuth);

async function puestoDe(userId) {
  const r = (await query('SELECT puesto_id FROM empleados WHERE id=$1', [userId])).rows[0];
  return r ? r.puesto_id : null;
}

const CIRCUITOS = [
  { proceso: 'adelantos', tabla: 'anticipos', aprobTabla: 'anticipo_aprobaciones', fk: 'anticipo_id', estadoPend: 'pendiente', tarea: 'adelantos', base: '/anticipos', tipo: 'adelanto' },
  { proceso: 'licencias', tabla: 'licencias', aprobTabla: 'licencia_aprobaciones', fk: 'licencia_id', estadoPend: 'pendiente', tarea: 'licencias', base: '/licencias', tipo: 'licencia' },
  { proceso: 'sanciones', tabla: 'sanciones', aprobTabla: 'sancion_aprobaciones', fk: 'sancion_id', estadoPend: 'solicitada', tarea: 'sanciones', base: '/sanciones', tipo: 'sancion' },
];

// GET /api/aprobaciones/pendientes — items en los que el usuario puede resolver el paso actual.
router.get('/pendientes', async (req, res, next) => {
  try {
    const uPuesto = await puestoDe(req.user.id);
    const out = [];
    for (const c of CIRCUITOS) {
      const cand = (await query(
        `SELECT s.id, s.empleado_id, s.workflow, s.created_at, e.nom, e.leg_num
           FROM ${c.tabla} s JOIN empleados e ON e.id = s.empleado_id
          WHERE s.estado = $1 AND s.workflow IS NOT NULL`, [c.estadoPend])).rows;
      if (!cand.length) continue;
      const ids = cand.map((x) => x.id);
      const aprobs = (await query(`SELECT ${c.fk} AS pid, orden, decision FROM ${c.aprobTabla} WHERE ${c.fk} = ANY($1)`, [ids])).rows;
      const byId = new Map();
      for (const a of aprobs) { if (!byId.has(a.pid)) byId.set(a.pid, []); byId.get(a.pid).push(a); }
      const team = req.user.role === 'manager' ? await equipoEfectivo(req.user, c.tarea) : null;
      for (const it of cand) {
        const pasos = Array.isArray(it.workflow) ? it.workflow : [];
        const paso = pasoActual(pasos, byId.get(it.id) || []);
        if (!paso) continue;
        const enEquipo = team ? team.has(it.empleado_id) : false;
        if (!puedeResolver(paso, { role: req.user.role, puestoId: uPuesto }, { enEquipo })) continue;
        out.push({
          tipo: c.tipo, proceso: c.proceso, base: c.base, id: it.id,
          empleado: it.nom, legNum: it.leg_num, createdAt: it.created_at,
          paso: paso.etiqueta || (paso.puesto ? 'puesto asignado' : paso.rol),
        });
      }
    }
    out.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
    res.json({ total: out.length, items: out });
  } catch (e) { next(e); }
});

export default router;
