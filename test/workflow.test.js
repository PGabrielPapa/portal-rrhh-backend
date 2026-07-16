// Tests del motor de workflows de aprobación multinivel (funciones puras).
// Correr con: node test/workflow.test.js
import assert from 'node:assert/strict';
import { ordenarPasos, pasoActual, puedeResolver, resultadoDecision } from '../src/lib/workflowEngine.js';

let ok = 0, fail = 0;
function test(nombre, fn) { try { fn(); ok++; console.log('  ✓ ' + nombre); } catch (e) { fail++; console.log('  ✗ ' + nombre + '\n     ' + e.message); } }

console.log('\nMotor de workflows');

const pasos2 = [
  { orden: 1, rol: 'manager', etiqueta: 'Responsable', obligatorio: true },
  { orden: 2, rol: 'rrhh', etiqueta: 'RR.HH.', obligatorio: true },
];

test('ordenarPasos ordena por orden y tolera vacío', () => {
  assert.deepEqual(ordenarPasos([{ orden: 3 }, { orden: 1 }, { orden: 2 }]).map(p => p.orden), [1, 2, 3]);
  assert.deepEqual(ordenarPasos(null), []);
  assert.deepEqual(ordenarPasos(undefined), []);
});

test('pasoActual: primer paso sin aprobar', () => {
  assert.equal(pasoActual(pasos2, []).orden, 1);
  assert.equal(pasoActual(pasos2, [{ orden: 1, decision: 'aprobado' }]).orden, 2);
  assert.equal(pasoActual(pasos2, [{ orden: 1, decision: 'aprobado' }, { orden: 2, decision: 'aprobado' }]), null);
});

test('pasoActual: un rechazo NO cuenta como resuelto favorable', () => {
  // si el paso 1 fue rechazado, sigue siendo el actual (el circuito real ya cortó,
  // pero la función pura debe seguir señalándolo como no aprobado)
  assert.equal(pasoActual(pasos2, [{ orden: 1, decision: 'rechazado' }]).orden, 1);
});

test('puedeResolver: admin siempre puede', () => {
  assert.equal(puedeResolver(pasos2[1], { role: 'admin' }), true);
});

test('puedeResolver: por rol', () => {
  assert.equal(puedeResolver(pasos2[1], { role: 'rrhh' }), true);
  assert.equal(puedeResolver(pasos2[1], { role: 'employee' }), false);
});

test('puedeResolver: manager necesita al empleado en su equipo', () => {
  assert.equal(puedeResolver(pasos2[0], { role: 'manager' }, { enEquipo: true }), true);
  assert.equal(puedeResolver(pasos2[0], { role: 'manager' }, { enEquipo: false }), false);
});

test('puedeResolver: por puesto (tiene prioridad sobre rol)', () => {
  const paso = { orden: 1, rol: 'manager', puesto: 7 };
  assert.equal(puedeResolver(paso, { role: 'rrhh', puestoId: 7 }), true);
  assert.equal(puedeResolver(paso, { role: 'rrhh', puestoId: 9 }), false);
  assert.equal(puedeResolver(paso, { role: 'manager', puestoId: 9 }, { enEquipo: true }), false); // el puesto manda
  assert.equal(puedeResolver(paso, { role: 'admin', puestoId: 99 }), true); // admin override
});

test('resultadoDecision: rechazo corta el circuito', () => {
  assert.deepEqual(resultadoDecision(pasos2, [], pasos2[0], 'rechazado'), { estado: 'rechazado' });
});

test('resultadoDecision: aprobar paso 1 deja pendiente el paso 2', () => {
  const r = resultadoDecision(pasos2, [], pasos2[0], 'aprobado');
  assert.equal(r.estado, 'pendiente');
  assert.equal(r.siguiente.orden, 2);
});

test('resultadoDecision: aprobar el último paso obligatorio cierra como aprobado', () => {
  const aprob = [{ orden: 1, decision: 'aprobado' }];
  const r = resultadoDecision(pasos2, aprob, pasos2[1], 'aprobado');
  assert.equal(r.estado, 'aprobado');
});

test('resultadoDecision: los pasos opcionales no bloquean el cierre', () => {
  const pasos = [
    { orden: 1, rol: 'manager', obligatorio: true },
    { orden: 2, rol: 'rrhh', obligatorio: false }, // opcional
  ];
  const r = resultadoDecision(pasos, [], pasos[0], 'aprobado');
  assert.equal(r.estado, 'aprobado'); // no queda pendiente por el opcional
});

console.log(`\nRESULTADO workflows: ${ok} OK, ${fail} fallidos`);
process.exit(fail ? 1 : 0);
