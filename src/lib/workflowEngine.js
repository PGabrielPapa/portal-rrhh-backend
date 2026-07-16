// Motor de workflows de aprobación multinivel (funciones puras y testeables).
// Un "paso" puede exigir un ROL (manager/rrhh/admin) o un PUESTO específico
// (paso.puesto = puesto_id). Las aprobaciones son [{orden, decision}] con
// decision 'aprobado' | 'rechazado'. Los estados devueltos son canónicos
// ('pendiente' | 'aprobado' | 'rechazado'); cada circuito los mapea a los suyos.

export function ordenarPasos(pasos) {
  return Array.isArray(pasos) ? pasos.slice().sort((a, b) => (a.orden || 0) - (b.orden || 0)) : [];
}

// Órdenes ya aprobados (los rechazos no cuentan como "resuelto favorable").
function aprobados(aprobaciones) {
  return new Set((aprobaciones || []).filter((a) => a.decision === 'aprobado').map((a) => a.orden));
}

// Próximo paso sin aprobar (o null si ya están todos).
export function pasoActual(pasos, aprobaciones) {
  const ok = aprobados(aprobaciones);
  return ordenarPasos(pasos).find((p) => !ok.has(p.orden)) || null;
}

// ¿Puede el usuario resolver este paso? opts.enEquipo indica si el empleado del
// trámite está en el equipo efectivo del usuario (para pasos de rol 'manager').
export function puedeResolver(paso, user, opts = {}) {
  if (!paso || !user) return false;
  if (user.role === 'admin') return true;                 // admin: superusuario
  if (paso.puesto) return Number(user.puestoId) === Number(paso.puesto);
  if (paso.rol && paso.rol === user.role) {
    if (user.role === 'manager') return !!opts.enEquipo;
    return true;
  }
  return false;
}

// Etiqueta legible del rol/puesto que resuelve un paso (para mensajes).
export function etiquetaPaso(paso) {
  return (paso && (paso.etiqueta || (paso.puesto ? `puesto #${paso.puesto}` : paso.rol))) || '';
}

// Resultado tras registrar una decisión en `paso`. Devuelve el estado canónico
// resultante y, si sigue pendiente, el próximo paso obligatorio.
export function resultadoDecision(pasos, aprobaciones, paso, decision) {
  if (decision === 'rechazado') return { estado: 'rechazado' };
  const ok = new Set([...aprobados(aprobaciones), paso.orden]);
  const pendiente = ordenarPasos(pasos).find((p) => (p.obligatorio !== false) && !ok.has(p.orden));
  return pendiente ? { estado: 'pendiente', siguiente: pendiente } : { estado: 'aprobado' };
}
