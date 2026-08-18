// Prueba de integración en vivo: levanta la app real en un puerto libre y ejercita
// el flujo de autenticación completo contra la base de Docker.
// Uso: node test/seguridad-live.mjs   (requiere Postgres accesible)   (borra su propio usuario de prueba al terminar)
// El limitador por IP se prueba en su propio bloque; para el resto se sube el
// techo, si no el propio test se autobloquea tras 15 intentos y los demás casos
// no llegan a ejecutarse.
process.env.RATE_LOGIN = process.env.RATE_LOGIN || '10000';
process.env.RATE_GENERAL = process.env.RATE_GENERAL || '10000';

import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app.js';
import { query, pool } from '../src/db.js';
import { config } from '../src/config.js';
import { olvidarSesion } from '../src/lib/sesion.js';

const app = createApp();
const srv = app.listen(4555);
const B = 'http://127.0.0.1:4555/api';

async function j(m, p, body, tok) {
  const r = await fetch(B + p, {
    method: m,
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) },
    body: body !== undefined && body !== null ? JSON.stringify(body) : undefined,
  });
  let d = {};
  try { d = await r.json(); } catch { /* respuesta sin cuerpo */ }
  return { s: r.status, d };
}

let ok = 0, fail = 0;
const t = (n, cond, extra) => {
  if (cond) { console.log('  ✓ ' + n); ok++; }
  else { console.log('  ✗ ' + n + (extra ? '  -> ' + extra : '')); fail++; }
};

const DNI = '99000111';
const PWD = 'Vaquita-Marzo-77';
await query('DELETE FROM login_audit WHERE dni=$1', [DNI]);
await query('DELETE FROM empleados WHERE dni=$1', [DNI]);
const empresa = (await query('SELECT id FROM empresas ORDER BY id LIMIT 1')).rows[0];
const hash = await bcrypt.hash(PWD, 12);
const id = (await query(
  `INSERT INTO empleados (empresa_id, leg_num, dni, nom, password_hash, role, activo)
   VALUES ($1,'ZZ9911',$2,'TEST, SEGURIDAD',$3,'employee',true) RETURNING id`,
  [empresa.id, DNI, hash])).rows[0].id;

console.log('\n-- Cabeceras de seguridad --');
{
  const r = await fetch(B + '/health');
  t('Content-Security-Policy presente', !!r.headers.get('content-security-policy'));
  t('X-Frame-Options: DENY', r.headers.get('x-frame-options') === 'DENY');
  t('X-Content-Type-Options: nosniff', r.headers.get('x-content-type-options') === 'nosniff');
  t('Cache-Control no-store', /no-store/.test(r.headers.get('cache-control') || ''));
  t('no expone X-Powered-By', !r.headers.get('x-powered-by'));
}

console.log('\n-- Login --');
{
  const bien = await j('POST', '/auth/login', { dni: DNI, password: PWD });
  t('login correcto devuelve token', bien.s === 200 && !!bien.d.token, JSON.stringify(bien.d).slice(0, 140));

  const inexistente = await j('POST', '/auth/login', { dni: '11122233', password: 'loquesea' });
  const malaClave = await j('POST', '/auth/login', { dni: DNI, password: 'incorrecta' });
  t('mismo mensaje para DNI inexistente y clave erronea (sin enumeracion)',
    inexistente.s === malaClave.s && inexistente.d.error === malaClave.d.error,
    `${inexistente.s}:${inexistente.d.error} vs ${malaClave.s}:${malaClave.d.error}`);

  const t0 = Date.now(); await j('POST', '/auth/login', { dni: '11122233', password: 'x' }); const tInex = Date.now() - t0;
  const t1 = Date.now(); await j('POST', '/auth/login', { dni: DNI, password: 'x' }); const tReal = Date.now() - t1;
  t(`tiempos comparables (inexistente ${tInex}ms vs real ${tReal}ms)`,
    Math.abs(tInex - tReal) < Math.max(tInex, tReal) * 0.7 + 40);

  // El registro de accesos se escribe sin bloquear la respuesta (para no frenar el
  // login), así que hay que darle un instante antes de leerlo.
  await new Promise((r) => setTimeout(r, 300));
  const audit = (await query('SELECT exito, motivo FROM login_audit WHERE dni=$1 ORDER BY id', [DNI])).rows;
  t('los intentos quedan auditados (exitos y fallos)',
    audit.length >= 3 && audit.some((a) => a.exito) && audit.some((a) => !a.exito), JSON.stringify(audit));
}

console.log('\n-- Bloqueo por intentos fallidos --');
{
  await query('UPDATE empleados SET failed_logins=0, locked_until=NULL WHERE id=$1', [id]);
  let bloqueo = null;
  for (let i = 0; i < 10; i++) {
    const r = await j('POST', '/auth/login', { dni: DNI, password: 'mal' + i });
    if (r.s === 429) { bloqueo = i + 1; break; }
  }
  t(`la cuenta se bloquea tras varios fallos (al intento ${bloqueo})`, bloqueo !== null && bloqueo <= 9);
  const conClaveBuena = await j('POST', '/auth/login', { dni: DNI, password: PWD });
  t('bloqueada, rechaza incluso la contrasena correcta', conClaveBuena.s === 429, String(conClaveBuena.s));
  await query('UPDATE empleados SET failed_logins=0, locked_until=NULL WHERE id=$1', [id]);
}

console.log('\n-- Revocacion de sesion --');
{
  let r = await j('POST', '/auth/login', { dni: DNI, password: PWD });
  const tok = r.d.token;
  t('el token sirve antes de revocar', (await j('GET', '/auth/me', null, tok)).s === 200);

  await query('UPDATE empleados SET disabled=true WHERE id=$1', [id]);
  olvidarSesion({ empleadoId: id });
  t('desactivar al usuario invalida su token vigente', (await j('GET', '/auth/me', null, tok)).s === 401);
  await query('UPDATE empleados SET disabled=false WHERE id=$1', [id]);
  olvidarSesion({ empleadoId: id });

  r = await j('POST', '/auth/login', { dni: DNI, password: PWD });
  const tok2 = r.d.token;
  await j('POST', '/auth/logout', null, tok2);
  t('logout invalida el token en el servidor', (await j('GET', '/auth/me', null, tok2)).s === 401);
}

console.log('\n-- Cambio de contrasena obligatorio --');
{
  await query('UPDATE empleados SET must_change_pwd=true WHERE id=$1', [id]);
  olvidarSesion({ empleadoId: id });
  const r = await j('POST', '/auth/login', { dni: DNI, password: PWD });
  const tk = r.d.token;
  const bloqueado = await j('GET', '/empleados/mi-perfil', null, tk);
  t('con cambio pendiente, el resto del portal queda bloqueado',
    bloqueado.s === 403 && bloqueado.d.mustChangePassword === true, JSON.stringify(bloqueado.d));
  t('pero /auth/me sigue accesible', (await j('GET', '/auth/me', null, tk)).s === 200);

  const debil = await j('POST', '/auth/change-password', { currentPassword: PWD, newPassword: DNI }, tk);
  t('rechaza cambiar la contrasena por el DNI', debil.s === 400, JSON.stringify(debil.d));
  const buena = await j('POST', '/auth/change-password', { currentPassword: PWD, newPassword: 'Nube-Violeta-42' }, tk);
  t('acepta una contrasena que cumple la politica', buena.s === 200, JSON.stringify(buena.d));
  t('cambiar la contrasena invalida el token anterior', (await j('GET', '/auth/me', null, tk)).s === 401);
}

console.log('\n-- Autorizacion --');
{
  const r = await j('POST', '/auth/login', { dni: DNI, password: 'Nube-Violeta-42' });
  const tk = r.d.token;
  t('un empleado NO puede listar toda la nomina', (await j('GET', '/empleados', null, tk)).s === 403);
  t('un empleado NO puede entrar al panel de admin', (await j('GET', '/admin/usuarios', null, tk)).s === 403);
  t('sin token, la API responde 401', (await j('GET', '/empleados/mi-perfil')).s === 401);
  t('con token inventado, responde 401', (await j('GET', '/empleados/mi-perfil', null, 'xx.yy.zz')).s === 401);
  t('si puede ver su propio perfil', (await j('GET', '/empleados/mi-perfil', null, tk)).s === 200);

  const falso = jwt.sign({ id, dni: DNI, role: 'admin', tv: 0 }, 'secreto-del-atacante');
  t('un token firmado con otra clave se rechaza', (await j('GET', '/admin/usuarios', null, falso)).s === 401);

  // Token bien firmado pero con el rol manipulado: el rol efectivo sale de la base.
  const tv = (await query('SELECT token_version FROM empleados WHERE id=$1', [id])).rows[0].token_version;
  const manipulado = jwt.sign({ id, dni: DNI, role: 'admin', tv }, config.jwtSecret);
  t('un token con el rol alterado NO otorga permisos de admin',
    (await j('GET', '/admin/usuarios', null, manipulado)).s === 403, 'el rol se lee de la base, no del token');
}

console.log('\n-- Fuga de informacion en errores --');
{
  const raro = await j('POST', '/auth/login', { dni: { $gt: '' }, password: 'x' });
  t('un DNI no textual no produce un error interno', raro.s === 400 || raro.s === 401, `${raro.s} ${JSON.stringify(raro.d)}`);

  const roto = await fetch(B + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{roto' });
  const rd = await roto.json().catch(() => ({}));
  t('JSON malformado devuelve 400 sin stack trace',
    roto.status === 400 && !JSON.stringify(rd).includes('SyntaxError'), `${roto.status} ${JSON.stringify(rd)}`);
}

console.log('\n-- Limite de tasa por IP en credenciales --');
{
  // Instancia aparte con el techo real, para comprobar que el limitador corta.
  process.env.RATE_LOGIN = '5';
  const mod = await import('../src/middleware/rateLimit.js?fresh=' + Date.now());
  const express = (await import('express')).default;
  const chico = express();
  chico.use(express.json());
  chico.post('/api/auth/login', mod.limiteCredenciales, (req, res) => res.json({ ok: true }));
  const s2 = chico.listen(4556);
  let corto = null;
  for (let i = 0; i < 12; i++) {
    const r = await fetch('http://127.0.0.1:4556/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    if (r.status === 429) { corto = i + 1; break; }
  }
  t(`el limitador por IP corta el aluvion de intentos (al intento ${corto})`, corto !== null && corto <= 7);
  s2.close();
}

await query('DELETE FROM login_audit WHERE dni=$1', [DNI]);
await query('DELETE FROM empleados WHERE id=$1', [id]);
console.log(`\nRESULTADO en vivo: ${ok} OK, ${fail} fallidos`);
srv.close();
await pool.end();
process.exit(fail ? 1 : 0);
