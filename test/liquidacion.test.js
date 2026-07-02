// Suite de tests del motor de liquidación (sin dependencias externas).
// Correr con: npm test   (o: node test/liquidacion.test.js)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { calcularRecibo, calcularGananciasAcum } from '../src/lib/liquidacion.js';
import { calcularDeduccionesSiradig } from '../src/lib/siradigTopes.js';
import { sumarAcumulador, recibosDeVentana, DEFAULTS as ACUM_DEFAULTS } from '../src/lib/acumuladores.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const P = JSON.parse(fs.readFileSync(path.join(__dirname, '../src/data/params.seed.json'), 'utf8'));
const empBase = { legNum: '1', nom: 'TEST', empresa: 'X', cuil: '20111111119', ingreso: '2018-01-01', bruto: 1000000, data: {} };

let ok = 0, fail = 0;
function test(nombre, fn) { try { fn(); ok++; console.log('  ✓ ' + nombre); } catch (e) { fail++; console.log('  ✗ ' + nombre + '\n      ' + e.message); } }
const aporte = (rec, re) => (rec.descuentos || []).filter((d) => re.test(d.concepto)).reduce((a, d) => a + d.monto, 0);

console.log('Motor de liquidación');

test('aportes personales = 17% (sin tope)', () => {
  const r = calcularRecibo(empBase, P, { anio: 2026, mes: 6, tipo: 'mensual', calcularGanancias: false });
  const ap = aporte(r, /Jubilaci|Obra Social|ANSSAL|INSSJP/);
  assert.equal(Math.round(ap), Math.round(r.totales.totalRemun * 0.17));
  assert.ok(!r.descuentos.some((d) => /ANSSAL/.test(d.concepto)), 'no debe haber línea ANSSAL extra');
});

test('tope base SIPA aplicado a sueldos altos', () => {
  const p = { ...P, topeAportesMax: 4414652.38 };
  const r = calcularRecibo({ ...empBase, bruto: 8000000 }, p, { anio: 2026, mes: 6, tipo: 'mensual', calcularGanancias: false });
  const jub = aporte(r, /Jubilación/);
  assert.equal(Math.round(jub), Math.round(4414652.38 * 0.11));
});

test('neto nunca negativo: piso en cero + ajuste a recuperar', () => {
  const r = calcularRecibo(empBase, P, { anio: 2026, mes: 6, tipo: 'mensual', calcularGanancias: false, otrosDesc: 1500000, otrosDescLabel: 'Desc extraordinario' });
  assert.equal(r.totales.neto, 0);
  assert.ok(r.detalle.ajusteNetoNegativo > 0);
  assert.ok(r.haberes.some((h) => /Ajuste de sueldo no remunerativo/.test(h.concepto)));
});

test('recupero del ajuste en el período siguiente', () => {
  const r = calcularRecibo(empBase, P, { anio: 2026, mes: 7, tipo: 'mensual', calcularGanancias: false, ajusteNetoRecuperar: 200000 });
  assert.ok(r.descuentos.some((d) => /Recupero ajuste de sueldo/.test(d.concepto)));
});

test('fondo de cese: contribución mensual + Art.245 cubierto en el final', () => {
  const p = { ...P, fondoCesePct: 8, modoIndemnizacion: 'fondo_cese' };
  const m = calcularRecibo(empBase, p, { anio: 2026, mes: 6, tipo: 'mensual', calcularGanancias: false });
  assert.ok(m.costoEmpleador.contribuciones.some((c) => /Fondo de cese/.test(c.concepto)));
  const f = calcularRecibo(empBase, p, { anio: 2026, mes: 6, tipo: 'final', calcularGanancias: false, fechaEgreso: '2026-06-20', motivoBaja: 'sin_causa' });
  assert.ok(!f.haberes.some((h) => /Art\. 245/.test(h.concepto)), 'no debe pagar Art.245 con fondo de cese');
  assert.ok(f.detalle.notaFondoCese);
});

test('embargo con tope legal (20% sobre excedente SMVM)', () => {
  const p = { ...P, smvm: 367800 };
  const r = calcularRecibo(empBase, p, { anio: 2026, mes: 6, tipo: 'mensual', calcularGanancias: false, embargo: 9999999, smvm: 367800 });
  const emb = (r.descuentos.find((d) => /Embargo judicial/.test(d.concepto)) || {}).monto || 0;
  assert.ok(emb > 0 && emb < 9999999, 'el embargo debe quedar topeado');
});

test('SAC = 50% de la mejor remuneración del semestre', () => {
  const r = calcularRecibo(empBase, P, { anio: 2026, mes: 6, tipo: 'sac1', calcularGanancias: false, mejorRemSAC: 1200000 });
  const sac = (r.haberes.find((h) => /SAC/.test(h.concepto)) || {}).monto || 0;
  assert.equal(sac, 600000);
});

console.log('\nSiRADIG (topes RG 4003)');
test('honorarios médicos: 40% y tope 5% de ganancia neta', () => {
  const med = [{ tipo: '7', periodos: [{ mesDesde: 1, mesHasta: 6, montoMensual: 1000000 }] }];
  const r = calcularDeduccionesSiradig({ deducciones: med, mes: 6, gravadoTotal: 30000000, aportesTotal: 5100000 });
  assert.equal(r.cap5, Math.round((30000000 - 5100000) * 0.05 * 100) / 100);
  assert.ok(r.totalComputable <= r.cap5 + 0.01);
});
test('hipotecario topeado a valor fijo (20.000 anual prorrateado)', () => {
  const hip = [{ tipo: '4', periodos: [{ mesDesde: 1, mesHasta: 6, montoMensual: 100000 }] }];
  const r = calcularDeduccionesSiradig({ deducciones: hip, mes: 6, gravadoTotal: 20000000, aportesTotal: 3400000 });
  assert.equal(r.detalle[0].computable, 10000); // 20000 * 6/12
});
test('alquiler inquilino 40% topeado a la Ganancia No Imponible', () => {
  // declara 600.000/mes ene-jun => 3.600.000 acumulado a junio; tope = GNI*6/12 = 2.575.901,25
  const alq = [{ tipo: '22', periodos: [{ mesDesde: 1, mesHasta: 6, montoMensual: 600000 }] }];
  const r = calcularDeduccionesSiradig({ deducciones: alq, mes: 6, gravadoTotal: 40000000, aportesTotal: 6800000 });
  assert.equal(r.detalle[0].concepto, 'alquiler_h_40');
  assert.equal(r.detalle[0].computable, 2575901.25); // topeado a GNI prorrateada
});
test('tipo sin clasificar no se deduce', () => {
  const x = [{ tipo: '999', periodos: [{ mesDesde: 1, mesHasta: 6, montoMensual: 50000 }] }];
  const r = calcularDeduccionesSiradig({ deducciones: x, mes: 6, gravadoTotal: 20000000, aportesTotal: 3400000 });
  assert.equal(r.totalComputable, 0);
  assert.equal(r.sinClasificar, 1);
});

console.log('\nAcumuladores');
test('NETO = haberes − descuentos (con signos)', () => {
  const recs = [{ mes: 6, data: { haberes: [{ concepto: 'Sueldo', tipo: 'rem', monto: 1000000 }], descuentos: [{ concepto: 'Jubilación', tipo: 'aporte', monto: 110000 }] } }];
  const neto = ACUM_DEFAULTS.find((a) => a.codigo === 'NETO');
  assert.equal(sumarAcumulador(recibosDeVentana(recs, 'MENSUAL', 6), neto.reglas), 890000);
});
test('acumulado anual fiscal suma enero..mes', () => {
  const recs = [
    { mes: 1, data: { descuentos: [{ concepto: 'Jubilación', monto: 100000 }] } },
    { mes: 2, data: { descuentos: [{ concepto: 'Jubilación', monto: 110000 }] } },
  ];
  const jub = ACUM_DEFAULTS.find((a) => a.codigo === 'JUBILACION');
  assert.equal(sumarAcumulador(recibosDeVentana(recs, 'ANUAL_FISCAL', 2), jub.reglas), 210000);
});

console.log(`\nRESULTADO: ${ok} OK, ${fail} fallidos`);
process.exit(fail ? 1 : 0);
