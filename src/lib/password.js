// Política de contraseñas del portal.
//
// El sistema guarda datos personales sensibles (remuneraciones, CBU, certificados
// médicos, sanciones), así que la contraseña es la única barrera real frente a un
// acceso indebido. Antes se aceptaba cualquier cadena de 6 caracteres, lo que
// permitía "123456" o el propio DNI: adivinables en pocos intentos.
import crypto from 'node:crypto';

export const PWD_MIN = 10;

// Contraseñas triviales de uso frecuente en Argentina/español + patrones de teclado.
// No es una lista exhaustiva (eso sería tarea de un servicio externo), sino el corte
// que elimina lo que un atacante prueba en los primeros cien intentos.
const COMUNES = new Set([
  '123456', '1234567', '12345678', '123456789', '1234567890', '12345678910',
  'password', 'password1', 'passw0rd', 'contrasena', 'contraseña', 'contrasena1',
  'qwerty', 'qwerty123', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm', '1q2w3e4r', '1qaz2wsx',
  'admin', 'admin123', 'administrador', 'usuario', 'usuario1', 'iloveyou',
  'argentina', 'argentina1', 'boca', 'river', 'bocajuniors', 'riverplate',
  'portalrrhh', 'rrhh2026', 'leiten', 'leiten123', 'abc123', 'abcd1234',
  'welcome', 'bienvenido', 'cambiar123', 'temporal1', 'secreto1',
]);

// Raíces que no deben aparecer al principio ni al final de la contraseña, aunque
// vengan disfrazadas con números o símbolos ("Password123", "Qwerty2026!").
const BASES_COMUNES = [
  'password', 'passwd', 'contrasena', 'clave', 'secreto', 'qwerty', 'asdfgh', 'zxcvbn',
  'admin', 'administrador', 'usuario', 'welcome', 'bienvenido', 'iloveyou', 'letmein',
  'argentina', 'buenosaires', 'bocajuniors', 'riverplate', 'temporal', 'cambiar',
  'portal', 'leiten', 'rrhh', 'sistema', 'prueba', 'test', 'demo',
];

const norm = (s) => String(s || '').trim();

// Quita acentos y pasa a minúsculas, para que "Contraseña" no esquive la lista.
const sinTildes = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
const plano = (s) => sinTildes(norm(s)).toLowerCase();

// ¿La cadena es un único carácter repetido o una secuencia corrida (12345 / abcdef)?
function esSecuencia(s) {
  const t = plano(s);
  if (t.length < 4) return false;
  if (/^(.)\1+$/.test(t)) return true;
  let asc = true, desc = true;
  for (let i = 1; i < t.length; i++) {
    const d = t.charCodeAt(i) - t.charCodeAt(i - 1);
    if (d !== 1) asc = false;
    if (d !== -1) desc = false;
  }
  return asc || desc;
}

/**
 * Valida una contraseña nueva.
 * @param {string} pwd            la contraseña propuesta
 * @param {object} datosUsuario   { dni, cuil, nom, email, legNum } — para prohibir
 *                                que la contraseña contenga datos propios adivinables.
 * @returns {{ok:true} | {ok:false, error:string}}
 */
export function validarPassword(pwd, datosUsuario = {}) {
  const p = norm(pwd);
  if (!p) return { ok: false, error: 'Ingresá una contraseña.' };
  if (p.length < PWD_MIN) return { ok: false, error: `La contraseña debe tener al menos ${PWD_MIN} caracteres.` };
  if (p.length > 200) return { ok: false, error: 'La contraseña no puede superar los 200 caracteres.' };
  if (/\s/.test(p) && p.trim() !== String(pwd)) return { ok: false, error: 'La contraseña no puede empezar ni terminar con espacios.' };

  // Al menos tres de las cuatro familias: minúscula, mayúscula, dígito, símbolo.
  // Se evalúa sobre la forma sin tildes para que "ñ"/"á" cuenten como letras.
  const base = sinTildes(p);
  const familias = [/[a-z]/.test(base), /[A-Z]/.test(base), /[0-9]/.test(base), /[^A-Za-z0-9]/.test(base)]
    .filter(Boolean).length;
  if (familias < 3) {
    return { ok: false, error: 'La contraseña debe combinar al menos tres de: minúsculas, mayúsculas, números y símbolos.' };
  }

  const pl = plano(p);
  if (COMUNES.has(pl)) return { ok: false, error: 'Esa contraseña es demasiado común. Elegí otra.' };
  // "Password123" o "Qwerty2026!" pasaban la comparación exacta: la contraseña
  // común sigue ahí, solo maquillada con dígitos al final para cumplir la regla
  // de complejidad. Se evalúa también el núcleo alfabético.
  const nucleo = pl.replace(/[^a-z]/g, '');
  if (nucleo.length >= 5 && BASES_COMUNES.some((b) => nucleo === b || nucleo.startsWith(b) || nucleo.endsWith(b))) {
    return { ok: false, error: 'Esa contraseña se basa en una palabra demasiado común. Elegí otra.' };
  }
  if (esSecuencia(p) || esSecuencia(pl.replace(/[^a-z0-9]/g, ''))) {
    return { ok: false, error: 'La contraseña no puede ser una secuencia ni un carácter repetido.' };
  }

  // Datos propios: DNI, CUIL, legajo, partes del nombre y del mail.
  const prohibidos = [];
  for (const k of ['dni', 'cuil', 'legNum', 'leg_num']) {
    const v = plano(datosUsuario[k]).replace(/\D/g, '');
    if (v.length >= 5) prohibidos.push(v);
  }
  const nom = plano(datosUsuario.nom);
  for (const parte of nom.split(/[\s,]+/)) if (parte.length >= 4) prohibidos.push(parte);
  const mail = plano(datosUsuario.email).split('@')[0];
  if (mail && mail.length >= 4) prohibidos.push(mail);
  prohibidos.push('rrhh', 'portal', 'leiten');

  for (const bad of prohibidos) {
    if (bad && pl.includes(bad)) {
      return { ok: false, error: 'La contraseña no puede contener tu DNI, legajo, nombre, mail ni el nombre del portal.' };
    }
  }
  return { ok: true };
}

/**
 * Contraseña temporal aleatoria para el blanqueo administrativo.
 * Antes el blanqueo dejaba la contraseña igual al DNI, que figura en cualquier
 * listado del portal: cualquiera podía entrar a la cuenta recién blanqueada.
 * Alfabeto sin caracteres ambiguos (0/O, 1/l/I) para que se pueda dictar.
 */
export function generarPasswordTemporal(largo = 14) {
  const AB = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const ab = 'abcdefghijkmnpqrstuvwxyz';
  const num = '23456789';
  const sim = '!@#$%&*+-=?';
  const todo = AB + ab + num + sim;
  const pick = (set) => set[crypto.randomInt(0, set.length)];
  // Garantiza una de cada familia y completa al azar.
  const chars = [pick(AB), pick(ab), pick(num), pick(sim)];
  while (chars.length < largo) chars.push(pick(todo));
  // Mezcla Fisher-Yates con aleatoriedad criptográfica.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

/**
 * Regla anterior a la auditoría, vigente cuando `PWD_POLITICA_ESTRICTA` está
 * apagado: mínimo 6 caracteres y que no sea igual al DNI. Se mantiene explícita
 * para que quede claro qué se está exigiendo en cada modo.
 */
export function validarPasswordSimple(pwd, datosUsuario = {}, min = 6) {
  const p = norm(pwd);
  if (!p) return { ok: false, error: 'Ingresá una contraseña.' };
  if (p.length < min) return { ok: false, error: `La nueva contraseña debe tener al menos ${min} caracteres` };
  if (p.length > 200) return { ok: false, error: 'La contraseña no puede superar los 200 caracteres.' };
  if (datosUsuario.dni && p === String(datosUsuario.dni)) {
    return { ok: false, error: 'La nueva contraseña no puede ser igual al DNI' };
  }
  return { ok: true };
}

/**
 * Punto de entrada único que usan las rutas. Elige la política según el
 * interruptor `config.password.politicaEstricta`, de modo que activar la política
 * fuerte más adelante no requiera tocar los endpoints.
 */
export function validarPasswordSegunConfig(pwd, datosUsuario, cfgPassword) {
  const c = cfgPassword || {};
  return c.politicaEstricta
    ? validarPassword(pwd, datosUsuario)
    : validarPasswordSimple(pwd, datosUsuario, c.minSimple || 6);
}
