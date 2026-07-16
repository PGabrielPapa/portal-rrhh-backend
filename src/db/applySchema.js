// Aplica el schema.sql de forma resiliente: divide en sentencias (respetando los
// bloques con comillas y $$…$$ de las funciones de trigger) y corre cada una por
// separado. Así, si una sentencia falla, NO aborta a las demás (el esquema es
// idempotente con IF NOT EXISTS) y se registra exactamente cuál falló.
export function dividirSQL(sql) {
  const out = [];
  let buf = '';
  let i = 0;
  let inSingle = false;      // dentro de '...'
  let dollarTag = null;      // dentro de $tag$...$tag$
  while (i < sql.length) {
    const c = sql[i];
    const two = sql.slice(i, i + 2);
    if (dollarTag) {
      if (sql.startsWith(dollarTag, i)) { buf += dollarTag; i += dollarTag.length; dollarTag = null; continue; }
      buf += c; i++; continue;
    }
    if (inSingle) {
      buf += c;
      if (c === "'") { if (sql[i + 1] === "'") { buf += "'"; i += 2; continue; } inSingle = false; }
      i++; continue;
    }
    if (two === '--') { const nl = sql.indexOf('\n', i); const end = nl === -1 ? sql.length : nl; buf += sql.slice(i, end); i = end; continue; }
    if (c === "'") { inSingle = true; buf += c; i++; continue; }
    if (c === '$') { const m = sql.slice(i).match(/^\$[A-Za-z0-9_]*\$/); if (m) { dollarTag = m[0]; buf += m[0]; i += m[0].length; continue; } }
    if (c === ';') { const s = buf.trim(); if (s) out.push(s); buf = ''; i++; continue; }
    buf += c; i++;
  }
  const last = buf.trim(); if (last) out.push(last);
  return out;
}

// Aplica todas las sentencias en varias pasadas: si una falla por depender de otra
// que todavía no se creó (orden en el archivo), la reintenta en la pasada siguiente.
// Sigue hasta que una pasada no logra ningún avance nuevo. Devuelve sólo los errores
// que persisten al final (errores reales, no de orden).
export async function aplicarSchema(pool, sql) {
  const stmts = dividirSQL(sql);
  let pendientes = stmts.map((s, idx) => ({ sql: s, idx }));
  const ultimoError = new Map(); // idx -> mensaje
  const MAX_PASADAS = 4;
  for (let pasada = 0; pasada < MAX_PASADAS && pendientes.length; pasada++) {
    const fallaron = [];
    for (const st of pendientes) {
      try { await pool.query(st.sql); }
      catch (e) { ultimoError.set(st.idx, e.message); fallaron.push(st); }
    }
    if (fallaron.length === pendientes.length) { pendientes = fallaron; break; } // sin avance → cortar
    pendientes = fallaron;
  }
  const errores = pendientes.map((st) => ({
    error: ultimoError.get(st.idx) || 'desconocido',
    sql: st.sql.slice(0, 160).replace(/\s+/g, ' '),
  }));
  return { total: stmts.length, ok: stmts.length - errores.length, errores };
}
