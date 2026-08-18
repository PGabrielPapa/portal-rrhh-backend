// Tests de las defensas agregadas en la auditoría de seguridad (08/2026).
// No requieren base de datos: prueban las piezas puras (política de contraseñas,
// TOTP, escape de adjuntos y arranque seguro de config). Incluye la politica de
// contrasenas estricta, que quedo implementada pero APAGADA por decision de negocio.
import assert from 'node:assert';
import crypto from 'node:crypto';
import { validarPassword, validarPasswordSegunConfig, generarPasswordTemporal, PWD_MIN } from '../src/lib/password.js';
import { generarSecret, verificarToken } from '../src/lib/totp.js';
import { validarAdjunto, mimeSeguro } from '../src/lib/adjuntos.js';

let ok = 0, fail = 0;
function test(nombre, fn) {
  try { fn(); console.log(`  ✓ ${nombre}`); ok++; }
  catch (e) { console.log(`  ✗ ${nombre}\n      ${e.message}`); fail++; }
}

const USUARIO = { dni: '30123456', cuil: '20301234567', nom: 'PEREZ, JUAN', email: 'jperez@leiten.com.ar', legNum: '000123' };

console.log('\nPolítica de contraseñas');

test('rechaza contraseñas cortas', () => {
  assert.equal(validarPassword('Ab3!x', USUARIO).ok, false);
  assert.equal(validarPassword('A'.repeat(PWD_MIN - 1) + '1', USUARIO).ok, false);
});

test('rechaza el DNI como contraseña (que es el default del blanqueo)', () => {
  assert.equal(validarPassword('30123456', USUARIO).ok, false);
  assert.equal(validarPassword('Clave30123456!', USUARIO).ok, false);
});

test('rechaza contraseñas que contienen el nombre, el legajo o el mail', () => {
  assert.equal(validarPassword('Perez.Segura9!', USUARIO).ok, false);
  assert.equal(validarPassword('Xy000123-Abc!', USUARIO).ok, false);
  assert.equal(validarPassword('Jperez-2026-Ok!', USUARIO).ok, false);
});

test('rechaza contraseñas comunes y secuencias', () => {
  for (const p of ['Password123', 'Qwertyuiop1', 'ABCDEFGHIJ', '1234567890', 'aaaaaaaaaaaa']) {
    assert.equal(validarPassword(p, USUARIO).ok, false, `debería rechazar ${p}`);
  }
});

test('exige combinar al menos tres familias de caracteres', () => {
  assert.equal(validarPassword('solominusculas', USUARIO).ok, false);
  assert.equal(validarPassword('SOLOMAYUSCULAS', USUARIO).ok, false);
  assert.equal(validarPassword('MayusMinus99', USUARIO).ok, true);   // 3 familias
});

test('acepta una contraseña razonable', () => {
  const r = validarPassword('Vaquita-Marzo-77', USUARIO);
  assert.equal(r.ok, true, r.error);
});

test('la contraseña temporal es fuerte y distinta en cada llamada', () => {
  const generadas = new Set();
  for (let i = 0; i < 50; i++) {
    const p = generarPasswordTemporal();
    assert.ok(p.length >= 14, 'debe tener al menos 14 caracteres');
    assert.equal(validarPassword(p, USUARIO).ok, true, `la temporal ${p} no pasa la propia política`);
    generadas.add(p);
  }
  assert.equal(generadas.size, 50, 'no debe repetir contraseñas temporales');
});

test('con la politica estricta APAGADA rige la regla anterior (min 6, distinta del DNI)', () => {
  const off = { politicaEstricta: false, minSimple: 6 };
  // Lo que la regla anterior si rechaza:
  assert.equal(validarPasswordSegunConfig('abc', USUARIO, off).ok, false, 'menos de 6 caracteres');
  assert.equal(validarPasswordSegunConfig(USUARIO.dni, USUARIO, off).ok, false, 'igual al DNI');
  // Lo que la regla anterior acepta y la estricta rechazaria. Queda fijado como
  // consecuencia asumida de no desplegar la politica estricta.
  for (const p of ['123456', 'abcdef', 'Password123']) {
    assert.equal(validarPasswordSegunConfig(p, USUARIO, off).ok, true, `la regla simple acepta ${p}`);
    assert.equal(validarPassword(p, USUARIO).ok, false, `la estricta rechazaria ${p}`);
  }
});

console.log('\n2FA (TOTP)');

// Recalcula el código esperado para un paso dado (misma construcción que lib/totp.js).
function codigo(secret, counter) {
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of String(secret).toUpperCase()) { const i = B32.indexOf(c); if (i >= 0) bits += i.toString(2).padStart(5, '0'); }
  const bytes = []; for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', Buffer.from(bytes)).update(buf).digest();
  const off = h[h.length - 1] & 0x0f;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 1_000_000).padStart(6, '0');
}

test('acepta el código vigente', () => {
  const s = generarSecret();
  const step = Math.floor(Date.now() / 1000 / 30);
  assert.equal(verificarToken(s, codigo(s, step)), true);
});

// El antirreplay de TOTP (impedir reutilizar un código ya consumido) NO se desplegó:
// se decidió no tocar el flujo de 2FA. La columna `totp_last_step` quedó creada en el
// esquema, así que activarlo es volver a pasar el último paso usado a verificarToken.
// Mientras esté fuera, un código sí se puede reutilizar dentro de su ventana de 90 s.

test('tolera el desfase de reloj de ±1 paso', () => {
  const s = generarSecret();
  const step = Math.floor(Date.now() / 1000 / 30);
  assert.equal(verificarToken(s, codigo(s, step - 1)), true);
  assert.equal(verificarToken(s, codigo(s, step + 1)), true);
  assert.equal(verificarToken(s, codigo(s, step + 5)), false);
});

test('rechaza códigos mal formados sin romper', () => {
  const s = generarSecret();
  for (const t of ['', null, undefined, '123', '12345678', 'abcdef', {}, []]) {
    assert.equal(verificarToken(s, t), false);
  }
});

console.log('\nAdjuntos');

test('rechaza formatos peligrosos y acepta los permitidos', () => {
  const data = Buffer.from('x'.repeat(100)).toString('base64');
  assert.equal(validarAdjunto({ nombre: 'a.pdf', mime: 'application/pdf', data }).ok, true);
  assert.equal(validarAdjunto({ nombre: 'x.svg', mime: 'image/svg+xml', data }).ok, false);
  assert.equal(validarAdjunto({ nombre: 'x.html', mime: 'text/html', data }).ok, false);
});

test('sirve como binario cualquier MIME fuera de la lista (evita XSS almacenado)', () => {
  assert.equal(mimeSeguro('text/html'), 'application/octet-stream');
  assert.equal(mimeSeguro('image/svg+xml'), 'application/octet-stream');
  assert.equal(mimeSeguro('application/pdf'), 'application/pdf');
});

console.log('\nArranque seguro (config)');

// Se importa config.js en procesos hijos porque valida al importarse.
import { execFileSync } from 'node:child_process';
function arranca(env) {
  try {
    execFileSync(process.execPath, ['-e', "import('./src/config.js').then(()=>process.exit(0)).catch(()=>process.exit(1))"],
      { env: { ...process.env, ...env }, stdio: 'ignore' });
    return true;
  } catch { return false; }
}
const SECRETO_OK = crypto.randomBytes(32).toString('hex');
const DB_OK = 'postgres://portal:Cl4veFuerte-2026@db:5432/portal_rrhh';

test('en producción NO arranca con un secreto JWT débil', () => {
  assert.equal(arranca({ NODE_ENV: 'production', JWT_SECRET: 'cambiar-en-produccion', DATABASE_URL: DB_OK, CORS_ORIGIN: 'https://x.com' }), false);
});

test('en producción NO arranca con CORS_ORIGIN="*"', () => {
  assert.equal(arranca({ NODE_ENV: 'production', JWT_SECRET: SECRETO_OK, DATABASE_URL: DB_OK, CORS_ORIGIN: '*' }), false);
});

test('en producción NO arranca con la contraseña de Postgres por defecto', () => {
  assert.equal(arranca({ NODE_ENV: 'production', JWT_SECRET: SECRETO_OK, DATABASE_URL: 'postgres://portal:portal@db:5432/x', CORS_ORIGIN: 'https://x.com' }), false);
});

test('en producción SÍ arranca con una configuración correcta', () => {
  assert.equal(arranca({ NODE_ENV: 'production', JWT_SECRET: SECRETO_OK, DATABASE_URL: DB_OK, CORS_ORIGIN: 'https://rrhh.leiten.com.ar' }), true);
});

console.log(`\nRESULTADO seguridad: ${ok} OK, ${fail} fallidos`);
if (fail) process.exit(1);
