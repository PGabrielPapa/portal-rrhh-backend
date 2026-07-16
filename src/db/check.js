// Chequeo de salud integral del backend (node src/db/check.js o npm run check).
// Verifica: sintaxis de todos los .js, importación de la app y los tests del motor.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..', '..');
const srcDir = path.join(root, 'src');
let fallos = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { console.error('  ✗ ' + m); fallos++; };

function listar(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listar(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

console.log('\n== Chequeo de salud del backend ==');

// 1) Sintaxis de todos los .js
const files = listar(srcDir);
let syntaxErr = 0;
for (const f of files) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); }
  catch (e) { bad('sintaxis: ' + path.relative(root, f) + '\n     ' + String(e.stderr || e).split('\n')[0]); syntaxErr++; }
}
if (!syntaxErr) ok(`sintaxis OK en ${files.length} archivos`);

// 2) Importación de la app
try { await import(path.join(srcDir, 'app.js')); ok('la app importa sin errores'); }
catch (e) { bad('la app NO importa: ' + e.message); }

// 3) Tests del motor
try { execFileSync('npm', ['test', '--silent'], { cwd: root, stdio: 'pipe' }); ok('tests del motor: todos pasan'); }
catch (e) { bad('tests con fallas:\n' + String(e.stdout || e.stderr || e).split('\n').slice(-8).join('\n')); }

console.log(fallos ? `\n✗ Chequeo con ${fallos} problema(s). Revisalos antes de deployar.\n` : '\n✓ Todo sano. Backend listo.\n');
process.exit(fallos ? 1 : 0);
