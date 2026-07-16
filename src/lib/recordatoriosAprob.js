// Recordatorios de aprobaciones pendientes (SLA): si un paso de un flujo (adelanto,
// licencia, sanción) lleva más de N días sin resolverse, avisa al aprobador de turno.
// Best-effort: nunca frena nada. Se dispara una vez por día desde server.js.
import { query } from '../db.js';
import { pasoActual } from './workflowEngine.js';
import { avisarAprobadorPendiente } from './notifAprob.js';

const CIRCUITOS = [
  { proceso: 'adelantos', tabla: 'anticipos', aprob: 'anticipo_aprobaciones', fk: 'anticipo_id', pend: 'pendiente' },
  { proceso: 'licencias', tabla: 'licencias', aprob: 'licencia_aprobaciones', fk: 'licencia_id', pend: 'pendiente' },
  { proceso: 'sanciones', tabla: 'sanciones', aprob: 'sancion_aprobaciones', fk: 'sancion_id', pend: 'solicitada' },
];

export async function enviarRecordatoriosAprobaciones(opts = {}) {
  const dias = Math.max(1, Number(opts.dias || process.env.RECORDATORIO_APROB_DIAS || 3));
  const ahora = Date.now();
  let enviados = 0;
  for (const c of CIRCUITOS) {
    let cand;
    try {
      cand = (await query(
        `SELECT s.id, s.workflow, s.created_at,
                (SELECT max(at) FROM ${c.aprob} x WHERE x.${c.fk} = s.id) AS last_at
           FROM ${c.tabla} s
          WHERE s.estado = $1 AND s.workflow IS NOT NULL`, [c.pend])).rows;
    } catch (e) { console.error(`[recordatorios] ${c.proceso}:`, e.message); continue; }
    if (!cand.length) continue;
    const ids = cand.map((x) => x.id);
    const aprobs = (await query(`SELECT ${c.fk} AS pid, orden, decision FROM ${c.aprob} WHERE ${c.fk} = ANY($1)`, [ids])).rows;
    const byId = new Map();
    for (const a of aprobs) { if (!byId.has(a.pid)) byId.set(a.pid, []); byId.get(a.pid).push(a); }
    for (const it of cand) {
      const pasos = Array.isArray(it.workflow) ? it.workflow : [];
      const paso = pasoActual(pasos, byId.get(it.id) || []);
      if (!paso) continue;
      const ref = it.last_at ? new Date(it.last_at).getTime() : new Date(it.created_at).getTime();
      const espera = Math.floor((ahora - ref) / 86400000);
      if (espera < dias) continue;
      avisarAprobadorPendiente({ proceso: c.proceso, paso, resumen: `Lleva ${espera} día(s) esperando tu aprobación.` });
      enviados++;
    }
  }
  return { enviados, dias };
}
