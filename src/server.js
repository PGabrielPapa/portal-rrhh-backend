import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { config } from './config.js';
import { pool } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Aplica el esquema (idempotente) en cada arranque, así un cambio de schema
// se refleja también con la recarga del modo dev (node --watch).
try {
  const schema = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8');
  await pool.query(schema);
  console.log('[boot] esquema verificado ✓');
} catch (e) {
  console.error('[boot] error aplicando el esquema:', e.message);
}

// Claves foráneas faltantes (auditoría #6): limpia huérfanos y agrega las FKs (idempotente).
try {
  const { migrarFKs } = await import('./db/migrateFKs.js');
  const r = await migrarFKs();
  if (r.agregadas) console.log(`[boot] claves foráneas agregadas ✓ (${r.agregadas})`);
} catch (e) {
  console.error('[boot] migración de FKs:', e.message);
}

// Correlativo de recibos: permite 2+ liquidaciones del mismo tipo por período (idempotente).
try {
  const { migrarRecibosCorrelativo } = await import('./db/migrateRecibosCorrelativo.js');
  const r = await migrarRecibosCorrelativo();
  if (r.cambiado) console.log('[boot] índice de recibos actualizado (correlativo) ✓');
} catch (e) {
  console.error('[boot] migración correlativo:', e.message);
}

// Organigrama por puesto: siembra inicial de la tabla `puestos` desde el
// organigrama vigente (idempotente; no hace nada si ya hay puestos cargados).
try {
  const { migrarPuestos } = await import('./db/migratePuestos.js');
  const r = await migrarPuestos();
  if (!r.skip) console.log(`[boot] puestos sembrados desde el organigrama ✓ (${r.creados} puestos)`);
} catch (e) {
  console.error('[boot] migración de puestos:', e.message);
}

// Actualización automática de valores legales (tope SIPA, SMVM, SCVO, FFEP) según el calendario publicado.
try {
  const { autoActualizarValores } = await import('./routes/valoresLegales.routes.js');
  const r = await autoActualizarValores();
  console.log(`[boot] valores legales actualizados ✓ (${r.creadas} nuevos, ${r.actualizadas} actualizados)`);
} catch (e) {
  console.error('[boot] valores legales:', e.message);
}

const app = createApp();
const server = app.listen(config.port, () => {
  console.log(`[api] Portal RR.HH. escuchando en :${config.port}`);
  programarProsoftDiario();
  programarValoresLegalesDiario();
});

// Actualización automática diaria de valores legales (SMVM, topes SIPA, SCVO, FFEP)
// desde el calendario oficial, sin intervención manual. Corre una vez por día.
function programarValoresLegalesDiario() {
  const correr = async () => {
    try {
      const { autoActualizarValores } = await import('./routes/valoresLegales.routes.js');
      const r = await autoActualizarValores();
      console.log(`[valores-legales] actualización diaria OK (${r.creadas} nuevos, ${r.actualizadas} actualizados).`);
    } catch (e) {
      console.error('[valores-legales] actualización diaria falló:', e.message);
    }
  };
  setInterval(correr, 24 * 3600 * 1000);
  console.log('[valores-legales] actualización automática diaria activada.');
}

// Importación automática diaria desde Pro-Soft (si PROSOFT_AUTO=true).
// Trae el mes en curso sin pisar los períodos ya aprobados (soloPendientes).
function programarProsoftDiario() {
  if (!config.prosoft.auto) return;
  const correr = async () => {
    try {
      const { importarMes } = await import('./lib/prosoft.js');
      const now = new Date();
      const r = await importarMes(now.getFullYear(), now.getMonth() + 1, { confirmar: true, soloPendientes: true, importadoPor: 'auto-prosoft' });
      console.log(`[prosoft] importación diaria OK — ${r.resumen.matcheados} empleados (${now.getMonth() + 1}/${now.getFullYear()}).`);
    } catch (e) {
      console.error('[prosoft] importación diaria falló:', e.message);
    }
  };
  const msHastaHora = () => {
    const now = new Date();
    const next = new Date(now);
    next.setHours(config.prosoft.autoHora, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next - now;
  };
  setTimeout(function run() { correr(); setInterval(correr, 24 * 3600 * 1000); }, msHastaHora());
  console.log(`[prosoft] importación automática diaria activada (~${config.prosoft.autoHora}:00).`);
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`\n[api] ${sig} recibido, cerrando…`);
    server.close(() => pool.end().then(() => process.exit(0)));
  });
}
