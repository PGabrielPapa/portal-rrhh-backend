import { parseExtendido, minToHhmm } from './src/lib/fichadasProsoft.js';

const H = ['Legajo','Empleado','Fecha','Día','Turno','E1','S1','E2','S2','E3','S3','E4','S4','Hs Netas','Descanso','Hs Normal','Resut.BDH','EXTRA 50','EXTRA 100','Nocturna','Nocturna Extra','Total','Tarde','Área','Empresa','Comentarios'];
const col = {}; H.forEach((h,i)=>col[h]=i);
function row(f, e1,s1, opts={}) {
  const r = new Array(H.length).fill('');
  r[col['Legajo']]='200'; r[col['Empleado']]='TEST2'; r[col['Fecha']]=f;
  r[col['Turno']]=opts.turno||'General'; r[col['E1']]=e1; r[col['S1']]=s1;
  if(opts.e2){r[col['E2']]=opts.e2; r[col['S2']]=opts.s2;}
  r[col['Comentarios']]=opts.com||'';
  return r;
}

// Jornada 9h. Casos:
const rows = [H,
  // Lun 4 fichadas: 07:00-12:00 y 12:30-16:30 = 5h+4h=9h → saldo 0 (media hora almuerzo NO cuenta)
  row('2026-06-08','07:00','12:00',{e2:'12:30',s2:'16:30'}),
  // Mar déficit grande no cubierto: 07:00-14:00 = 7h → -2:00
  row('2026-06-09','07:00','14:00'),
  // Mié excedente chico 07:00-09:25? no. 07:00-16:20 = 9:20 → +0:20 cubre parte del martes
  row('2026-06-10','07:00','16:20'),
  // Dom trabajado: 08:00-12:00 = 4h → extra 100 (no compensa el martes)
  row('2026-06-14','08:00','12:00'),
];

const { porLegajo } = parseExtendido(rows, { desde:'2026-06-08', hasta:'2026-06-14', feriados:new Set(['2026-06-10']) });
// Nota: marqué 2026-06-10 como feriado a propósito para probar. Reviso.
const a = Object.values(porLegajo)[0];
console.log('--- Detalle ---');
for (const d of a.dias) console.log(d.fecha, d.tipoDia.padEnd(8), 'neto', minToHhmm(d.hsNetasMin), 'saldo', d.saldoMin==null?'—':minToHhmm(d.saldoMin), d.estado);
console.log('Extra50', minToHhmm(a.horasExtra50Min), '| Extra100', minToHhmm(a.horasExtra100Min), '| Banco', minToHhmm(a.bancoNetoMin), '| Recuperar', minToHhmm(a.aRecuperarMin));
