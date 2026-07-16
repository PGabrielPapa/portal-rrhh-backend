// Parte un nombre cargado como "APELLIDO, NOMBRE" en sus dos partes.
// Respeta apellidos compuestos (corta en la PRIMERA coma). Si no hay coma,
// devuelve todo como apellido y nombre vacío.
export function partirNombre(nombreCompleto) {
  const s = String(nombreCompleto ?? '').trim();
  const i = s.indexOf(',');
  if (i < 0) return { apellido: s, nombre: '' };
  return { apellido: s.slice(0, i).trim(), nombre: s.slice(i + 1).trim() };
}
