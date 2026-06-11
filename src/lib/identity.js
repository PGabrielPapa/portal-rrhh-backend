// Identidad de empleado: el legajo NO es único global, puede repetirse entre
// empresas. La identidad única es empresa+legajo. Helpers compartidos.

export function empSlug(nombreEmpresa) {
  return String(nombreEmpresa || '').toUpperCase().replace(/[^A-Z0-9]/g, '') || 'SINEMP';
}

// uid único y estable para un empleado (slug de empresa + número de legajo).
export function makeUid(nombreEmpresa, legNum) {
  return empSlug(nombreEmpresa) + '-' + String(legNum == null ? '' : legNum).trim();
}

// Normaliza un CUIL a XX-XXXXXXXX-X y deriva el DNI (8 dígitos centrales).
export function dniFromCuil(cuil) {
  const d = String(cuil || '').replace(/\D/g, '');
  if (d.length >= 11) return String(parseInt(d.slice(2, 10), 10) || '');
  return '';
}
