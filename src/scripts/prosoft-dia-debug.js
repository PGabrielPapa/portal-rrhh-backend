// Diagnóstico del día: cómo devuelve Pro-Soft las marcas de HOY, en especial los
// que NO tienen entrada (para clasificar bien ausentes/franco/licencia).
//   docker compose exec api node src/scripts/prosoft-dia-debug.js
import { getResumen, prosoftConfigOk } from '../lib/prosoft.js';

const hoy = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
const tieneEntrada = (d) => ['e1', 'e2', 'e3', 'e4'].some((k) => String(d[k] || '').trim());

try {
  if (!prosoftConfigOk()) { console.error('Falta configurar PROSOFT_USER/PROSOFT_PASS.'); process.exit(1); }
  const datos = await getResumen(hoy, hoy);
  console.log('Fecha:', hoy, '· filas devueltas:', datos.length);

  const est = {};
  for (const d of datos) { const e = String(d.estado || '(vacío)'); est[e] = (est[e] || 0) + 1; }
  console.log('\n=== ESTADOS (valor → cantidad) ===');
  console.log(est);

  const sinEntrada = datos.filter((d) => !tieneEntrada(d));
  console.log('\n=== SIN ENTRADA: ', sinEntrada.length, ' (muestra de 15) ===');
  console.log(JSON.stringify(sinEntrada.slice(0, 15).map((d) => ({
    legajo: d.legajo, nombre: d.nombre, dia: d.dia, hs_normal: d.hs_normal,
    estado: d.estado, comentario: d.comentario,
  })), null, 2));
} catch (e) {
  console.error('ERROR:', e.message);
} finally {
  process.exit(0);
}
