// Suite de tests del motor de liquidación (sin dependencias externas).
// Correr con: npm test   (o: node test/liquidacion.test.js)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { calcularRecibo, calcularGananciasAcum, factorNoHabitual } from '../src/lib/liquidacion.js';
import { calcularDeduccionesSiradig } from '../src/lib/siradigTopes.js';
import { sumarAcumulador, recibosDeVentana, DEFAULTS as ACUM_DEFAULTS } from '../src/lib/acumuladores.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const P = JSON.parse(fs.readFileSync(path.join(__dirname, '../src/data/params.seed.json'), 'utf8'));
const empBase = { legNum: '1', nom: 'TEST', empresa: 'X', cuil: '20111111119', ingreso: '2018-01-01', bruto: 1000000, data: {} };

let ok = 0, fail = 0;
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
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

test('licencia sin goce (art. 78 CCT 130/75): descuenta días y NO hace perder presentismo', () => {
  const base = calcularRecibo(empBase, P, { anio: 2026, mes: 6, tipo: 'mensual', calcularGanancias: false });
  const sg = calcularRecibo(empBase, P, { anio: 2026, mes: 6, tipo: 'mensual', calcularGanancias: false, diasLicenciaSinGoce: 5 });
  const aus = calcularRecibo(empBase, P, { anio: 2026, mes: 6, tipo: 'mensual', calcularGanancias: false, ausenciasInjustificadas: 5 });
  const pres = (rec) => (rec.haberes || []).filter((h) => /presentismo/i.test(h.concepto)).reduce((a, h) => a + h.monto, 0);
  assert.ok(sg.descuentos.some((d) => /sin goce/i.test(d.concepto)), 'debe figurar la línea de licencia sin goce');
  assert.equal(pres(sg), pres(base), 'la licencia sin goce NO hace perder el presentismo');
  assert.ok(sg.totales.neto < base.totales.neto, 'el neto baja por los días sin goce');
  assert.ok(pres(base) === 0 || pres(aus) < pres(base), 'control: las ausencias injustificadas sí afectan el presentismo');
});

test('vacaciones: adiciona el promedio de variables (art. 155 inc. c LCT)', () => {
  const r = calcularRecibo(empBase, P, { anio: 2026, mes: 6, tipo: 'vacaciones', calcularGanancias: false, diasVac: 14, promedioVariablesMes: 250000 });
  const plus = (r.haberes.find((h) => h.concepto.includes('Promedio de variables s/vacaciones')) || {}).monto || 0;
  assert.equal(plus, Math.round((250000 / 25) * 14 * 100) / 100);
});

test('enfermedad: adiciona el promedio de variables por los días de licencia (art. 208 LCT)', () => {
  const r = calcularRecibo(empBase, P, { anio: 2026, mes: 6, tipo: 'mensual', calcularGanancias: false, diasEnfermedad: 6, promedioVariablesMes: 300000 });
  const plus = (r.haberes.find((h) => h.concepto.includes('Promedio de variables s/licencia por enfermedad')) || {}).monto || 0;
  assert.equal(plus, Math.round((300000 / 30) * 6 * 100) / 100);
});

test('detracción de base en contribuciones patronales (Ley 27.541) — solo seguridad social', () => {
  const con = calcularRecibo(empBase, P, { anio: 2026, mes: 6, tipo: 'mensual', calcularGanancias: false });
  const sin = calcularRecibo(empBase, { ...P, detraccionContrib: 0 }, { anio: 2026, mes: 6, tipo: 'mensual', calcularGanancias: false });
  const cont = (rec, re) => (rec.costoEmpleador.contribuciones.find((c) => re.test(c.concepto)) || {}).monto || 0;
  assert.ok(cont(con, /Jubilaci/) < cont(sin, /Jubilaci/), 'SIPA patronal baja con detracción');
  assert.equal(cont(con, /Obra Social patronal/), cont(sin, /Obra Social patronal/), 'OS patronal NO cambia');
});

test('jornada parcial: OS sobre jornada completa (art. 92 ter LCT); SIPA sobre lo real', () => {
  const full = calcularRecibo({ ...empBase, bruto: 400000 }, P, { anio: 2026, mes: 6, tipo: 'mensual', calcularGanancias: false });
  const parc = calcularRecibo({ ...empBase, bruto: 400000, data: { jornadaParcial: true, remFullTime: 900000 } }, P, { anio: 2026, mes: 6, tipo: 'mensual', calcularGanancias: false });
  assert.ok(aporte(parc, /Obra Social/) > aporte(full, /Obra Social/), 'OS del parcial se calcula sobre jornada completa (mayor)');
  assert.equal(aporte(parc, /Jubilación/), aporte(full, /Jubilación/), 'Jubilación (SIPA) se calcula sobre la remuneración real');
});

test('FAL (Ley 27.802) desde 11/2026: se detrae de seg. social sin cambiar el total de contribuciones', () => {
  const base = calcularRecibo(empBase, { ...P, pctFal: 0 }, { anio: 2026, mes: 11, tipo: 'mensual', calcularGanancias: false });
  const fal = calcularRecibo(empBase, { ...P, pctFal: 2.5 }, { anio: 2026, mes: 11, tipo: 'mensual', calcularGanancias: false });
  const tot = (r) => r.costoEmpleador.totalContrib;
  const linea = (r, re) => (r.costoEmpleador.contribuciones.find((c) => re.test(c.concepto)) || {}).monto || 0;
  assert.ok(linea(fal, /Asistencia Laboral/) > 0, 'aparece la línea FAL');
  assert.ok(linea(fal, /Jubilación patronal/) < linea(base, /Jubilación patronal/), 'la jubilación patronal se reduce');
  assert.ok(Math.abs(tot(fal) - tot(base)) < 0.02, 'el total de contribuciones no cambia (redirección)');
});

test('FAL no aplica antes de 11/2026', () => {
  const oct = calcularRecibo(empBase, { ...P, pctFal: 2.5 }, { anio: 2026, mes: 10, tipo: 'mensual', calcularGanancias: false });
  assert.ok(!oct.costoEmpleador.contribuciones.some((c) => /Asistencia Laboral/.test(c.concepto)), 'sin FAL en octubre');
});

test('SAC = 50% de la mejor remuneración del semestre', () => {
  const r = calcularRecibo(empBase, P, { anio: 2026, mes: 6, tipo: 'sac1', calcularGanancias: false, mejorRemSAC: 1200000 });
  const sac = (r.haberes.find((h) => /SAC/.test(h.concepto)) || {}).monto || 0;
  assert.equal(sac, 600000);
});

// Decreto 612/2026: la base de los APORTES/CONTRIBUCIONES SOLIDARIAS (no afiliados) es la
// remuneración mensual, habitual y permanente — expuesta a las fórmulas como `baseSolidaria`.
// La cuota de AFILIACIÓN sindical NO se ve afectada por el decreto (sigue su base habitual).
const empSind = { ...empBase, data: { cod_sindicato: 'SC' } };  // empleado con sindicato (no FC)

test('Decreto 612/2026: aporte solidario (baseSolidaria) excluye horas extra', () => {
  const cf = [{ codigo: 'SOL', descripcion: 'Aporte solidario (no afiliados)', formula: 'baseSolidaria * 0.02', tipo: 'aporte' }];
  const sinHE = calcularRecibo(empSind, P, { anio: 2026, mes: 6, tipo: 'mensual', calcularGanancias: false, conceptosFormula: cf });
  const conHE = calcularRecibo(empSind, P, { anio: 2026, mes: 6, tipo: 'mensual', calcularGanancias: false, conceptosFormula: cf, horasExtra50: 20 });
  assert.ok(conHE.totales.totalRemun > sinHE.totales.totalRemun, 'las HE deben aumentar el total remunerativo');
  const solSin = (sinHE.detalle.conceptosFormula.find((c) => c.codigo === 'SOL') || {}).monto;
  const solCon = (conHE.detalle.conceptosFormula.find((c) => c.codigo === 'SOL') || {}).monto;
  assert.equal(round2(solCon), round2(solSin), 'el aporte solidario no debe cambiar por las HE');
});

test('Decreto 612/2026: la cuota de AFILIACIÓN sindical NO se altera (base habitual)', () => {
  const conHE = calcularRecibo(empSind, P, { anio: 2026, mes: 6, tipo: 'mensual', calcularGanancias: false, horasExtra50: 20 });
  const base = conHE.totales.totalRemun;  // base habitual (con tope SIPA) usada por la afiliación
  assert.equal(round2(aporte(conHE, /Cuota sindical/)), round2(base * 0.02), 'la afiliación sigue su base habitual');
});

test('Solidario con condición noAfiliado: aplica a no afiliado y no a afiliado', () => {
  const cf = [{ codigo: 'SOL', descripcion: 'Aporte solidario (no afiliados)', condicion: 'noAfiliado', formula: 'baseSolidaria * 0.02', tipo: 'aporte' }];
  const noAfi = calcularRecibo({ ...empSind, data: { cod_sindicato: 'SC', afiliadoSindical: 'no' } }, P, { anio: 2026, mes: 6, tipo: 'mensual', calcularGanancias: false, conceptosFormula: cf });
  const afi = calcularRecibo({ ...empSind, data: { cod_sindicato: 'SC', afiliadoSindical: 'si' } }, P, { anio: 2026, mes: 6, tipo: 'mensual', calcularGanancias: false, conceptosFormula: cf });
  const m = (r) => (r.detalle.conceptosFormula.find((c) => c.codigo === 'SOL') || { monto: 0 }).monto;
  assert.ok(m(noAfi) > 0, 'el no afiliado debe pagar el aporte solidario');
  assert.equal(m(afi), 0, 'el afiliado NO debe pagar el aporte solidario');
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

// ── Motor de fórmulas integrado al recibo (fase 3) ──
test('conceptosFormula vacío/omitido no cambia el recibo (no-regresión)', () => {
  const emp = { ...empBase, data: { basico: 800000 } };
  const base = calcularRecibo(emp, P, { anio: 2026, mes: 3, tipo: 'mensual' });
  const conLista = calcularRecibo(emp, P, { anio: 2026, mes: 3, tipo: 'mensual', conceptosFormula: [] });
  assert.equal(conLista.totales.neto, base.totales.neto);
  assert.equal(conLista.totales.totalRemun, base.totales.totalRemun);
  assert.equal(conLista.haberes.length, base.haberes.length);
});

test('concepto por fórmula remunerativo suma al haber y a la base de aportes', () => {
  const emp = { ...empBase, data: { basico: 800000 } };
  const base = calcularRecibo(emp, P, { anio: 2026, mes: 3, tipo: 'mensual' });
  const cf = [{ codigo: 'PREMIO', descripcion: 'Premio', formula: 'basico * 0.10', base: 'rem' }];
  const rec = calcularRecibo(emp, P, { anio: 2026, mes: 3, tipo: 'mensual', conceptosFormula: cf });
  assert.ok(rec.haberes.some((h) => h.concepto === 'Premio' && h.monto === 80000));
  assert.equal(round2(rec.totales.totalRemun), round2(base.totales.totalRemun + 80000));
  assert.ok(rec.totales.totalRemun > base.totales.totalRemun);
});

test('condición 0 => el concepto por fórmula no aplica', () => {
  const emp = { ...empBase, data: { basico: 800000 } };
  const cf = [{ codigo: 'X', descripcion: 'Solo si antig>=20', formula: '10000', base: 'rem', condicion: 'anios >= 20' }];
  const rec = calcularRecibo(emp, P, { anio: 2026, mes: 3, tipo: 'mensual', conceptosFormula: cf });
  assert.ok(!rec.haberes.some((h) => h.concepto === 'Solo si antig>=20'));
});

test('concepto por fórmula tipo descuento resta del neto', () => {
  const emp = { ...empBase, data: { basico: 800000 } };
  const base = calcularRecibo(emp, P, { anio: 2026, mes: 3, tipo: 'mensual' });
  const cf = [{ codigo: 'CUOTA', descripcion: 'Cuota club', formula: '5000', base: 'descuento' }];
  const rec = calcularRecibo(emp, P, { anio: 2026, mes: 3, tipo: 'mensual', conceptosFormula: cf });
  assert.ok(rec.descuentos.some((x) => x.concepto === 'Cuota club' && x.monto === 5000));
  assert.equal(round2(rec.totales.neto), round2(base.totales.neto - 5000));
});


console.log('\nGanancias — no habituales (RG 4003 ap. B)');

test('factorNoHabitual: porción del mes de pago = 1/(13-k)', () => {
  assert.equal(round2(factorNoHabitual(3, 3)), round2(1 / 10));   // pago en marzo, mes actual marzo
  assert.equal(round2(factorNoHabitual(7, 7)), round2(1 / 6));    // pago en julio
});

test('factorNoHabitual: crece con el mes actual (imputación proporcional)', () => {
  // pago en marzo (k=3): a junio deben estar imputados (6-3+1)/(13-3)=4/10
  assert.equal(round2(factorNoHabitual(3, 6)), round2(4 / 10));
  // a diciembre debe estar imputado el 100%
  assert.equal(round2(factorNoHabitual(3, 12)), 1);
});

test('replay mensual: un no habitual queda imputado al 100% en diciembre', () => {
  // Reproduce lo que hacen acumGananciasDe / ganancias.routes al recorrer los meses:
  // el prorrateo se recalcula con factorNoHabitual(mesPago, mesActual) contra el mes en curso.
  const X = 600000, kPago = 4;
  const proAJunio = X * factorNoHabitual(kPago, 6);
  const proADic = X * factorNoHabitual(kPago, 12);
  assert.ok(proAJunio < X, 'a mitad de año está parcialmente imputado');
  assert.equal(round2(proADic), X, 'a diciembre está imputado el total');
});

test('calcularGananciasAcum: mensual usa prorrateado; anual usa el total', () => {
  const G = { mniAnual: 3000000, dedEspAnual: 14400000, escala: [{ desde: 0, hasta: null, fijo: 0, alicuota: 10 }] };
  const comun = { habitual: 5000000, aporHabitual: 0, sacReal: 0, aporSacReal: 0, retenidoAcum: 0, ganTabla: G };
  const mensual = calcularGananciasAcum({ ...comun, mes: 12, anualizada: false, noHabPro: 300000, noHabFull: 600000 });
  const anual = calcularGananciasAcum({ ...comun, mes: 12, anualizada: true, noHabPro: 300000, noHabFull: 600000 });
  // La base gravada anual toma el total (noHabFull), la mensual el prorrateado (noHabPro).
  assert.ok(anual.gravadoBase > mensual.gravadoBase, "la anual computa el total del no habitual (base sin SAC)");
});

console.log(`\nRESULTADO: ${ok} OK, ${fail} fallidos`);
process.exit(fail ? 1 : 0);
