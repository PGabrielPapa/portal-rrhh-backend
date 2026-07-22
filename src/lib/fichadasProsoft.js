// Parser del "Reporte Marcas Extendido" de Pro-Soft (Gestión de Personal).
// Convierte el detalle diario (una fila por empleado/día) en novedades
// consolidadas por empleado y período, listas para cruzar por legajo.
//
// Reglas de negocio acordadas con RR.HH. (jun-2026):
//   • Tardanzas: solo se cuentan en días con MARCA COMPLETA (entrada + salida y
//     horas netas > 0). Los días con marca incompleta NO descuentan: van a la
//     lista `diasARevisar` para control manual.
//   • Horas extra (EXTRA 50 / EXTRA 100): se importan como INFORMATIVAS. No se
//     liquidan automáticamente hasta tener el circuito de autorización.
//   • Días trabajados = días con horas netas > 0.

// Encabezados esperados (se matchean por nombre, tolerando espacios/mayúsculas).
const COLS = {
  legajo: 'Legajo', empleado: 'Empleado', dni: 'DNI', fecha: 'Fecha', dia: 'Día',
  turno: 'Turno', e1: 'E1', s1: 'S1', e2: 'E2', s2: 'S2', e3: 'E3', s3: 'S3',
  e4: 'E4', s4: 'S4', hsNetas: 'Hs Netas', descanso: 'Descanso', hsNormal: 'Hs Normal',
  bdh: 'Resut.BDH', extra50: 'EXTRA 50', extra100: 'EXTRA 100', nocturna: 'Nocturna',
  nocturnaExtra: 'Nocturna Extra', total: 'Total', tarde: 'Tarde', area: 'Área',
  empresa: 'Empresa', comentarios: 'Comentarios',
};

// Umbral diario de hora extra (regla Leiten): el extra del día se paga solo
// si alcanzó este mínimo; si no, no se computa. El cierre es POR DÍA.
const UMBRAL_EXTRA_MIN = 30;
// Jornada diaria por defecto: 9 hs.
const JORNADA_DEFAULT = 540;
// Jornada (en minutos) por TURNO cuando difiere de las 9 hs. Clave = nombre del
// turno normalizado (sin espacios/símbolos/mayúsculas). Hoy el único de 10 hs es
// "Hormigon/ mamposteria Leloir". Si aparecen más turnos distintos, agregarlos acá.
export const normTurno = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
const JORNADA_POR_TURNO = {
  [normTurno('Hormigon/ mamposteria Leloir')]: 600, // 10 hs
};

const norm = (s) => String(s == null ? '' : s).trim();
const normKey = (s) => norm(s).toLowerCase().replace(/\s+/g, ' ');

// "HH:MM" → minutos. Soporta negativos ("-09:00") y >24h ("94:02"). Vacío/00:00 → 0.
export function hhmmToMin(v) {
  const s = norm(v);
  if (!s) return 0;
  const neg = s.startsWith('-');
  const body = neg ? s.slice(1) : s;
  const m = /^(\d{1,3}):(\d{2})$/.exec(body);
  if (!m) return 0;
  const val = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  return neg ? -val : val;
}

// minutos → "HH:MM" (para mostrar). Negativos con signo.
export function minToHhmm(min) {
  const neg = min < 0;
  const a = Math.abs(Math.round(min));
  const h = Math.floor(a / 60), m = a % 60;
  return `${neg ? '-' : ''}${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// Legajo normalizado para cruzar Pro-Soft (sin ceros) ↔ portal (leg_num zero-pad).
export function normLegajo(v) {
  const s = norm(v);
  if (!s) return '';
  return /^\d+$/.test(s) ? String(parseInt(s, 10)) : s.toUpperCase();
}

const isTotalRow = (dia) => /TOTAL/i.test(norm(dia));
const fechaISO = (v) => {
  if (v instanceof Date && !isNaN(v)) {
    const y = v.getFullYear(), m = v.getMonth() + 1, d = v.getDate();
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  const s = norm(v);
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const m2 = /(\d{2})\/(\d{2})\/(\d{4})/.exec(s);
  if (m2) return `${m2[3]}-${m2[2]}-${m2[1]}`;
  return s.slice(0, 10);
};

const DOW = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const diaSemanaISO = (iso) => { const [y, m, d] = String(iso).split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };
const esDiaHabil = (iso) => { const w = diaSemanaISO(iso); return w >= 1 && w <= 5; };
function* rangoFechas(desde, hasta) {
  const [y, m, d] = String(desde).split('-').map(Number);
  const cur = new Date(Date.UTC(y, m - 1, d));
  for (let iso = cur.toISOString().slice(0, 10); iso <= hasta; cur.setUTCDate(cur.getUTCDate() + 1), iso = cur.toISOString().slice(0, 10)) yield iso;
}

/**
 * Cálculo de extras y banco de horas — NETEO DE TODO EL PERÍODO.
 * Clasifica cada día y luego compensa el tiempo en contra contra el a favor:
 *   • Día HÁBIL con excedente > 30 min → hora extra 50 % (bruta).
 *   • Día HÁBIL con excedente 1..30 min → banco chico (a favor, no se paga).
 *   • Día HÁBIL con déficit → tiempo en contra.
 *   • SÁBADO trabajado → todo el neto es hora extra 50 % (no compensa la semana).
 *   • DOMINGO / FERIADO trabajado → todo el neto es hora extra 100 % (no compensa).
 * El TIEMPO EN CONTRA descuenta PRIMERO el banco chico y después la hora extra
 * de días hábiles (el sábado/domingo/feriado NO se tocan). Solo si sobra déficit
 * queda "a recuperar". Así nunca hay hora extra y tiempo a recuperar a la vez.
 * Los días sin marca / licencia / a revisar (saldoMin null) no computan.
 * Resultado: a.horasExtra50Min, a.horasExtra100Min, a.bancoNetoMin (+ a favor /
 * − a recuperar) y a.aRecuperarMin.
 */
// Calcula los totales del período a partir del arreglo de días (orden indiferente).
// Reutilizable: lo usa el parser y también el ajuste manual de intervalos.
export function recomputarTotales(dias) {
  let extra50wd = 0, extra50sab = 0, extra100 = 0, bancoChico = 0, deficit = 0;
  for (const d of (dias || [])) {
    if (typeof d.saldoMin !== 'number') continue;      // sin-marca / licencia / revisar
    const s = d.saldoMin;
    if (d.tipoDia === 'sabado') { if (s > 0) extra50sab += s; continue; }
    if (d.tipoDia === 'domingo' || d.tipoDia === 'feriado') { if (s > 0) extra100 += s; continue; }
    // Día hábil.
    if (s > UMBRAL_EXTRA_MIN) extra50wd += s;           // más de 30 min → extra (bruta)
    else if (s > 0) bancoChico += s;                   // 30 min o menos → banco chico
    else if (s < 0) deficit += -s;                     // tiempo en contra
  }
  // Compensar el tiempo en contra: primero con el banco chico, después con la
  // extra de días hábiles. El finde/feriado no compensa.
  let rem = deficit;
  const usaBanco = Math.min(rem, bancoChico); bancoChico -= usaBanco; rem -= usaBanco;
  const usaExtra = Math.min(rem, extra50wd); extra50wd -= usaExtra; rem -= usaExtra;
  const aRecuperar = rem;                              // déficit que no se pudo compensar
  const bancoFavor = aRecuperar > 0 ? 0 : bancoChico;  // a favor que sobró (excluyente con a recuperar)
  return {
    horasExtra50Min: extra50wd + extra50sab,
    horasExtra100Min: extra100,
    horasExtraDescartadaMin: 0,
    bancoNetoMin: bancoFavor - aRecuperar,             // + a favor / − a recuperar
    aRecuperarMin: aRecuperar,
  };
}

// Marca (o desmarca) el intervalo intermedio de un día como jornada trabajada:
// suma (o resta) ese tiempo al neto y recalcula el saldo del día. Idempotente.
export function aplicarIntermedioDia(d, computar) {
  if (!d) return d;
  const target = !!computar, cur = !!d.computarIntermedio, im = d.intermedioMin || 0;
  if (target === cur || im <= 0) { d.computarIntermedio = target && im > 0; return d; }
  d.hsNetasMin = (d.hsNetasMin || 0) + (target ? im : -im);
  d.computarIntermedio = target;
  if (typeof d.saldoMin === 'number') d.saldoMin = d.hsNetasMin - (d.hsNormalMin || 0);
  return d;
}

function calcularTotales(a) { Object.assign(a, recomputarTotales(a.dias)); }

/**
 * @param {Array<Array>} rows  Filas de la hoja (la primera es el encabezado).
 * @param {{desde?:string, hasta?:string, feriados?:Set<string>|string[]}} [opts]
 * @returns {{ porLegajo, filas, legajos, columnasFaltantes }}
 */
export function parseExtendido(rows, opts = {}) {
  if (!Array.isArray(rows) || rows.length < 2) {
    return { porLegajo: {}, filas: 0, legajos: 0, columnasFaltantes: ['(archivo vacío)'] };
  }
  const feriados = opts.feriados instanceof Set ? opts.feriados : new Set(opts.feriados || []);
  const { desde, hasta } = opts;
  // Mapa nombre-de-columna → índice (tolerante a espacios/mayúsculas).
  const header = rows[0].map((h) => normKey(h));
  const idxOf = (label) => header.indexOf(normKey(label));
  const idx = {};
  const faltantes = [];
  for (const [k, label] of Object.entries(COLS)) {
    idx[k] = idxOf(label);
    if (idx[k] === -1 && ['legajo', 'fecha', 'hsNetas', 'extra50', 'tarde'].includes(k)) faltantes.push(label);
  }
  const cell = (r, k) => (idx[k] >= 0 && idx[k] < r.length ? r[idx[k]] : undefined);

  const acc = {}; // legajoNorm → agregado
  const turnosVistos = new Set(); // nombres de turno presentes (para autodetección)
  let filas = 0;

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r.length) continue;
    if (isTotalRow(cell(r, 'dia'))) continue;           // filas TOTALES / TOTAL FINAL / subtotales
    const legRaw = norm(cell(r, 'legajo'));
    if (!legRaw) continue;
    const leg = normLegajo(legRaw);
    filas++;

    if (!acc[leg]) {
      acc[leg] = {
        legajoProsoft: legRaw,
        empleado: norm(cell(r, 'empleado')),
        empresaProsoft: norm(cell(r, 'empresa')),
        area: norm(cell(r, 'area')),
        diasTrabajados: 0,
        hsNetasMin: 0,
        horasExtra50Min: 0,
        horasExtra100Min: 0,
        horasExtraDescartadaMin: 0,
        bancoNetoMin: 0,
        tardanzasMin: 0,
        diasTardanza: 0,
        diasARevisar: [],
        licenciasProsoft: {},
        dias: [],
      };
    }
    const a = acc[leg];

    const fecha = fechaISO(cell(r, 'fecha'));
    // Tipo de día: hábil (lun-vie sin feriado), sábado, domingo o feriado.
    const w = diaSemanaISO(fecha); // 0=Dom … 6=Sáb
    const tipoDia = feriados.has(fecha) ? 'feriado' : (w === 0 ? 'domingo' : (w === 6 ? 'sabado' : 'habil'));
    const esLaborable = tipoDia === 'habil';
    // Regla del turno (jornada + recorte). El turno viene de Pro-Soft; los horarios
    // se cargan en la tabla turnos_reglas y llegan acá por opts.turnos.
    const turnoRaw = norm(cell(r, 'turno'));
    const nt = normTurno(turnoRaw);
    const regla = (opts.turnos instanceof Map) ? opts.turnos.get(nt) : null;
    if (turnoRaw && turnosVistos) turnosVistos.add(turnoRaw);
    // Jornada esperada según el TURNO (regla cargada → JORNADA_POR_TURNO → 9 hs). Finde/feriado → 0.
    const jornadaTurno = (regla && regla.jornadaMin) || JORNADA_POR_TURNO[nt] || JORNADA_DEFAULT;
    const jornadaDia = esLaborable ? jornadaTurno : 0;
    a.jornadaTurnoMin = jornadaTurno; // se usa para completar días faltantes
    // Turno RESTRINGIDO: la entrada ANTES del horario fijado NO computa. Se recorta
    // el ingreso al horario de inicio (max(entrada, inicio)). Quedarse después SÍ cuenta.
    const inicioRecorte = (regla && regla.restringido && typeof regla.inicioMin === 'number') ? regla.inicioMin : null;
    // Neto trabajado calculado desde las MARCAS (E1/S1..E4/S4), descontando salidas
    // intermedias. NO se usa "Hs Netas" de Pro-Soft (no aplica nuestra lógica).
    let netMin = 0, marcaSuelta = false, algunaMarca = false, recorteMin = 0;
    const segmentos = [];    // pares entrada/salida trabajados del día
    const marcasSueltas = []; // marcas sin par (para mostrar/revisar)
    for (const [ek, sk] of [['e1', 's1'], ['e2', 's2'], ['e3', 's3'], ['e4', 's4']]) {
      const em = norm(cell(r, ek)), sm = norm(cell(r, sk));
      if (em || sm) algunaMarca = true;
      if (em && sm) {
        const eMin = hhmmToMin(em), sMin = hhmmToMin(sm);
        let eEff = eMin;
        if (inicioRecorte != null && eMin < inicioRecorte) { // recorta lo trabajado antes del horario
          eEff = inicioRecorte;
          recorteMin += Math.max(0, Math.min(sMin, inicioRecorte) - eMin);
        }
        const d = sMin - eEff;
        if (d > 0) { netMin += d; segmentos.push({ e: em, s: sm }); }
      }
      else if (em || sm) { marcaSuelta = true; marcasSueltas.push(em || sm); } // marca impar → incompleta
    }
    // Todas las fichadas del día en orden (para mostrar en el detalle): "07:48-11:59 · 13:12-17:04".
    const marcasTexto = segmentos.map((p) => `${p.e}-${p.s}`).concat(marcasSueltas.map((m) => `${m}-?`)).join(' · ');
    // Tiempo INTERMEDIO sin trabajar (entre el primer ingreso y la última salida,
    // menos lo efectivamente trabajado). Cuando hay más de un tramo, ese hueco puede
    // ser almuerzo (bien descontado) o no; se marca para que RR.HH. lo revise.
    let intermedioMin = 0;
    if (segmentos.length > 1) {
      const ini = hhmmToMin(segmentos[0].e), fin = hhmmToMin(segmentos[segmentos.length - 1].s);
      intermedioMin = Math.max(0, (fin - ini) - netMin);
    }
    const tarde = hhmmToMin(cell(r, 'tarde')); // informativo (no entra al cálculo)
    const comentario = norm(cell(r, 'comentarios')); // Vacaciones, Licencia, ART, Estudio, Home Office...
    const esHomeOffice = /home\s*office/i.test(comentario);  // trabajo remoto: cuenta como día trabajado
    const esLicencia = comentario.length > 0 && !esHomeOffice;
    const marcaCompleta = !esLicencia && netMin > 0 && !marcaSuelta;
    const entrada = norm(cell(r, 'e1')) || norm(cell(r, 'e2')) || norm(cell(r, 'e3')) || norm(cell(r, 'e4'));
    const salida = norm(cell(r, 's4')) || norm(cell(r, 's3')) || norm(cell(r, 's2')) || norm(cell(r, 's1'));

    if (esHomeOffice) {
      // Home Office: día de trabajo real (todavía no fichan desde casa, se carga
      // como comentario). Cuenta como jornada cumplida → saldo 0 (ni suma ni resta).
      a.diasTrabajados++;
      a.hsNetasMin += jornadaDia;
      a.dias.push({
        fecha, dia: norm(cell(r, 'dia')), entrada: '', salida: '',
        hsNetasMin: jornadaDia, hsNormalMin: jornadaDia, saldoMin: 0, tipoDia,
        extra50Min: 0, extra100Min: 0, extraComputa: false, tardeMin: 0,
        completa: false, estado: 'home-office', comentario,
      });
    } else if (esLicencia) {
      // Día justificado por novedad de Pro-Soft (Vacaciones, Licencia, ART, etc.).
      // NO cuenta como trabajado/banco/extra: Pro-Soft rellena estos días con Hs
      // Netas ficticias (p. ej. 17:00) que no son horas reales y hay que ignorar.
      a.licenciasProsoft[comentario] = (a.licenciasProsoft[comentario] || 0) + 1;
      a.dias.push({
        fecha, dia: norm(cell(r, 'dia')), entrada: '', salida: '',
        hsNetasMin: 0, hsNormalMin: jornadaDia, saldoMin: null, tipoDia,
        extra50Min: 0, extra100Min: 0, extraComputa: false, tardeMin: 0,
        completa: false, estado: 'licencia', comentario,
      });
    } else {
      if (netMin > 0) { a.diasTrabajados++; a.hsNetasMin += netMin; }
      if (tarde > 0 && marcaCompleta) { a.tardanzasMin += tarde; a.diasTardanza++; }
      if (algunaMarca && marcaSuelta && !marcaCompleta) {
        a.diasARevisar.push({ fecha, motivo: 'Marca incompleta (cantidad impar de fichadas)' });
      }

      // Detalle diario: días con actividad, o días laborables sin marca (posible
      // ausencia → la ruta lo cruza con licencias del portal para decidir).
      // El saldo (neto − jornada) y las extras/banco se calculan luego en
      // calcularTotales() con el banco compensatorio corrido.
      const hayActividad = algunaMarca || netMin > 0;
      if (hayActividad || esLaborable) {
        let estado;
        if (marcaCompleta && !esLaborable) estado = 'no-laborable';   // sábado/domingo/feriado trabajado
        else if (marcaCompleta) estado = 'ok';
        else if (hayActividad) estado = 'revisar';                    // marca incompleta
        else estado = 'sin-marca';                                    // laborable sin marca
        a.dias.push({
          fecha, dia: norm(cell(r, 'dia')), entrada, salida, marcas: marcasTexto, nMarcas: segmentos.length, intermedioMin,
          turno: turnoRaw, recorteMin,
          hsNetasMin: netMin, hsNormalMin: jornadaDia,
          saldoMin: marcaCompleta ? (netMin - jornadaDia) : null, tipoDia,
          extra50Min: 0, extra100Min: 0, extraComputa: false,
          tardeMin: tarde, completa: marcaCompleta, estado, comentario: '',
        });
      }
    }
  }

  // Completar días hábiles faltantes del rango (ausencias totales, sin fila en
  // Pro-Soft) como 'sin-marca' → luego el cruce los marca injustificados si no
  // hay licencia. Se saltan fin de semana y feriados.
  if (desde && hasta) {
    for (const a of Object.values(acc)) {
      const existentes = new Set(a.dias.map((d) => d.fecha));
      const jd = a.jornadaTurnoMin || JORNADA_DEFAULT;
      for (const iso of rangoFechas(desde, hasta)) {
        if (!esDiaHabil(iso) || feriados.has(iso) || existentes.has(iso)) continue;
        a.dias.push({
          fecha: iso, dia: DOW[diaSemanaISO(iso)], entrada: '', salida: '',
          hsNetasMin: 0, hsNormalMin: jd, saldoMin: null, tipoDia: 'habil',
          extra50Min: 0, extra100Min: 0, extraComputa: false, tardeMin: 0,
          completa: false, estado: 'sin-marca', comentario: '',
        });
      }
      a.dias.sort((x, y) => x.fecha.localeCompare(y.fecha));
    }
  }

  // Cálculo definitivo de extras y banco con el banco compensatorio CORRIDO.
  for (const a of Object.values(acc)) { a.dias.sort((x, y) => x.fecha.localeCompare(y.fecha)); calcularTotales(a); }

  return { porLegajo: acc, filas, legajos: Object.keys(acc).length, columnasFaltantes: faltantes, turnosVistos: [...turnosVistos] };
}
