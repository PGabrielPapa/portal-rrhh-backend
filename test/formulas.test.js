// Tests del evaluador de fórmulas de conceptos (motor de fórmulas — brecha #6).
// Correr con: node test/formulas.test.js
import assert from 'node:assert/strict';
import { evaluarFormula, analizarFormula, expandirMacros } from '../src/lib/formulas.js';

let ok = 0, fail = 0;
function test(nombre, fn) { try { fn(); ok++; console.log('  ✓ ' + nombre); } catch (e) { fail++; console.log('  ✗ ' + nombre + '\n     ' + e.message); } }
const ev = (e, c) => evaluarFormula(e, c);

console.log('\nMotor de fórmulas');

test('aritmética básica y precedencia', () => {
  assert.equal(ev('2 + 3 * 4'), 14);
  assert.equal(ev('(2 + 3) * 4'), 20);
  assert.equal(ev('10 / 4'), 2.5);
  assert.equal(ev('-5 + 2'), -3);
});

test('variables del contexto (case-insensitive)', () => {
  assert.equal(ev('basico * 0.1', { basico: 1000 }), 100);
  assert.equal(ev('BASICO + antiguedad', { basico: 1000, antiguedad: 250 }), 1250);
  assert.equal(ev('Remun * 0.5', { remun: 200 }), 100);
});

test('variable inexistente = 0 (tolerante) y error (estricto)', () => {
  assert.equal(ev('sueldo + noexiste', { sueldo: 100 }), 100);
  assert.throws(() => evaluarFormula('sueldo + noexiste', { sueldo: 100 }, { strict: true }), /desconocida/);
});

test('funciones SI / MIN / MAX / REDONDEAR / ABS', () => {
  assert.equal(ev('SI(antiguedad > 5, 1000, 500)', { antiguedad: 6 }), 1000);
  assert.equal(ev('SI(antiguedad > 5, 1000, 500)', { antiguedad: 3 }), 500);
  assert.equal(ev('MIN(100, 50, 80)'), 50);
  assert.equal(ev('MAX(basico, 900)', { basico: 1200 }), 1200);
  assert.equal(ev('REDONDEAR(10 / 3, 2)'), 3.33);
  assert.equal(ev('ABS(0 - 7)'), 7);
});

test('comparaciones y lógicos devuelven 1/0', () => {
  assert.equal(ev('5 > 3'), 1);
  assert.equal(ev('5 < 3'), 0);
  assert.equal(ev('(1 == 1) && (2 == 2)'), 1);
  assert.equal(ev('(1 == 2) || (3 == 3)'), 1);
});

test('caso real: presentismo condicional', () => {
  // 10% del básico si no tuvo ausencias, si no 0
  const f = 'SI(ausencias == 0, basico * 0.10, 0)';
  assert.equal(ev(f, { basico: 500000, ausencias: 0 }), 50000);
  assert.equal(ev(f, { basico: 500000, ausencias: 2 }), 0);
});

test('caso real: adicional por título topeado', () => {
  const f = 'MIN(basico * 0.20, 80000)';
  assert.equal(ev(f, { basico: 300000 }), 60000);
  assert.equal(ev(f, { basico: 500000 }), 80000);
});

test('división por cero = 0 (no rompe la liquidación)', () => {
  assert.equal(ev('basico / cero', { basico: 100, cero: 0 }), 0);
});

test('redondeo a 2 decimales por defecto', () => {
  assert.equal(ev('100 / 3'), 33.33);
});

test('analizarFormula devuelve variables y funciones usadas', () => {
  const r = analizarFormula('SI(antiguedad > 5, basico * 0.1, MIN(otro, 10))');
  assert.deepEqual(r.variables.sort(), ['antiguedad', 'basico', 'otro']);
  assert.deepEqual(r.funciones.sort(), ['MIN', 'SI']);
});

test('errores de sintaxis claros', () => {
  assert.throws(() => evaluarFormula('2 +'), /incompleta/);
  assert.throws(() => evaluarFormula('2 ** 3'), /./); // ** no soportado
  assert.throws(() => evaluarFormula('basico $ 2'), /no permitido/);
  assert.throws(() => evaluarFormula('(2 + 3'), /esperaba/);
});

test('seguridad: no ejecuta JS', () => {
  assert.throws(() => evaluarFormula('process.exit(1)'), /./);       // sintaxis inválida
  assert.equal(evaluarFormula('constructor'), 0);                    // se trata como variable vacía, no como objeto JS
  assert.equal(evaluarFormula('basico', { basico: 5, __proto__: 9 }), 5);
});

test('matriz por tramos: TRAMO("plusAntig", anios)', () => {
  const aux = { matrices: { plusAntig: [{ hasta: 5, valor: 1000 }, { hasta: 10, valor: 2000 }, { hasta: 9999, valor: 3000 }] } };
  assert.equal(evaluarFormula('TRAMO("plusAntig", anios)', { anios: 3, __aux: aux }), 1000);
  assert.equal(evaluarFormula('TRAMO("plusAntig", anios)', { anios: 7, __aux: aux }), 2000);
  assert.equal(evaluarFormula('TRAMO("plusAntig", anios)', { anios: 25, __aux: aux }), 3000);
});

test('tabla clave→valor: TABLA("premios", zona)', () => {
  const aux = { tablas: { premios: { norte: 5000, sur: 8000 } } };
  assert.equal(evaluarFormula('TABLA("premios", "sur")', { __aux: aux }), 8000);
  assert.equal(evaluarFormula('TABLA("premios", "otra")', { __aux: aux }), 0);
});

test('variables Macro: expansión y evaluación', () => {
  const macros = { baseCalc: 'basico + antiguedad_monto' };
  assert.equal(expandirMacros('baseCalc * 0.1', macros).replace(/\s/g, ''), '(basico+antiguedad_monto)*0.1');
  assert.equal(evaluarFormula('baseCalc * 0.1', { basico: 1000, antiguedad_monto: 500 }, { macros }), 150);
});

test('macros anidadas', () => {
  const macros = { rem: 'basico + plus', plus: 'basico * 0.2' };
  assert.equal(evaluarFormula('rem', { basico: 1000 }, { macros }), 1200);
});

console.log(`\nRESULTADO fórmulas: ${ok} OK, ${fail} fallidos`);
if (fail) process.exit(1);
