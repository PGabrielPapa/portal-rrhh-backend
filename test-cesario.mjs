import { parseExtendido, minToHhmm } from './src/lib/fichadasProsoft.js';
const H = ['Legajo','Empleado','Fecha','Día','Turno','E1','S1','E2','S2','E3','S3','E4','S4','Hs Netas','Descanso','Hs Normal','Resut.BDH','EXTRA 50','EXTRA 100','Nocturna','Nocturna Extra','Total','Tarde','Área','Empresa','Comentarios'];
const c={};H.forEach((h,i)=>c[h]=i);
const r=(f,e,s)=>{const x=new Array(H.length).fill('');x[c.Legajo]='167';x[c.Empleado]='CESARIO';x[c.Fecha]=f;x[c.Turno]='General';x[c.E1]=e;x[c.S1]=s;x[c['EXTRA 50']]='';return x;};
const rows=[H,
 r('2026-06-16','05:48','15:53'), r('2026-06-17','05:51','15:53'), r('2026-06-18','05:49','15:54'),
 r('2026-06-19','05:47','15:52'), r('2026-06-22','05:48','12:53'), r('2026-06-23','05:45','16:00'),
 r('2026-06-24','05:49','16:00'), r('2026-06-25','05:54','15:55'), r('2026-06-26','05:53','15:54'),
 r('2026-06-29','05:43','15:53'), r('2026-06-30','05:53','15:55'), r('2026-07-01','05:45','15:54'),
 r('2026-07-02','05:45','15:55'), r('2026-07-03','05:45','15:53'), r('2026-07-06','05:47','15:54'),
 r('2026-07-07','05:46','11:55'),
];
const {porLegajo}=parseExtendido(rows,{desde:'2026-06-16',hasta:'2026-07-07',feriados:new Set()});
const a=Object.values(porLegajo)[0];
for(const d of a.dias) console.log(d.fecha, 'neto',minToHhmm(d.hsNetasMin),'saldo',d.saldoMin==null?'—':minToHhmm(d.saldoMin));
console.log('Extra50',minToHhmm(a.horasExtra50Min),'| Extra100',minToHhmm(a.horasExtra100Min),'| Banco',minToHhmm(a.bancoNetoMin),'| Recuperar',minToHhmm(a.aRecuperarMin));
