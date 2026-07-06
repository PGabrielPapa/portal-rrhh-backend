// Validación y saneo de adjuntos subidos como base64 (comprobantes de licencias,
// notificaciones de sanciones, etc.). Objetivo: limitar tamaño, restringir a
// formatos seguros y evitar XSS almacenado al servir el archivo.

const MIMES_OK = new Set([
  'application/pdf',
  'image/jpeg', 'image/png', 'image/webp',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);
const EXT_OK = /\.(pdf|jpe?g|png|webp|docx?|xlsx?)$/i;

// Tamaño real en bytes de un contenido base64.
export function tamBase64(data) {
  const s = String(data || '').replace(/\s/g, '');
  if (!s) return 0;
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  return Math.floor(s.length * 3 / 4) - pad;
}

// Valida un adjunto. Devuelve { ok: true, bytes } o { ok: false, error }.
export function validarAdjunto({ nombre, mime, data }, { maxMB = 10 } = {}) {
  if (!data) return { ok: false, error: 'Adjuntá un archivo.' };
  const bytes = tamBase64(data);
  if (bytes <= 0) return { ok: false, error: 'El archivo está vacío.' };
  if (bytes > maxMB * 1024 * 1024) return { ok: false, error: `El archivo supera el máximo de ${maxMB} MB.` };
  const m = String(mime || '').toLowerCase();
  const okMime = MIMES_OK.has(m);
  const okExt = EXT_OK.test(String(nombre || ''));
  if (!okMime && !okExt) return { ok: false, error: 'Formato no permitido. Subí PDF, imagen (JPG/PNG/WebP) o documento de Office (Word/Excel).' };
  return { ok: true, bytes };
}

// MIME seguro para servir: si no está en la allowlist, se degrada a binario
// (evita que un HTML/SVG malicioso se ejecute en el dominio del backend).
export function mimeSeguro(mime) {
  const m = String(mime || '').toLowerCase();
  return MIMES_OK.has(m) ? m : 'application/octet-stream';
}
