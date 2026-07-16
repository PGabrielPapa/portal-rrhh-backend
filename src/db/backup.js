// Respaldo automático de la base (pg_dump). Genera un .sql por corrida, con retención.
// Uso manual:  node src/db/backup.js     |    Programado: se dispara diariamente desde server.js.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, '..', '..', 'backups');
const RETENCION = Math.max(1, Number(process.env.BACKUP_RETENCION || 14)); // cuántos respaldos conservar
const dd = (n) => String(n).padStart(2, '0');

// Borra los respaldos más viejos, conservando los últimos RETENCION.
function podar() {
  try {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter((f) => /^portal_rrhh_.*\.sql$/.test(f))
      .map((f) => ({ f, t: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const x of files.slice(RETENCION)) { try { fs.unlinkSync(path.join(BACKUP_DIR, x.f)); } catch { /* noop */ } }
    return files.length;
  } catch { return 0; }
}

// Crea un respaldo con pg_dump. No lanza: devuelve { ok, file? , error? }.
export function hacerBackup() {
  return new Promise((resolve) => {
    try {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
      const n = new Date();
      const stamp = `${n.getFullYear()}-${dd(n.getMonth() + 1)}-${dd(n.getDate())}_${dd(n.getHours())}${dd(n.getMinutes())}`;
      const file = path.join(BACKUP_DIR, `portal_rrhh_${stamp}.sql`);
      // pg_dump acepta la connection string como argumento de base de datos.
      execFile('pg_dump', [config.databaseUrl, '--no-owner', '--no-privileges', '-f', file],
        { maxBuffer: 1024 * 1024 * 1024 }, (err) => {
          if (err) { console.error('[backup] pg_dump falló:', err.message); return resolve({ ok: false, error: err.message }); }
          podar();
          resolve({ ok: true, file, dir: BACKUP_DIR, retencion: RETENCION });
        });
    } catch (e) { resolve({ ok: false, error: e.message }); }
  });
}

// Ejecución directa (node src/db/backup.js)
if (import.meta.url === `file://${process.argv[1]}`) {
  hacerBackup().then((r) => {
    if (r.ok) { console.log(`✓ Respaldo creado: ${r.file}\n  Carpeta: ${r.dir} (se conservan los últimos ${r.retencion}).`); process.exit(0); }
    console.error(`✗ No se pudo crear el respaldo: ${r.error}\n  Verificá que 'pg_dump' esté instalado y en el PATH.`); process.exit(1);
  });
}
