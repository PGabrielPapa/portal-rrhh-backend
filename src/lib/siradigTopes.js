// ── Topes de deducciones del SiRADIG según RG 4003 / Manual F.1359 (ARCA) ──
// Las deducciones se computan sobre el ACUMULADO del período fiscal y con los topes
// de la Tabla 4 (valores ANUALES) prorrateados por los meses transcurridos.
// Todo es configurable: los valores por defecto se pueden pisar desde Parámetros de Ganancias.

// Tabla 4 — valores ANUALES 2026 (Manual F.1359 v2.0, confeccionada 04/05/2026).
export const TABLA4_DEFAULT = {
  gni: 5151802.50,          // Ganancia No Imponible (tope servicio doméstico)
  gni40: 2060721.00,        // 40% GNI (tope alquiler casa-habitación inc. h)
  seguroMuerte: 753472.14,  // Seguros muerte/mixtos + FCI con fines de retiro (tope CONJUNTO)
  seguroRetiro: 753472.14,  // Seguros de retiro privados (SSN)
  hipotecario: 20000.00,    // Intereses créditos hipotecarios
  sepelio: 996.23,          // Gastos de sepelio
  pctNeta: 0.05,            // 5% de la ganancia neta (cuota médico + donaciones + honorarios)
};

// Conceptos internos y su regla de tope.
//  regla: 'sin_tope' | 'fijo' (usa key de Tabla 4) | 'tope_gni' | 'tope_40gni' | 'pct_neta_5'
//  bucket: agrupa varios conceptos bajo un mismo tope conjunto
export const CONCEPTOS = {
  aportes_jub:           { label: 'Aportes jubilatorios', regla: 'sin_tope' },
  obra_social:           { label: 'Aportes obra social', regla: 'sin_tope' },
  cuota_sindical:        { label: 'Cuotas sindicales', regla: 'sin_tope' },
  cuota_medico_asist:    { label: 'Cuota médico asistencial', regla: 'pct_neta_5', bucket: '5pct' },
  donaciones:            { label: 'Donaciones', regla: 'pct_neta_5', bucket: '5pct' },
  honorarios_medicos:    { label: 'Honorarios médicos/paramédicos', regla: 'pct_neta_5', bucket: '5pct' },
  prima_seguro_muerte:   { label: 'Primas de seguro (muerte)', regla: 'fijo', key: 'seguroMuerte', bucket: 'seguro' },
  seguro_mixto_fci:      { label: 'Seguro mixto / FCI retiro', regla: 'fijo', key: 'seguroMuerte', bucket: 'seguro' },
  seguro_retiro:         { label: 'Seguro de retiro privado', regla: 'fijo', key: 'seguroRetiro' },
  gastos_sepelio:        { label: 'Gastos de sepelio', regla: 'fijo', key: 'sepelio' },
  intereses_hipotecarios:{ label: 'Intereses créditos hipotecarios', regla: 'fijo', key: 'hipotecario' },
  alquiler_h_40:         { label: 'Alquileres casa-habitación (40%)', regla: 'tope_40gni' },
  servicio_domestico:    { label: 'Personal de casas particulares', regla: 'tope_gni' },
  servicios_educativos:  { label: 'Servicios con fines educativos', regla: 'tope_40gni' }, // "según Tabla 4" — a confirmar con asesor
};

// Mapa código tipo="N" del XML SiRADIG -> concepto interno.
// PENDIENTE: el usuario aporta la tabla oficial (Manual del Desarrollador SiRADIG).
// Sólo el 32 está confirmado por el propio XML (descAdicional "Servicios con fines educativos").
// Los no mapeados quedan SIN CLASIFICAR -> no se deducen (se muestran y se marcan para revisar).
export const MAPA_TIPOS_DEFAULT = {
  32: 'servicios_educativos',
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
// params: { deducciones, mes, anualizada, gravadoTotal, aportesTotal, topes, mapaTipos }
// gravadoTotal/aportesTotal = acumulados del período (para la base del 5% de ganancia neta).
export function calcularDeduccionesSiradig({ deducciones = [], mes = 12, anualizada = false, gravadoTotal = 0, aportesTotal = 0, topes, mapaTipos } = {}) {
  const T = { ...TABLA4_DEFAULT, ...(topes || {}) };
  const MAP = { ...MAPA_TIPOS_DEFAULT, ...(mapaTipos || {}) };
  const prop = anualizada ? 1 : Math.min(1, Math.max(0, Number(mes) / 12));

  // 1) Acumular declarado por concepto
  const porConcepto = {}; // concepto -> { declarado, items:[] }
  const detalle = [];
  for (const d of deducciones) {
    const tipo = String(d.tipo);
    const concepto = MAP[tipo] || MAP[Number(tipo)] || null;
    const dec = declaradoAcum(d, mes, anualizada);
    const fila = { tipo, concepto, conceptoLabel: concepto ? (CONCEPTOS[concepto]?.label || concepto) : null, declarado: dec, computable: 0, tope: null, clasificado: !!concepto };
    detalle.push(fila);
    if (!concepto) continue; // sin clasificar -> no se computa
    (porConcepto[concepto] ||= { declarado: 0, filas: [] });
    porConcepto[concepto].declarado += dec;
    porConcepto[concepto].filas.push(fila);
  }

  // 2) Topes que NO dependen del 5% (fijos / GNI), por concepto o por bucket
  const buckets = {}; // bucket -> { cap, declarado, filas }
  const aplicarCap = (concepto, info, cap) => {
    const decl = info.declarado;
    const comp = round2(Math.min(decl, cap));
    // repartir el computable proporcionalmente entre las filas del concepto
    for (const f of info.filas) { f.tope = round2(cap); f.computable = decl > 0 ? round2(comp * (f.declarado / decl)) : 0; }
    return comp;
  };
  let otrasGenerales = 0; // suma de generales computables EXCEPTO las del 5% (para base de ganancia neta)
  for (const [concepto, info] of Object.entries(porConcepto)) {
    const c = CONCEPTOS[concepto]; if (!c) continue;
    if (c.regla === 'pct_neta_5') continue; // se resuelve en el paso 3
    let comp = 0;
    if (c.regla === 'sin_tope') { comp = info.declarado; for (const f of info.filas) { f.tope = null; f.computable = f.declarado; } }
    else if (c.regla === 'tope_gni') comp = aplicarCap(concepto, info, round2(T.gni * prop));
    else if (c.regla === 'tope_40gni') comp = aplicarCap(concepto, info, round2(T.gni40 * prop));
    else if (c.regla === 'fijo') {
      if (c.bucket) { (buckets[c.bucket] ||= { cap: round2(T[c.key] * prop), declarado: 0, filas: [] }); buckets[c.bucket].declarado += info.declarado; buckets[c.bucket].filas.push(...info.filas); continue; }
      comp = aplicarCap(concepto, info, round2(T[c.key] * prop));
    }
    otrasGenerales += comp;
  }
  // buckets fijos conjuntos (ej. seguros muerte/mixtos/FCI)
  for (const b of Object.values(buckets)) {
    const decl = b.declarado, comp = round2(Math.min(decl, b.cap));
    for (const f of b.filas) { f.tope = b.cap; f.computable = decl > 0 ? round2(comp * (f.declarado / decl)) : 0; }
    otrasGenerales += comp;
  }

  // 3) Tope del 5% de la ganancia neta (cuota médico + donaciones + honorarios, conjunto)
  // Ganancia neta = gravado acum − aportes acum − otras deducciones generales computables (excepto estas 3).
  const gananciaNeta = round2(Math.max(0, num(gravadoTotal) - num(aportesTotal) - otrasGenerales));
  const cap5 = round2(gananciaNeta * T.pctNeta);
  let decl5 = 0; const filas5 = [];
  for (const [concepto, info] of Object.entries(porConcepto)) {
    if (CONCEPTOS[concepto]?.regla !== 'pct_neta_5') continue;
    decl5 += info.declarado; filas5.push(...info.filas);
  }
  const comp5 = round2(Math.min(decl5, cap5));
  for (const f of filas5) { f.tope = cap5; f.computable = decl5 > 0 ? round2(comp5 * (f.declarado / decl5)) : 0; }

  const totalDeclarado = round2(detalle.reduce((a, f) => a + f.declarado, 0));
  const totalComputable = round2(otrasGenerales + comp5);
  const sinClasificar = detalle.filter((f) => !f.clasificado).length;
  return { prop, gananciaNeta, cap5, totalDeclarado, totalComputable, sinClasificar, detalle };
}
