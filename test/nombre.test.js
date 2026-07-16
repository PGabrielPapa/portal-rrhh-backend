// Tests del separador de nombre (APELLIDO, NOMBRE) usado en el generador de reportes.
import assert from 'node:assert/strict';
import { partirNombre } from '../src/lib/nombre.js';

let ok = 0, fail = 0;
function test(n, fn) { try { fn(); ok++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n     ' + e.message); } }

console.log('\nSeparador de nombre');
test('nombre simple', () => assert.deepEqual(partirNombre('PARERA, MARTIN'), { apellido: 'PARERA', nombre: 'MARTIN' }));
test('apellido compuesto (corta en la 1ª coma)', () => assert.deepEqual(partirNombre('ZABALA CRUZ, LEONARDO GABRIEL'), { apellido: 'ZABALA CRUZ', nombre: 'LEONARDO GABRIEL' }));
test('nombre con varias palabras', () => assert.deepEqual(partirNombre('DI FLORIO, VICENTE ANTONIO'), { apellido: 'DI FLORIO', nombre: 'VICENTE ANTONIO' }));
test('sin coma → todo apellido', () => assert.deepEqual(partirNombre('MADONNA'), { apellido: 'MADONNA', nombre: '' }));
test('espacios sobrantes', () => assert.deepEqual(partirNombre('  GOMEZ ,  ANA  '), { apellido: 'GOMEZ', nombre: 'ANA' }));
test('vacío / nulo', () => { assert.deepEqual(partirNombre(''), { apellido: '', nombre: '' }); assert.deepEqual(partirNombre(null), { apellido: '', nombre: '' }); });
console.log(`\nRESULTADO nombre: ${ok} OK, ${fail} fallidos`);
process.exit(fail ? 1 : 0);
