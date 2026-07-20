import { parseExtendido, minToHhmm } from './src/lib/fichadasProsoft.js';
const H=['Legajo','Empleado','Fecha','Día','Turno','E1','S1','E2','S2','E3','S3','E4','S4','Hs Netas','Descanso','Hs Normal','Resut.BDH','EXTRA 50','EXTRA 100','Nocturna','Nocturna Extra','Total','Tarde','Área','Empresa','Comentarios'];
const c={};H.forEach((h,i)=>c[h]=i);
const r=(f,e,s)=>{const x=new Array(H.length).fill('');x[c.Legajo]='91';x[c.Empleado]='ABIBE';x[c.Fecha]=f;x[c.Turno]='General';x[c.E1]=e;x[c.S1]=s;return x;};
// Saldos reales de la pantalla (entrada/salida, jornada 9h). Días injustificados 7/7 y 8/7 sin fila.
const rows=[H,
 r('2026-06-16','07:00','17:00'), r('2026-06-17','06:59','17:09'), r('2026-06-18','07:13','17:00'),
 r('2026-06-19','07:11','16:10'), r('2026-06-22','07:04','16:07'),
 // 06-23 marca incompleta (solo entrada) → revisar
 (()=>{const x=r('2026-06-23','07:16','');return x;})(),
 r('2026-06-24','08:33','17:00'), r('2026-06-25','07:08','16:22'), r('2026-06-26','07:11','16:12'),
 r('2026-06-29','07:07','17:09'), r('2026-06-30','07:09','16:59'), r('2026-07-01','07:10','16:06'),
 r('2026-07-02','07:05','17:02'), r('2026-07-03','07:22','16:23'), r('2026-07-06','07:09','16:10'),
 r('2026-07-13','07:07','16:14'), r('2026-07-14','06:58','16:11'), r('2026-07-15','07:29','14:58'),
 r('2026-07-16','07:22','16:21'), r('2026-07-17','07:10','16:16'),
];
const {porLegajo}=parseExtendido(rows,{desde:'2026-06-16',hasta:'2026-07-17',feriados:new Set()});
const a=Object.values(porLegajo)[0];
console.log('Extra50',minToHhmm(a.horasExtra50Min),'| Extra100',minToHhmm(a.horasExtra100Min),'| Banco',minToHhmm(a.bancoNetoMin),'| Recuperar',minToHhmm(a.aRecuperarMin));
console.log('esperado: Extra ~04:22, Recuperar 00:00, sin ambos a la vez');
