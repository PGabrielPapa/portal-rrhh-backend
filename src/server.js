import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { config } from './config.js';
import { pool } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Guardas globales: una excepción no atrapada NO debe tumbar todo el backend
// (si el proceso muere, el proxy del frontend recibe ECONNRESET y falla el login).
// Registramos el error y seguimos sirviendo; así queda visible la causa real.
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL capturado] promesa sin manejar:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[FATAL capturado] excepción no atrapada:', err);
});

// Aplica el esquema (idempotente) en cada arranque, así un cambio de schema
// se refleja también con la recarga del modo dev (node --watch).
try {
  const schema = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8');
  const { aplicarSchema } = await import('./db/applySchema.js');
  const r = await aplicarSchema(pool, schema);
  if (r.errores.length) {
    console.error(`[boot] esquema aplicado con ${r.errores.length} sentencia(s) con error (de ${r.total}):`);
    r.errores.forEach((e, n) => {
      console.error(`  ✗ (${n + 1}) ERROR: ${e.error}`);
      console.error(`       SENTENCIA: ${e.sql}…`);
    });
  } else {
    console.log(`[boot] esquema verificado ✓ (${r.total} sentencias)`);
  }
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

// Escala de jornal UOCRA (valor hora + SNR por categoría/zona/vigencia): siembra inicial.
try {
  const { migrarUocraEscala } = await import('./db/migrateUocraEscala.js');
  const r = await migrarUocraEscala();
  if (!r.skip && r.creadas) console.log(`[boot] escala UOCRA sembrada ✓ (${r.creadas} filas)`);
} catch (e) {
  console.error('[boot] migración escala UOCRA:', e.message);
}

// Escala IDEE (UECARA / fuera de convenio) — roles BIM con niveles. Siembra el convenio 'IDEE-BIM'.
try {
  const { migrarIdeeBim } = await import('./db/migrateIdeeBim.js');
  const r = await migrarIdeeBim();
  if (!r.skip) console.log(`[boot] escala IDEE-BIM sembrada ✓ (${r.cats} categorías)`);
} catch (e) {
  console.error('[boot] migración IDEE-BIM:', e.message);
}

// Escala unificada de Grupo LEITEN (LEITEN/SINIS/BARTON): siembra el convenio 'ESCALA-UNIF'.
try {
  const { migrarEscalaUnif } = await import('./db/migrateEscalaUnif.js');
  const r = await migrarEscalaUnif();
  if (!r.skip) console.log(`[boot] escala unificada sembrada ✓ (${r.cats} categorías)`);
} catch (e) {
  console.error('[boot] migración escala unificada:', e.message);
}

// Presentismo por convenio (Comercio 8,33%, UOM/Plásticos 10%...) + flag de antig./pres. sobre el No Rem.
try {
  const { migrarPresentismoSind } = await import('./db/migratePresentismoSind.js');
  const r = await migrarPresentismoSind();
  if (!r.skip) console.log(`[boot] presentismo por convenio verificado ✓ (${r.tocadas} sindicatos)`);
} catch (e) {
  console.error('[boot] migración presentismo/convenio:', e.message);
}

// Causales de baja: tabla oficial de ARCA (motivos de egreso). Siembra las que falten.
try {
  const { migrarCausalesBaja } = await import('./db/migrateCausalesBaja.js');
  const r = await migrarCausalesBaja();
  if (r.creadas) console.log(`[boot] causales de baja sembradas ✓ (${r.creadas} nuevas de ${r.total})`);
} catch (e) {
  console.error('[boot] migración causales de baja:', e.message);
}

// Migración a conceptos ejecutables por fórmula (proyecto por fases). Fase 1: SAC.
try {
  const { migrarConceptosFormula } = await import('./db/migrateConceptosFormula.js');
  const r = await migrarConceptosFormula();
  if (!r.skip) console.log(`[boot] conceptos por fórmula verificados ✓ (${r.tocados})`);
} catch (e) {
  console.error('[boot] migración conceptos por fórmula:', e.message);
}

// Producción: valor hora ahora es POR EMPLEADO. Migra la tabla si quedó con el esquema viejo (por categoría).
try {
  const { migrarProdValorHora } = await import('./db/migrateProdValorHora.js');
  const r = await migrarProdValorHora();
  if (!r.skip) console.log('[boot] prod_valor_hora migrada a esquema por empleado ✓');
} catch (e) {
  console.error('[boot] migración prod_valor_hora:', e.message);
}

// Actualización automática de valores legales (tope SIPA, SMVM, SCVO, FFEP) según el calendario publicado.
try {
  const { autoActualizarValores } = await import('./routes/valoresLegales.routes.js');
  const r = await autoActualizarValores();
  console.log(`[boot] valores legales actualizados ✓ (${r.creadas} nuevos, ${r.actualizadas} actualizados)`);
} catch (e) {
  console.error('[boot] valores legales:', e.message);
}

// Tablas de Ganancias (RG 4003): consulta/actualiza sola la del semestre en curso (oficial o provisoria).
try {
  const { autoActualizarGanancias } = await import('./lib/gananciasParams.js');
  const r = await autoActualizarGanancias();
  console.log(`[boot] tablas de Ganancias verificadas ✓ (${r.estado})`);
} catch (e) {
  console.error('[boot] Ganancias auto:', e.message);
}

// Diseño de registro SICORE/SIRE (retenciones de Ganancias 4ª): verifica/adopta el vigente.
try {
  const { autoActualizarSicoreDiseno } = await import('./lib/sicore.js');
  const r = await autoActualizarSicoreDiseno();
  console.log(`[boot] diseño SICORE/SIRE verificado ✓ (v${r.version} ${r.modo}${r.cambiada ? ' — actualizado' : ''})`);
} catch (e) {
  console.error('[boot] SICORE diseño:', e.message);
}

// Escala salarial unificada (convenios/sindicatos): verifica/adopta la vigente del mes en curso.
try {
  const { verificacionMensualEscalas } = await import('./lib/escalasAuto.js');
  const r = await verificacionMensualEscalas();
  console.log(`[boot] escala salarial verificada \u2713 (${r.escala ? ('vigente ' + (r.escala.mesLabel || r.escala.vigencia)) : 'sin escala cargada'}${r.adoptada ? ' \u2014 adoptada' : ''}).`);
} catch (e) {
  console.error('[boot] escala salarial:', e.message);
}

const app = createApp();
const server = app.listen(config.port, () => {
  console.log(`[api] Portal RR.HH. escuchando en :${config.port}`);
  programarProsoftDiario();
  programarValoresLegalesDiario();
  programarBackupDiario();
});

// Actualización automática diaria de valores legales (SMVM, topes SIPA, SCVO, FFEP)
// desde el calendario oficial, sin intervención manual. Corre una vez por día.
function programarValoresLegalesDiario() {
  const correr = async () => {
    try {
      const { autoActualizarValores } = await import('./routes/valoresLegales.routes.js');
      const r = await autoActualizarValores();
      console.log(`[valores-legales] actualización diaria OK (${r.creadas} nuevos, ${r.actualizadas} actualizados).`);
      try { const { autoActualizarGanancias } = await import('./lib/gananciasParams.js'); const g = await autoActualizarGanancias(); console.log(`[ganancias] verificación diaria OK (${g.estado}).`); } catch (e) { console.error('[ganancias] verificación diaria:', e.message); }
      try { const { autoActualizarSicoreDiseno } = await import('./lib/sicore.js'); const sc = await autoActualizarSicoreDiseno(); if (sc.cambiada) console.log(`[sicore] diseño actualizado a v${sc.version} (${sc.modo}).`); } catch (e) { console.error('[sicore] verificación diaria:', e.message); }
      try { const { verificacionMensualEscalas } = await import('./lib/escalasAuto.js'); const es = await verificacionMensualEscalas(); if (es.adoptada) console.log(`[escala] escala unificada adoptada para ${es.periodo} (${es.escala && (es.escala.mesLabel || es.escala.vigencia)}).`); } catch (e) { console.error('[escala] verificación:', e.message); }
      try { const { enviarRecordatoriosAprobaciones } = await import('./lib/recordatoriosAprob.js'); const rc = await enviarRecordatoriosAprobaciones(); if (rc.enviados) console.log(`[recordatorios] ${rc.enviados} aviso(s) de aprobación pendiente (> ${rc.dias} días).`); } catch (e) { console.error('[recordatorios] aprobaciones:', e.message); }
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

// Respaldo automático diario de la base (pg_dump) a la hora configurada (BACKUP_HORA, def. 3).
// Poné BACKUP_AUTO=false para desactivarlo. Se conservan los últimos BACKUP_RETENCION respaldos.
function programarBackupDiario() {
  if (String(process.env.BACKUP_AUTO || 'true') === 'false') { console.log('[backup] respaldo automático desactivado (BACKUP_AUTO=false).'); return; }
  const hora = Math.min(23, Math.max(0, Number(process.env.BACKUP_HORA || 3)));
  const correr = async () => {
    try {
      const { hacerBackup } = await import('./db/backup.js');
      const r = await hacerBackup();
      if (r.ok) console.log(`[backup] respaldo diario OK: ${r.file}`);
      else console.error(`[backup] respaldo diario falló: ${r.error} (¿pg_dump en el PATH?)`);
    } catch (e) { console.error('[backup] respaldo diario:', e.message); }
  };
  const msHastaHora = () => {
    const now = new Date();
    const next = new Date(now);
    next.setHours(hora, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next - now;
  };
  setTimeout(function run() { correr(); setInterval(correr, 24 * 3600 * 1000); }, msHastaHora());
  console.log(`[backup] respaldo automático diario activado (~${hora}:00, retención ${process.env.BACKUP_RETENCION || 14}).`);
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`\n[api] ${sig} recibido, cerrando…`);
    server.close(() => {
      pool.end().then(() => process.exit(0)).catch(() => process.exit(0));
    });
    // Si el cierre se demora, forzar salida a los 5s.
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
