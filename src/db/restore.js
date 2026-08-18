// Restauración asistida de un respaldo (node src/db/restore.js  o  npm run restore).
// Lista los respaldos disponibles, pide cuál restaurar, hace un respaldo de seguridad
// del estado actual y luego restaura con psql. OJO: restaurar REEMPLAZA los datos.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import os from 'node:os';
import { hacerBackup, descifrarBackup } from './backup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, '..', '..', 'backups');

function listar() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR)
    .filter((f) => /^portal_rrhh_.*\.sql(\.enc)?$/.test(f))
    .map((f) => ({ f, t: fs.statSync(path.join(BACKUP_DIR, f)).mtime }))
    .sort((a, b) => b.t - a.t);
}
const pregunta = (rl, q) => new Promise((r) => rl.question(q, r));

const backups = listar();
if (!backups.length) {
  console.error(`No hay respaldos en ${BACKUP_DIR}. Generá uno con "npm run backup".`);
  process.exit(1);
}
console.log(`\nRespaldos disponibles en ${BACKUP_DIR}:\n`);
backups.forEach((b, i) => console.log(`  [${i + 1}] ${b.f}   (${b.t.toLocaleString('es-AR')})`));

// Elegir por argumento (número o nombre) o interactivo.
let elegido = null;
const arg = process.argv[2];
if (arg) {
  if (/^\d+$/.test(arg)) elegido = backups[Number(arg) - 1];
  else elegido = backups.find((b) => b.f === arg);
}
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
try {
  if (!elegido) {
    const n = await pregunta(rl, '\n¿Qué respaldo restaurar? (número): ');
    elegido = backups[Number(n) - 1];
  }
  if (!elegido) { console.error('Opción inválida.'); process.exit(1); }

  console.log(`\n⚠ Vas a restaurar "${elegido.f}".`);
  console.log('  Esto REEMPLAZA los datos actuales de la base por los de ese respaldo.');
  const conf = await pregunta(rl, '  Para continuar, escribí SI en mayúsculas: ');
  if (conf.trim() !== 'SI') { console.log('Cancelado. No se modificó nada.'); process.exit(0); }

  console.log('\n1/2 · Respaldo de seguridad del estado actual…');
  const seg = await hacerBackup();
  if (seg.ok) console.log(`      ✓ guardado: ${seg.file}`);
  else console.log(`      ⚠ no se pudo respaldar antes (${seg.error}). ` );

  console.log('2/2 · Restaurando…');
  // Los respaldos cifrados (.sql.enc) se descifran a un temporal con permisos 0600
  // que se borra SIEMPRE — incluso si psql falla — para no dejar una copia en claro
  // de toda la base dando vueltas en el disco.
  let origen = path.join(BACKUP_DIR, elegido.f);
  let tmpDir = null;
  try {
    if (elegido.f.endsWith('.enc')) {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prh-restore-'));
      origen = path.join(tmpDir, 'dump.sql');
      descifrarBackup(path.join(BACKUP_DIR, elegido.f), origen);
    }
    execFileSync('psql', [config.databaseUrl, '-v', 'ON_ERROR_STOP=1', '-f', origen], { stdio: 'inherit' });
  } finally {
    if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ } }
  }
  console.log('\n✓ Restauración completada. Reiniciá el backend para tomar los datos restaurados.');
  process.exit(0);
} catch (e) {
  console.error('\n✗ Error en la restauración:', e.message, '\n  Verificá que "psql" esté instalado y en el PATH.');
  process.exit(1);
} finally { rl.close(); }
