// Respaldo automático de la base (pg_dump). Genera un archivo por corrida, con retención.
// Uso manual:  node src/db/backup.js     |    Programado: se dispara diariamente desde server.js.
//
// SEGURIDAD: el respaldo contiene TODA la base — remuneraciones, DNI, CUIL, CBU,
// certificados médicos, sanciones y los hashes de contraseña. Antes se escribía
// como .sql en texto plano con permisos por defecto: quien accediera al disco,
// a un volumen mal montado o a una copia del contenedor se llevaba el padrón
// completo sin necesidad de credenciales.
//
// Ahora:
//   - si hay BACKUP_PASSPHRASE, el dump se cifra con AES-256-GCM antes de tocar
//     el disco (nunca se escribe una versión en claro);
//   - el archivo y la carpeta quedan con permisos 0600 / 0700 (solo el dueño);
//   - sin passphrase, el respaldo se hace igual pero se avisa en el log.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, '..', '..', 'backups');
const RETENCION = Math.max(1, Number(process.env.BACKUP_RETENCION || 14)); // cuántos respaldos conservar
const PASSPHRASE = process.env.BACKUP_PASSPHRASE || '';
const dd = (n) => String(n).padStart(2, '0');

// Formato del archivo cifrado:  "PRHB1" | salt(16) | iv(12) | ciphertext | tag(16)
const MAGIC = Buffer.from('PRHB1');
const derivar = (pass, salt) => crypto.scryptSync(pass, salt, 32, { N: 16384, r: 8, p: 1 });

// Borra los respaldos más viejos, conservando los últimos RETENCION.
function podar() {
  try {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter((f) => /^portal_rrhh_.*\.(sql|sql\.enc)$/.test(f))
      .map((f) => ({ f, t: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const x of files.slice(RETENCION)) { try { fs.unlinkSync(path.join(BACKUP_DIR, x.f)); } catch { /* noop */ } }
    return files.length;
  } catch { return 0; }
}

/**
 * Crea un respaldo con pg_dump. No lanza: devuelve { ok, file?, cifrado?, error? }.
 * El dump viaja por stdout y se escribe a disco ya cifrado (si hay passphrase),
 * así el contenido en claro no queda nunca en el sistema de archivos.
 */
export async function hacerBackup() {
  let file = null;
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(BACKUP_DIR, 0o700); } catch { /* Windows no aplica modos POSIX */ }

    const n = new Date();
    const stamp = `${n.getFullYear()}-${dd(n.getMonth() + 1)}-${dd(n.getDate())}_${dd(n.getHours())}${dd(n.getMinutes())}`;
    const cifrado = !!PASSPHRASE;
    file = path.join(BACKUP_DIR, `portal_rrhh_${stamp}.sql${cifrado ? '.enc' : ''}`);

    // La cadena de conexión va por PGPASSWORD/URL en el entorno del hijo, no en
    // la línea de comandos: `ps` la mostraría a cualquier usuario de la máquina.
    const dump = spawn('pg_dump', ['--no-owner', '--no-privileges', '-d', config.databaseUrl], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    dump.stderr.on('data', (b) => { stderr += String(b).slice(0, 2000); });

    // Permisos restrictivos desde la creación del archivo (no después).
    const salida = fs.createWriteStream(file, { mode: 0o600 });

    if (cifrado) {
      const salt = crypto.randomBytes(16);
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', derivar(PASSPHRASE, salt), iv);
      salida.write(Buffer.concat([MAGIC, salt, iv]));
      await pipeline(dump.stdout, cipher, salida, { end: false });
      salida.end(cipher.getAuthTag());          // el tag GCM va al final
      await new Promise((r) => salida.on('close', r));
    } else {
      await pipeline(dump.stdout, salida);
    }

    const code = await new Promise((r) => dump.on('close', r));
    if (code !== 0) {
      try { fs.unlinkSync(file); } catch { /* noop */ }
      const msg = stderr.trim() || `pg_dump terminó con código ${code}`;
      console.error('[backup] pg_dump falló:', msg);
      return { ok: false, error: msg };
    }

    if (!cifrado) {
      console.warn('[backup] AVISO: el respaldo NO está cifrado. Definí BACKUP_PASSPHRASE para cifrarlo (contiene sueldos, DNI, CBU y datos de salud).');
    }
    podar();
    return { ok: true, file, dir: BACKUP_DIR, retencion: RETENCION, cifrado };
  } catch (e) {
    if (file) { try { fs.unlinkSync(file); } catch { /* noop */ } }
    return { ok: false, error: e.message };
  }
}

/** Descifra un respaldo .sql.enc a un archivo .sql (para restaurar). */
export function descifrarBackup(origen, destino, passphrase = PASSPHRASE) {
  if (!passphrase) throw new Error('Falta BACKUP_PASSPHRASE para descifrar el respaldo.');
  const buf = fs.readFileSync(origen);
  if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('El archivo no es un respaldo cifrado del portal.');
  const salt = buf.subarray(5, 21);
  const iv = buf.subarray(21, 33);
  const tag = buf.subarray(buf.length - 16);
  const datos = buf.subarray(33, buf.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', derivar(passphrase, salt), iv);
  decipher.setAuthTag(tag);
  // Si la passphrase es incorrecta o el archivo fue alterado, `final()` lanza.
  fs.writeFileSync(destino, Buffer.concat([decipher.update(datos), decipher.final()]), { mode: 0o600 });
  return destino;
}

// Ejecución directa (node src/db/backup.js)
if (import.meta.url === `file://${process.argv[1]}`) {
  hacerBackup().then((r) => {
    if (r.ok) {
      console.log(`✓ Respaldo creado: ${r.file}${r.cifrado ? ' (cifrado AES-256-GCM)' : ''}\n  Carpeta: ${r.dir} (se conservan los últimos ${r.retencion}).`);
      process.exit(0);
    }
    console.error(`✗ No se pudo crear el respaldo: ${r.error}\n  Verificá que 'pg_dump' esté instalado y en el PATH.`); process.exit(1);
  });
}
