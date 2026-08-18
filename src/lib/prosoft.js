// Cliente de la API de Pro-Soft "Gestión de Personal".
// Relevado en PROSOFT-API.md (sin documentación oficial). Autentica con cookie de
// sesión y trae el "resumen" (fichadas + horas calculadas) vía job asíncrono.
// Credenciales SIEMPRE por variables de entorno (nunca en código ni git).
import { config } from '../config.js';
import { parseExtendido } from './fichadasProsoft.js';
import { procesarParsed, getFeriadosSet, getTurnosReglas } from './fichadasProcesar.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Timeout de las llamadas salientes. Sin esto, un Pro-Soft caído o lento dejaba
// la petición colgada indefinidamente, reteniendo conexiones y memoria del portal.
const TIMEOUT_MS = Number(process.env.PROSOFT_TIMEOUT_MS || 30_000);
function conTimeout(ms = TIMEOUT_MS) {
  const ac = new AbortController();
  const id = setTimeout(() => ac.abort(), ms);
  return { signal: ac.signal, fin: () => clearTimeout(id) };
}

let cookie = null; // jar de sesión muy simple (un solo usuario de servicio)

export function prosoftConfigOk() {
  return !!(config.prosoft.user && config.prosoft.pass && config.prosoft.base);
}

async function login() {
  const to = conTimeout();
  let r;
  try {
    r = await fetch(`${config.prosoft.base}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usuario: config.prosoft.user, clave: config.prosoft.pass }),
      signal: to.signal,
    });
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'Pro-Soft: el login superó el tiempo de espera.' : `Pro-Soft: no se pudo conectar (${e.message}).`);
  } finally { to.fin(); }
  if (!r.ok) throw new Error(`Pro-Soft: login falló (HTTP ${r.status}). Revisá PROSOFT_USER/PROSOFT_PASS.`);
  const setCookies = typeof r.headers.getSetCookie === 'function'
    ? r.headers.getSetCookie()
    : [r.headers.get('set-cookie')].filter(Boolean);
  cookie = setCookies.map((c) => String(c).split(';')[0]).join('; ');
  if (!cookie) throw new Error('Pro-Soft: el login no devolvió cookie de sesión.');
}

// fetch con cookie; si expira (401) reintenta una vez tras re-login.
async function api(path, opts = {}, _retry = false) {
  if (!cookie) await login();
  const to = conTimeout();
  let r;
  try {
    r = await fetch(`${config.prosoft.base}${path}`, {
      ...opts,
      headers: { 'Content-Type': 'application/json', Cookie: cookie, ...(opts.headers || {}) },
      signal: to.signal,
    });
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? `Pro-Soft: ${path} superó el tiempo de espera.` : `Pro-Soft: fallo de red en ${path} (${e.message}).`);
  } finally { to.fin(); }
  if (r.status === 401 && !_retry) { cookie = null; return api(path, opts, true); }
  return r;
}

// Trae el resumen (una fila por empleado/día con marcas y horas) entre dos fechas YYYY-MM-DD.
export async function getResumen(desde, hasta) {
  const startRes = await api('/resumen/GetValue', {
    method: 'POST',
    body: JSON.stringify({ fechaDesde: desde, fechaHasta: hasta, legajos: [], turnos: [], areas: [], sucursales: [] }),
  });
  if (!startRes.ok) throw new Error(`Pro-Soft: GetValue falló (HTTP ${startRes.status}).`);
  let start = await startRes.json();
  if (typeof start === 'string') { try { start = JSON.parse(start); } catch { /* queda string */ } }
  // Algunos despliegues devuelven los datos directo (sin job asíncrono).
  if (Array.isArray(start)) return start;
  if (start && (start.datos || start.Datos)) return start.datos || start.Datos;
  const jobId = start && (start.jobId || start.JobId || start.jobid || start.id || start.Id);
  if (!jobId) throw new Error('Pro-Soft: GetValue no devolvió jobId. Respuesta cruda: ' + JSON.stringify(start).slice(0, 800));

  // Pollear hasta completar (máx ~3 min).
  for (let i = 0; i < 120; i++) {
    await sleep(1500);
    const stRes = await api(`/resumen/GetStatus?jobId=${encodeURIComponent(jobId)}`);
    if (!stRes.ok) throw new Error(`Pro-Soft: GetStatus falló (HTTP ${stRes.status}).`);
    let st = await stRes.json();
    if (typeof st === 'string') { try { st = JSON.parse(st); } catch { /* */ } }
    if (st && (st.completado || st.Completado)) return st.datos || st.Datos || [];
  }
  throw new Error('Pro-Soft: el resumen no terminó de procesarse a tiempo.');
}

// Trae el maestro de filtros (legajos, turnos, áreas, contratantes).
// Los turnos deberían traer las horas/horario de cada uno (para derivar la jornada).
export async function getFiltros() {
  const r = await api('/filtros');
  if (!r.ok) throw new Error(`Pro-Soft: /filtros falló (HTTP ${r.status}).`);
  let data = await r.json();
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch { /* queda string */ } }
  return data;
}

// Trae la definición de TURNOS con sus tramos horarios (hini/hfin/tipo por día).
// tipo "0" = franja de jornada normal; tipo "1" = franja de hora extra permitida.
export async function getTurnos() {
  const r = await api('/turnos');
  if (!r.ok) throw new Error(`Pro-Soft: /turnos falló (HTTP ${r.status}).`);
  let data = await r.json();
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch { /* queda string */ } }
  return Array.isArray(data) ? data : [];
}

// Deriva, por turno, la regla para el cálculo: jornada (bloque normal más largo),
// horario de ingreso (inicio del bloque normal más temprano) y si es "restringido"
// (no hay ninguna franja que empiece antes del ingreso → la entrada temprana no computa).
export function reglasDesdeTurnos(turnos) {
  const toMin = (s) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim()); return m ? (+m[1]) * 60 + (+m[2]) : null; };
  const hhmm = (m) => (m == null ? null : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
  const dias = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes'];
  const out = [];
  for (const t of (turnos || [])) {
    const nombre = String(t.turno || '').trim();
    if (!nombre) continue;
    // Tramos de un día hábil representativo (el primero que tenga franjas).
    let tramosDia = [];
    for (const d of dias) { const f = (t.tramos || []).filter((x) => x[d]); if (f.length) { tramosDia = f; break; } }
    if (!tramosDia.length) tramosDia = (t.tramos || []);
    const tipo0 = tramosDia.filter((x) => String(x.tipo) === '0');
    let jornada = 0, inicio = null;
    for (const x of tipo0) {
      let a = toMin(x.hini), b = toMin(x.hfin); if (a == null || b == null) continue;
      if (b <= a) b += 1440; // cruza medianoche
      if (b - a > jornada) jornada = b - a;           // jornada = bloque normal más largo
      if (inicio == null || a < inicio) inicio = a;    // ingreso = bloque normal más temprano
    }
    const hayFranjaAntes = tramosDia.some((x) => { const a = toMin(x.hini); return a != null && inicio != null && a < inicio; });
    out.push({ turno: nombre, jornada_min: jornada || 540, inicio: hhmm(inicio), restringido: !hayFranjaAntes });
  }
  return out;
}

// "6/18/2026" (M/D/YYYY) → "2026-06-18". Tolera ya-ISO.
export function fechaISO(v) {
  const s = String(v || '').trim();
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`; // m[1]=mes, m[2]=día
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : s;
}

// Convierte las filas de la API al MISMO formato (AOA) del "Reporte Marcas
// Extendido", para reusar parseExtendido() y que el cálculo sea idéntico.
export function datosToAoa(datos) {
  const header = ['Legajo', 'Empleado', 'DNI', 'Fecha', 'Día', 'Turno',
    'E1', 'S1', 'E2', 'S2', 'E3', 'S3', 'E4', 'S4', 'Hs Netas', 'Descanso', 'Hs Normal',
    'Resut.BDH', 'EXTRA 50', 'EXTRA 100', 'Nocturna', 'Nocturna Extra', 'Total', 'Tarde',
    'Área', 'Empresa', 'Comentarios'];
  const aoa = [header];
  for (const r of (datos || [])) {
    aoa.push([
      r.legajo, r.nombre, r.dni || '', fechaISO(r.dia), r.diasemana || '', r.turno || '',
      r.e1 || '', r.s1 || '', r.e2 || '', r.s2 || '', r.e3 || '', r.s3 || '', r.e4 || '', r.s4 || '',
      r.hsnetas || '', '', r.hs_normal || '', r.ResultadoBDH || r.hsNormalesBDH || '',
      r.hs_extra50 || '', r.hs_extra100 || '', r.hs_nocturna || '', r.hs_nocturna_extra || '',
      r.total || '', r.tarde || '', r.area || '', r.nombreempresa || '', r.comentario || '',
    ]);
  }
  return aoa;
}

// Trae el resumen de un mes y lo deja parseado (listo para procesarParsed()).
export async function getMesParseado(anio, mes) {
  const ultimo = new Date(anio, mes, 0).getDate();
  const desde = `${anio}-${String(mes).padStart(2, '0')}-01`;
  const hasta = `${anio}-${String(mes).padStart(2, '0')}-${String(ultimo).padStart(2, '0')}`;
  const datos = await getResumen(desde, hasta);
  const parsed = parseExtendido(datosToAoa(datos));
  return { parsed, desde, hasta, filas: datos.length };
}

// Importa un RANGO Desde/Hasta (puede cruzar meses) y lo guarda bajo el período
// de liquidación (anio/mes) indicado. soloPendientes evita pisar lo ya aprobado.
export async function importarRango(desde, hasta, anio, mes, { confirmar = false, soloPendientes = false, importadoPor = null } = {}) {
  const datos = await getResumen(desde, hasta);
  const feriados = await getFeriadosSet(desde, hasta);
  const turnos = await getTurnosReglas();
  const parsed = parseExtendido(datosToAoa(datos), { desde, hasta, feriados, turnos });
  const result = await procesarParsed({
    parsed, anio, mes, confirmar, soloPendientes, desde, hasta,
    origen: 'prosoft-api', importadoPor,
    archivoNombre: `Pro-Soft API ${desde}…${hasta}`,
  });
  return { ...result, periodo: { anio, mes }, filasApi: datos.length };
}

// Atajo: importa un mes calendario completo (usado por la tarea diaria).
export async function importarMes(anio, mes, opts = {}) {
  const ultimo = new Date(anio, mes, 0).getDate();
  const desde = `${anio}-${String(mes).padStart(2, '0')}-01`;
  const hasta = `${anio}-${String(mes).padStart(2, '0')}-${String(ultimo).padStart(2, '0')}`;
  return importarRango(desde, hasta, anio, mes, opts);
}
