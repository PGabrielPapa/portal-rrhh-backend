// Diagnóstico: imprime los TURNOS de Pro-Soft (para ver las horas de cada turno)
// y una muestra de legajos con su idturno. Correr dentro del contenedor:
//   docker compose exec api node src/scripts/prosoft-turnos.js
import { getFiltros, prosoftConfigOk } from '../lib/prosoft.js';

try {
  if (!prosoftConfigOk()) {
    console.error('Falta configurar PROSOFT_USER / PROSOFT_PASS en el .env del backend.');
    process.exit(1);
  }
  const f = await getFiltros();
  console.log('=== CLAVES QUE DEVUELVE /filtros ===');
  console.log(Object.keys(f || {}));
  console.log('\n=== TURNOS (con sus campos/horas) ===');
  console.log(JSON.stringify(f.turnos || f.Turnos || [], null, 2));
  console.log('\n=== MUESTRA DE 5 LEGAJOS (para ver idturno) ===');
  console.log(JSON.stringify((f.legajos || f.Legajos || []).slice(0, 5), null, 2));
} catch (e) {
  console.error('ERROR:', e.message);
} finally {
  process.exit(0);
}
