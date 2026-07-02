// ── Topes de deducciones del SiRADIG según RG 4003 / Manual F.1359 + Manual del Desarrollador SiRADIG (ARCA) ──
// Las deducciones se computan sobre el ACUMULADO del período fiscal y con los topes
// de la Tabla 4 (valores ANUALES) prorrateados por los meses transcurridos (o fijos, según modo).
// Todo es configurable: los valores por defecto se pueden pisar desde Parámetros de Ganancias.

// Tabla 4 (topes) — valores ANUALES 2026 (Manual F.1359 v2.0, confeccionada 04/05/2026).
export const TABLA4_DEFAULT = {
  gni: 5151802.50,          // Ganancia No Imponible (tope: personal doméstico y alquiler inquilino 40%)
  gni40: 2060721.00,        // 40% GNI (tope alquiler casa-habitación inc. h / educación)
  seguroMuerte: 753472.14,  // Seguros muerte/mixtos + FCI con fines de retiro (tope CONJUNTO)
  seguroRetiro: 753472.14,  // Seguros de retiro privados (SSN)
  hipotecario: 20000.00,    // Intereses préstamo hipotecario
  sepelio: 996.23,          // Gastos de sepelio
  pctNeta: 0.05,            // 5% de la ganancia neta (cuota médico + donaciones + honorarios)
  modo: 'MENSUAL_PRORRATEADO', // 'FIJO_PERIODO' = tope anual fijo todos los meses · 'MENSUAL_PRORRATEADO' = tope anual / 12 * meses
};

// Conceptos internos y su regla de tope.
//  regla: 'sin_tope' | 'fijo' (usa key de Tabla 4) | 'tope_gni' | 'tope_40gni' | 'pct_neta_5'
//  bucket: agrupa varios conceptos bajo un mismo tope conjunto
//  factor: porcentaje deducible sobre lo declarado antes del tope (ej. honorarios médicos 40%)
export const CONCEPTOS = {
  // Sujetos al 5% de la ganancia neta (tope conjunto)
  cuota_medico_asist:    { label: 'Cuota médico-asistencial', regla: 'pct_neta_5', bucket: '5pct' },
  donaciones:            { label: 'Donaciones', regla: 'pct_neta_5', bucket: '5pct' },
  honorarios_medicos:    { label: 'Gastos médicos y paramédicos (40%)', regla: 'pct_neta_5', bucket: '5pct', factor: 0.40 },
  // Topes fijos de Tabla 4
  prima_seguro_muerte:   { label: 'Primas de seguro para caso de muerte', regla: 'fijo', key: 'seguroMuerte', bucket: 'seguro' },
  seguro_mixto_fci:      { label: 'Primas de ahorro / seguros mixtos', regla: 'fijo', key: 'seguroMuerte', bucket: 'seguro' },
  fci_retiro:            { label: 'Cuotapartes FCI con fines de retiro', regla: 'fijo', key: 'seguroMuerte', bucket: 'seguro' },
  seguro_retiro:         { label: 'Planes de seguro de retiro privados', regla: 'fijo', key: 'seguroRetiro' },
  gastos_sepelio:        { label: 'Gastos de sepelio', regla: 'fijo', key: 'sepelio' },
  intereses_hipotecarios:{ label: 'Intereses préstamo hipotecario', regla: 'fijo', key: 'hipotecario' },
  // Topes ligados a la GNI
  servicio_domestico:    { label: 'Personal doméstico', regla: 'tope_gni' },
  servicios_educativos:  { label: 'Gastos de educación', regla: 'tope_40gni' }, // tope "según Tabla 4" — 40% GNI (a confirmar con asesor)
  // Alquiler de casa-habitación (inquilino): 40% de lo pagado con TOPE = Ganancia No Imponible
  // (art. 85 inc. h Ley de Ganancias / RG 4003; el monto del SiRADIG ya es el 40% deducible).
  alquiler_h_40:         { label: 'Alquiler casa habitación (inquilino 40%)', regla: 'tope_gni' },
  // Deducción adicional del 10% del alquiler (RG 5521): sin tope.
  alquiler_10:           { label: 'Alquiler casa habitación (inquilino 10%)', regla: 'sin_tope' },
  alquiler_propietario:  { label: 'Alquiler casa habitación (propietario)', regla: 'sin_tope' },
  // Conceptos especiales (sin tope porcentual; se computan según lo declarado/validado)
  sgr:                   { label: 'Aporte a Sociedades de Garantía Recíproca', regla: 'sin_tope' },
  corredores:            { label: 'Corredores y viajantes (vehículo/gastos)', regla: 'sin_tope' },
  indumentaria:          { label: 'Indumentaria y equipamiento de trabajo', regla: 'sin_tope' },
  otras:                 { label: 'Otras deducciones (Tabla 5)', regla: 'sin_tope' },
};

// Mapa código tipo="N" del XML SiRADIG -> concepto interno (Tabla 4, Manual del Desarrollador SiRADIG v1.24).
export const MAPA_TIPOS_DEFAULT = {
  1: 'cuota_medico_asist',
  2: 'prima_seguro_muerte',
  3: 'donaciones',
  4: 'intereses_hipotecarios',
  5: 'gastos_sepelio',
  7: 'honorarios_medicos',
  8: 'servicio_domestico',
  9: 'sgr',
  10: 'corredores',
  11: 'corredores',
  21: 'indumentaria',
  22: 'alquiler_h_40',
  23: 'seguro_mixto_fci',
  24: 'seguro_retiro',
  25: 'fci_retiro',
  32: 'servicios_educativos',
  33: 'alquiler_10',
  34: 'alquiler_propietario',
  99: 'otras',
};

// Deriva cónyuge / hijos / hijos incapacitados desde las cargas DECLARADAS en el SiRADIG (F.572).
// Solo cuentan las cargas efectivamente declaradas (no la tabla `familiares`). Respeta el % de
// deducción (custodia compartida) y el mes de inicio. Bajo la ley vigente solo son deducibles
// cónyuge/unión convivencial e hijos (comunes e incapacitados); otros parentescos no computan.
const CONYUGE_CODES_SIR = new Set(['1', '51']);
const HIJO_CODES_SIR = new Set(['3', '30', '103']);
const HIJO_INC_CODES_SIR = new Set(['31', '32']);
export function cargasDesdeSiradig(cargas, mes = 12) {
  let tieneConyuge = false, nHijos = 0, nHijosInc = 0;
  const m = Number(mes) || 12;
  for (const c of (Array.isArray(cargas) ? cargas : [])) {
    const code = String(c.parentesco || '').trim();
    if ((Number(c.mesDesde) || 1) > m) continue;
    const pRaw = Number(String(c.porcentajeDeduccion || '').replace(',', '.'));
    const pct = pRaw > 0 ? pRaw / 100 : 1;
    if (CONYUGE_CODES_SIR.has(code)) tieneConyuge = true;
    else if (HIJO_INC_CODES_SIR.has(code)) nHijosInc += pct;
    else if (HIJO_CODES_SIR.has(code)) nHijos += pct;
  }
  return { tieneConyuge, nHijos, nHijosInc };
}

// Tabla 3 (parentesco) del Manual del Desarrollador SiRADIG — para mostrar cargas de familia.
export const PARENTESCO = {
  1: 'Cónyuge', 3: 'Hijo/a', 30: 'Hijastro/a', 31: 'Hijo/a incapacitado', 32: 'Hijastro/a incapacitado',
  33: 'Padre', 34: 'Madre', 35: 'Nieto/a', 36: 'Nieto/a incapacitado', 39: 'Abuelo/a',
  41: 'Padrastro/Madrastra', 42: 'Hermano/a', 43: 'Hermano/a incapacitado', 44: 'Suegro/a',
  51: 'Unión convivencial', 103: 'Hijo/a 18-24 (educación)',
};

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const num = (v) => { const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : 0; };

// Acumulado declarado de una deducción hasta el mes indicado (suma montoMensual de meses 1..mes).
function declaradoAcum(ded, mes, anualizada) {
  let t = 0;
  for (const p of (ded.periodos || [])) {
    const md = Number(p.mesDesde) || 0, mh = Number(p.mesHasta) || md, mm = num(p.montoMensual);
    const desde = Math.max(1, md), hasta = anualizada ? Math.min(12, mh) : Math.min(Number(mes), mh);
    for (let m = desde; m <= hasta; m++) if (m >= 1 && m <= 12) t += mm;
  }
  return round2(t);
}

// Calcula la deducción COMPUTABLE (post-tope) del SiRADIG sobre el acumulado fiscal.
export function calcularDeduccionesSiradig({ deducciones = [], mes = 12, anualizada = false, gravadoTotal = 0, aportesTotal = 0, topes, mapaTipos } = {}) {
  const T = { ...TABLA4_DEFAULT, ...(topes || {}) };
  const MAP = { ...MAPA_TIPOS_DEFAULT, ...(mapaTipos || {}) };
  const prop = anualizada ? 1 : Math.min(1, Math.max(0, Number(mes) / 12));
  const capMult = (anualizada || T.modo === 'FIJO_PERIODO') ? 1 : prop;
  const factorDe = (concepto) => (CONCEPTOS[concepto] && CONCEPTOS[concepto].factor) ? CONCEPTOS[concepto].factor : 1;

  // 1) Acumular declarado por concepto (base = declarado * factor)
  const porConcepto = {};
  const detalle = [];
  for (const d of deducciones) {
    const tipo = String(d.tipo);
    const concepto = MAP[tipo] || MAP[Number(tipo)] || null;
    const dec = declaradoAcum(d, mes, anualizada);
    const fila = { tipo, concepto, conceptoLabel: concepto ? (CONCEPTOS[concepto].label || concepto) : null, factor: concepto ? factorDe(concepto) : 1, declarado: dec, computable: 0, tope: null, clasificado: !!concepto };
    detalle.push(fila);
    if (!concepto) continue;
    if (!porConcepto[concepto]) porConcepto[concepto] = { declarado: 0, base: 0, filas: [] };
    porConcepto[concepto].declarado += dec;
    porConcepto[concepto].base += round2(dec * factorDe(concepto));
    porConcepto[concepto].filas.push(fila);
  }

  const repartir = (filas, baseTotal, comp, cap) => {
    for (const f of filas) {
      const bf = round2(f.declarado * (f.factor || 1));
      f.tope = (cap == null) ? null : round2(cap);
      f.computable = baseTotal > 0 ? round2(comp * (bf / baseTotal)) : 0;
    }
  };

  // 2) Topes fijos / GNI (no dependen del 5%)
  const buckets = {};
  let otrasGenerales = 0;
  for (const concepto of Object.keys(porConcepto)) {
    const info = porConcepto[concepto];
    const c = CONCEPTOS[concepto]; if (!c) continue;
    if (c.regla === 'pct_neta_5') continue;
    let comp = 0;
    if (c.regla === 'sin_tope') { comp = info.base; repartir(info.filas, info.base, comp, null); }
    else if (c.regla === 'tope_gni') { const cap = round2(T.gni * capMult); comp = round2(Math.min(info.base, cap)); repartir(info.filas, info.base, comp, cap); }
    else if (c.regla === 'tope_40gni') { const cap = round2(T.gni40 * capMult); comp = round2(Math.min(info.base, cap)); repartir(info.filas, info.base, comp, cap); }
    else if (c.regla === 'fijo') {
      if (c.bucket) { if (!buckets[c.bucket]) buckets[c.bucket] = { cap: round2(T[c.key] * capMult), base: 0, filas: [] }; buckets[c.bucket].base += info.base; buckets[c.bucket].filas.push(...info.filas); continue; }
      const cap = round2(T[c.key] * capMult); comp = round2(Math.min(info.base, cap)); repartir(info.filas, info.base, comp, cap);
    }
    otrasGenerales += comp;
  }
  for (const b of Object.values(buckets)) {
    const comp = round2(Math.min(b.base, b.cap));
    repartir(b.filas, b.base, comp, b.cap);
    otrasGenerales += comp;
  }

  // 3) Tope del 5% de la ganancia neta (cuota médico + donaciones + honorarios, conjunto)
  const gananciaNeta = round2(Math.max(0, num(gravadoTotal) - num(aportesTotal) - otrasGenerales));
  const cap5 = round2(gananciaNeta * T.pctNeta);
  let base5 = 0; const filas5 = [];
  for (const concepto of Object.keys(porConcepto)) {
    if (!CONCEPTOS[concepto] || CONCEPTOS[concepto].regla !== 'pct_neta_5') continue;
    base5 += porConcepto[concepto].base; filas5.push(...porConcepto[concepto].filas);
  }
  const comp5 = round2(Math.min(base5, cap5));
  repartir(filas5, base5, comp5, cap5);

  const totalDeclarado = round2(detalle.reduce((a, f) => a + f.declarado, 0));
  const totalComputable = round2(otrasGenerales + comp5);
  const sinClasificar = detalle.filter((f) => !f.clasificado).length;
  return { prop, gananciaNeta, cap5, totalDeclarado, totalComputable, sinClasificar, detalle };
}
