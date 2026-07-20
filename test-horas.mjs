import { parseExtendido, minToHhmm } from './src/lib/fichadasProsoft.js';

const H = ['Legajo','Empleado','Fecha','Día','Turno','E1','S1','E2','S2','E3','S3','E4','S4','Hs Netas','Descanso','Hs Normal','Resut.BDH','EXTRA 50','EXTRA 100','Nocturna','Nocturna Extra','Total','Tarde','Área','Empresa','Comentarios'];
const col = {}; H.forEach((h,i)=>col[h]=i);
function row(f, dia, e1,s1, opts={}) {
  const r = new Array(H.length).fill('');
  r[col['Legajo']]='100'; r[col['Empleado']]='TEST'; r[col['Fecha']]=f; r[col['Día']]=dia;
  r[col['Turno']]=opts.turno||'General'; r[col['E1']]=e1; r[col['S1']]=s1;
  if(opts.e2){r[col['E2']]=opts.e2; r[col['S2']]=opts.s2;}
  r[col['Comentarios']]=opts.com||'';
  // Hs Netas de Pro-Soft a propósito MAL (para probar que NO se usa)
  r[col['Hs Netas']]=opts.hsNetas||'99:99';
  r[col['EXTRA 50']]=opts.pE50||'05:00'; r[col['EXTRA 100']]=opts.pE100||'';
  return r;
}

// Semana ejemplo (jornada 9h). Fechas: lun-sáb.
const rows = [H,
  row('2026-06-01','Lunes','07:00','16:00'),                 // net 9:00 → 0
  row('2026-06-02','Martes','07:40','16:40'),                // net 9:00 → 0 (tarde repuesta)
  row('2026-06-03','Miércoles','07:00','17:00'),             // net 10:00 → +1:00 extra
  row('2026-06-04','Jueves','07:00','15:40'),                // net 8:40 → -0:20 banco
  row('2026-06-05','Viernes','07:00','16:20'),               // net 9:20 → +0:20 cubre jueves
  row('2026-06-06','Sábado','08:00','12:00'),                // net 4:00 → extra50
];

const { porLegajo } = parseExtendido(rows, { desde:'2026-06-01', hasta:'2026-06-06', feriados:new Set() });
const a = Object.values(porLegajo)[0];
console.log('--- Detalle días ---');
for (const d of a.dias) console.log(d.fecha, d.tipoDia.padEnd(8), 'neto', minToHhmm(d.hsNetasMin), 'saldo', d.saldoMin==null?'—':minToHhmm(d.saldoMin), d.estado);
console.log('--- Totales ---');
console.log('Extra 50 :', minToHhmm(a.horasExtra50Min), '(esperado 05:00)');
console.log('Extra 100:', minToHhmm(a.horasExtra100Min), '(esperado 00:00)');
console.log('Banco    :', minToHhmm(a.bancoNetoMin), '(esperado 00:00)');
console.log('A recup. :', minToHhmm(a.aRecuperarMin), '(esperado 00:00)');
