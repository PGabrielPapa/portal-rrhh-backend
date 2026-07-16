// Avisos de workflows de aprobación (best-effort: nunca rompen el request).
import { query } from '../db.js';
import { enviarMail, mailConfigurado } from './mailer.js';

const LABEL = { adelantos: 'adelanto', licencias: 'licencia', sanciones: 'sanción' };

// Emails de quienes pueden resolver un paso (por puesto o por rol).
async function emailsDePaso(paso) {
  if (!paso) return [];
  try {
    if (paso.puesto) {
      const r = await query("SELECT email FROM empleados WHERE puesto_id=$1 AND email IS NOT NULL AND email<>'' AND activo IS NOT false", [paso.puesto]);
      return r.rows.map((x) => x.email);
    }
    if (paso.rol && ['rrhh', 'admin'].includes(paso.rol)) {
      const r = await query("SELECT email FROM empleados WHERE role=$1 AND email IS NOT NULL AND email<>'' AND activo IS NOT false", [paso.rol]);
      return r.rows.map((x) => x.email);
    }
  } catch (e) { /* ignore */ }
  return []; // pasos de 'manager' se resuelven vía la bandeja del responsable (equipo)
}

// Avisa por mail al/los aprobador(es) del paso en curso.
export async function avisarAprobadorPendiente({ proceso, paso, resumen }) {
  try {
    if (!mailConfigurado() || !paso) return;
    const to = await emailsDePaso(paso);
    if (!to.length) return;
    const label = LABEL[proceso] || proceso;
    const etiqueta = paso.etiqueta || paso.rol || 'tu paso';
    await enviarMail({
      to,
      subject: `Aprobación pendiente: ${label}`,
      text: `Tenés una ${label} esperando tu aprobación (paso: ${etiqueta}). ${resumen || ''}\nIngresá al Portal de RR.HH. → Aprobaciones pendientes.`,
      html: `<p>Tenés una <b>${label}</b> esperando tu aprobación (paso: <b>${etiqueta}</b>).</p><p>${resumen || ''}</p><p>Ingresá al Portal de RR.HH. → <b>Aprobaciones pendientes</b>.</p>`,
    });
  } catch (e) { console.error('[notifAprob] aviso aprobador:', e.message); }
}

// Avisa al solicitante (empleado) el resultado + deja un mensaje interno.
export async function avisarSolicitante({ empleadoId, proceso, estado, resumen }) {
  const label = LABEL[proceso] || proceso;
  const titulo = `Tu ${label} fue ${estado}`;
  const cuerpo = `${titulo}. ${resumen || ''}`.trim();
  try { await query('INSERT INTO mensajes (empleado_id, titulo, cuerpo, autor) VALUES ($1,$2,$3,$4)', [empleadoId, titulo, cuerpo, 'sistema']); }
  catch (e) { console.error('[notifAprob] mensaje interno:', e.message); }
  try {
    if (!mailConfigurado()) return;
    const r = await query("SELECT email FROM empleados WHERE id=$1 AND email IS NOT NULL AND email<>''", [empleadoId]);
    const to = r.rows[0]?.email;
    if (!to) return;
    await enviarMail({ to, subject: titulo, text: cuerpo, html: `<p>${cuerpo}</p>` });
  } catch (e) { console.error('[notifAprob] aviso solicitante:', e.message); }
}
