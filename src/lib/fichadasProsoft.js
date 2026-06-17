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

/**
 * @param {Array<Array>} rows  Filas de la hoja (la primera es el encabezado).
 * @returns {{ porLegajo: Object, filas: number, legajos: number, columnasFaltantes: string[] }}
 */
export function parseExtendido(rows) {
  if (!Array.isArray(rows) || rows.length < 2) {
    return { porLegajo: {}, filas: 0, legajos: 0, columnasFaltantes: ['(archivo vacío)'] };
  }
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
        dias: [],
      };
    }
    const a = acc[leg];

    const hsNetas = hhmmToMin(cell(r, 'hsNetas'));
    const hsNormal = hhmmToMin(cell(r, 'hsNormal'));
    const e50 = hhmmToMin(cell(r, 'extra50'));
    const e100 = hhmmToMin(cell(r, 'extra100'));
    const tarde = hhmmToMin(cell(r, 'tarde'));
    const tieneEntrada = !!norm(cell(r, 'e1'));
    const tieneSalida = !!norm(cell(r, 's1'));
    const algunaMarca = ['e1', 's1', 'e2', 's2', 'e3', 's3', 'e4', 's4'].some((k) => norm(cell(r, k)));
    const marcaCompleta = tieneEntrada && tieneSalida && hsNetas > 0;
    const fecha = fechaISO(cell(r, 'fecha'));

    if (hsNetas > 0) { a.diasTrabajados++; a.hsNetasMin += hsNetas; }
    // Banco de horas (saldo): solo días con marca completa. Hs Normal ya viene
    // 0 en sábado/domingo/feriado (parametrización de Pro-Soft) → todo a favor.
    if (marcaCompleta) a.bancoNetoMin += (hsNetas - hsNormal);

    // Hora extra por DÍA: si el total extra del día (50+100) alcanzó el umbral,
    // se paga completo; si no, se descarta (se guarda aparte, para control).
    const extraDiaMin = e50 + e100;
    if (extraDiaMin >= UMBRAL_EXTRA_MIN) {
      a.horasExtra50Min += e50;
      a.horasExtra100Min += e100;
    } else if (extraDiaMin > 0) {
      a.horasExtraDescartadaMin += extraDiaMin;
    }

    if (tarde > 0) {
      if (marcaCompleta) {
        a.tardanzasMin += tarde;
        a.diasTardanza++;
      } else {
        // Tardanza con marca incompleta → no se descuenta, va a revisión.
        a.diasARevisar.push({ fecha, motivo: 'Tardanza con marca incompleta', tarde: minToHhmm(tarde) });
      }
    } else if (algunaMarca && hsNetas <= 0) {
      // Hay marca pero no se computaron horas netas (fichada incompleta).
      a.diasARevisar.push({ fecha, motivo: 'Marca incompleta (sin horas netas)' });
    }

    // Detalle diario (para auditar el cálculo). Guardamos solo días con actividad.
    if (algunaMarca || hsNetas > 0 || tarde > 0) {
      const entrada = norm(cell(r, 'e1')) || norm(cell(r, 'e2')) || norm(cell(r, 'e3')) || norm(cell(r, 'e4'));
      const salida = norm(cell(r, 's4')) || norm(cell(r, 's3')) || norm(cell(r, 's2')) || norm(cell(r, 's1'));
      let estado;
      if (marcaCompleta && hsNormal === 0) estado = 'no-laborable';   // sábado/domingo/feriado: todo a favor
      else if (marcaCompleta) estado = 'ok';
      else estado = 'revisar';                                        // marca incompleta
      a.dias.push({
        fecha,
        dia: norm(cell(r, 'dia')),
        entrada, salida,
        hsNetasMin: hsNetas,
        hsNormalMin: hsNormal,
        saldoMin: marcaCompleta ? (hsNetas - hsNormal) : null,
        extra50Min: e50,
        extra100Min: e100,
        extraComputa: extraDiaMin >= UMBRAL_EXTRA_MIN,
        tardeMin: tarde,
        completa: marcaCompleta,
        estado,
      });
    }
  }

  return { porLegajo: acc, filas, legajos: Object.keys(acc).length, columnasFaltantes: faltantes };
}
