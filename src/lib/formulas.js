// Motor de fórmulas de conceptos (réplica de las "fórmulas + variables" de Tango).
// Evaluador SEGURO: NO usa eval() ni Function() sobre texto del usuario. Implementa
// un parser propio (descenso recursivo) que soporta:
//   - números, variables (identificadores), paréntesis, + - * / % y signo unario
//   - comparaciones: > < >= <= == !=  (devuelven 1 o 0)
//   - lógicos: && ||  (también Y / O)
//   - funciones tipo Excel: SI(cond,a,b), MIN, MAX, ABS, REDONDEAR(x[,dec]),
//     ENTERO(x), PISO(x), TECHO(x), MINIMO/MAXIMO (sinónimos)
// Las variables se resuelven contra un contexto (objeto). Nombres NO sensibles a
// mayúsculas. En modo estricto una variable inexistente lanza error (para el editor);
// en modo tolerante vale 0 (para la liquidación).

const round = (n, dec = 2) => { const f = Math.pow(10, dec); return Math.round((Number(n) + Number.EPSILON) * f) / f; };

// Funciones disponibles (nombre en mayúsculas). Cada una recibe números ya evaluados.
const FUNCS = {
  SI: (c, a, b) => (c ? a : b),
  MIN: (...a) => Math.min(...a),
  MAX: (...a) => Math.max(...a),
  MINIMO: (...a) => Math.min(...a),
  MAXIMO: (...a) => Math.max(...a),
  ABS: (x) => Math.abs(x),
  REDONDEAR: (x, dec = 2) => round(x, dec),
  ROUND: (x, dec = 2) => round(x, dec),
  ENTERO: (x) => Math.trunc(x),
  PISO: (x) => Math.floor(x),
  TECHO: (x) => Math.ceil(x),
};
export const FUNCIONES_DISPONIBLES = Object.keys(FUNCS);

// ── Tokenizer ────────────────────────────────────────────────────────────────
function tokenizar(str) {
  const s = String(str || '');
  const toks = [];
  let i = 0;
  const ops2 = ['>=', '<=', '==', '!=', '&&', '||'];
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (c === '"' || c === "'") {
      const q = c; let j = i + 1, str = '';
      while (j < s.length && s[j] !== q) { str += s[j]; j++; }
      if (j >= s.length) throw new Error('Falta cerrar la comilla en el texto');
      toks.push({ t: 'str', v: str }); i = j + 1; continue;
    }
    if (/[0-9.]/.test(c)) {
      let j = i + 1; while (j < s.length && /[0-9.]/.test(s[j])) j++;
      const num = s.slice(i, j);
      if ((num.match(/\./g) || []).length > 1) throw new Error(`Número inválido: "${num}"`);
      toks.push({ t: 'num', v: parseFloat(num) }); i = j; continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1; while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++;
      toks.push({ t: 'id', v: s.slice(i, j) }); i = j; continue;
    }
    const two = s.slice(i, i + 2);
    if (ops2.includes(two)) { toks.push({ t: 'op', v: two }); i += 2; continue; }
    if ('+-*/%()<>,'.includes(c)) { toks.push({ t: 'op', v: c }); i++; continue; }
    throw new Error(`Carácter no permitido: "${c}"`);
  }
  return toks;
}

// ── Parser (descenso recursivo) → AST ────────────────────────────────────────
function parsear(toks) {
  let p = 0;
  const peek = () => toks[p];
  const eat = (v) => { const t = toks[p]; if (!t || (v && t.v !== v)) throw new Error(`Se esperaba "${v}"`); p++; return t; };

  function parseArgs() {
    const args = [];
    if (peek() && peek().v === ')') return args;
    args.push(parseExpr());
    while (peek() && peek().v === ',') { eat(','); args.push(parseExpr()); }
    return args;
  }
  function parsePrimary() {
    const t = peek();
    if (!t) throw new Error('Fórmula incompleta');
    if (t.v === '+' || t.v === '-') { eat(t.v); const node = parsePrimary(); return { k: 'unary', op: t.v, x: node }; }
    if (t.t === 'num') { eat(); return { k: 'num', v: t.v }; }
    if (t.t === 'str') { eat(); return { k: 'str', v: t.v }; }
    if (t.v === '(') { eat('('); const e = parseExpr(); eat(')'); return e; }
    if (t.t === 'id') {
      eat();
      if (peek() && peek().v === '(') { eat('('); const args = parseArgs(); eat(')'); return { k: 'call', name: t.v.toUpperCase(), args }; }
      return { k: 'var', name: t.v };
    }
    throw new Error(`Token inesperado: "${t.v}"`);
  }
  function bin(next, ops) { return () => { let l = next(); while (peek() && peek().t === 'op' && ops.includes(peek().v)) { const op = eat().v; const r = next(); l = { k: 'bin', op, l, r }; } return l; }; }
  const mul = bin(parsePrimary, ['*', '/', '%']);
  const add = bin(mul, ['+', '-']);
  const cmp = bin(add, ['>', '<', '>=', '<=', '==', '!=']);
  const and = bin(cmp, ['&&']);
  const or = bin(and, ['||']);
  function parseExpr() { return or(); }

  const ast = parseExpr();
  if (p !== toks.length) throw new Error(`Sobra "${toks[p].v}" en la fórmula`);
  return ast;
}

// ── Evaluación ───────────────────────────────────────────────────────────────
function ctxGet(ctx, name, strict) {
  if (ctx && Object.prototype.hasOwnProperty.call(ctx, name)) return toNum(ctx[name]);
  const lower = name.toLowerCase();
  for (const k of Object.keys(ctx || {})) if (k.toLowerCase() === lower) return toNum(ctx[k]);
  if (strict) throw new Error(`Variable desconocida: "${name}"`);
  return 0;
}
function toNum(v) { if (v === true) return 1; if (v === false || v == null || v === '') return 0; const n = Number(v); return Number.isFinite(n) ? n : 0; }

function evalNode(node, ctx, strict) {
  switch (node.k) {
    case 'num': return node.v;
    case 'str': return node.v;
    case 'var': return ctxGet(ctx, node.name, strict);
    case 'unary': { const x = toNum(evalNode(node.x, ctx, strict)); return node.op === '-' ? -x : x; }
    case 'call': {
      // Funciones que usan valores auxiliares (matrices/tablas) definidos por el usuario.
      if (node.name === 'TRAMO' || node.name === 'TABLA') {
        const aux = (ctx && ctx.__aux) || {};
        const nombre = String(evalNode(node.args[0], ctx, strict));
        if (node.name === 'TRAMO') {
          const m = (aux.matrices && aux.matrices[nombre]) || null;
          if (!m) { if (strict) throw new Error(`Matriz desconocida: "${nombre}"`); return 0; }
          const x = toNum(evalNode(node.args[1], ctx, strict));
          const tramos = [...m].sort((p, q) => toNum(p.hasta) - toNum(q.hasta));
          for (const tr of tramos) if (x <= toNum(tr.hasta)) return toNum(tr.valor);
          return tramos.length ? toNum(tramos[tramos.length - 1].valor) : 0;
        } else {
          const t = (aux.tablas && aux.tablas[nombre]) || null;
          if (!t) { if (strict) throw new Error(`Tabla desconocida: "${nombre}"`); return 0; }
          const clave = String(evalNode(node.args[1], ctx, strict));
          return toNum(t[clave]);
        }
      }
      const fn = FUNCS[node.name];
      if (!fn) throw new Error(`Función desconocida: "${node.name}"`);
      const args = node.args.map((a) => evalNode(a, ctx, strict));
      return toNum(fn(...args.map((x) => (node.name === 'SI' ? x : toNum(x)))));
    }
    case 'bin': {
      const L = evalNode(node.l, ctx, strict), R = evalNode(node.r, ctx, strict);
      const l = toNum(L), r = toNum(R);
      if (node.op === '==') return (L === R || l === r) ? 1 : 0;
      if (node.op === '!=') return (L === R || l === r) ? 0 : 1;
      switch (node.op) {
        case '+': return l + r; case '-': return l - r; case '*': return l * r;
        case '/': return r === 0 ? 0 : l / r; case '%': return r === 0 ? 0 : l % r;
        case '>': return l > r ? 1 : 0; case '<': return l < r ? 1 : 0;
        case '>=': return l >= r ? 1 : 0; case '<=': return l <= r ? 1 : 0;
        case '&&': return (l && r) ? 1 : 0; case '||': return (l || r) ? 1 : 0;
        default: throw new Error(`Operador desconocido: "${node.op}"`);
      }
    }
    default: throw new Error('Nodo inválido');
  }
}

// Evalúa una fórmula. Devuelve un número. Lanza Error con mensaje claro si algo falla.
// opts.strict=true → variable inexistente lanza error (para el editor "probar fórmula").
// Expande variables "Macro" (fórmulas almacenadas) reemplazando su nombre por (fórmula).
// Soporta anidamiento (hasta 10 pasadas). No toca nombres seguidos de "(" (funciones).
export function expandirMacros(expr, macros) {
  if (!macros || !Object.keys(macros).length) return String(expr);
  const lower = {}; for (const k of Object.keys(macros)) lower[k.toLowerCase()] = macros[k];
  let out = String(expr);
  for (let pass = 0; pass < 10; pass++) {
    let changed = false;
    out = out.replace(/[A-Za-z_][A-Za-z0-9_]*/g, (m, off, str) => {
      const rest = str.slice(off + m.length).replace(/^\s*/, '');
      if (rest.startsWith('(')) return m; // es una función
      const macro = lower[m.toLowerCase()];
      if (macro != null) { changed = true; return '(' + macro + ')'; }
      return m;
    });
    if (!changed) break;
  }
  return out;
}

export function evaluarFormula(expr, ctx = {}, opts = {}) {
  const src = opts.macros ? expandirMacros(expr, opts.macros) : expr;
  const ast = parsear(tokenizar(src));
  return round(evalNode(ast, ctx, !!opts.strict), opts.decimales != null ? opts.decimales : 2);
}

// Valida la sintaxis y devuelve las variables/funciones usadas (para el editor).
export function analizarFormula(expr) {
  const ast = parsear(tokenizar(expr));
  const vars = new Set(), funcs = new Set();
  (function walk(n) {
    if (!n) return;
    if (n.k === 'var') vars.add(n.name);
    if (n.k === 'call') { funcs.add(n.name); n.args.forEach(walk); }
    if (n.k === 'bin') { walk(n.l); walk(n.r); }
    if (n.k === 'unary') walk(n.x);
  })(ast);
  return { ok: true, variables: [...vars], funciones: [...funcs] };
}
