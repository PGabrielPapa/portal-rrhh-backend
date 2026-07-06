// Reglas de licencias especiales del grupo (planilla "LIC LEITEN-SINIS-BARTON-IDEE")
// y normativa concordante (LCT arts. 155, 158, 208 y CCT 130/75 art. 78).
//
// Cada regla define:
//   key      identificador estable para acumular saldo por año
//   tope     máximo de días (por evento si anual=false; por año calendario si anual=true)
//   anual    true → el tope es un cupo anual acumulable; false → es por evento
//   sinGoce  true → licencia SIN goce de haberes (impacta la liquidación como descuento)
//   base     norma que la respalda (para mostrar en mensajes)
//   nombre   etiqueta legible
//
// El orden importa: las variantes más específicas van primero (casamiento de hijo
// antes que casamiento; fallecimiento político antes que el genérico).
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();

export const REGLAS = [
  { key: 'nacimiento',           match: (t) => t.includes('nacimiento'),                                         tope: 2,  anual: false, sinGoce: false, base: 'Art. 158 LCT / CCT', nombre: 'Nacimiento de hijo' },
  { key: 'casamiento_hijo',      match: (t) => (t.includes('casamiento') || t.includes('matrimonio')) && t.includes('hijo'), tope: 1, anual: false, sinGoce: false, base: 'CCT', nombre: 'Casamiento de hijo' },
  { key: 'prematrimonial',       match: (t) => t.includes('prematrimonial'),                                      tope: 1,  anual: false, sinGoce: false, base: 'CCT', nombre: 'Trámites prematrimoniales' },
  { key: 'casamiento',           match: (t) => t.includes('casamiento') || t.includes('matrimonio'),              tope: 12, anual: false, sinGoce: false, base: 'Art. 158 LCT / CCT', nombre: 'Casamiento' },
  { key: 'mudanza',              match: (t) => t.includes('mudanza'),                                             tope: 2,  anual: false, sinGoce: false, base: 'CCT', nombre: 'Mudanza' },
  { key: 'donacion_sangre',      match: (t) => t.includes('sangre') || t.includes('donacion'),                    tope: 1,  anual: false, sinGoce: false, base: 'Art. 158 LCT / CCT', nombre: 'Donación de sangre' },
  { key: 'fallecimiento_pol',    match: (t) => t.includes('fallecimiento') && (t.includes('politic') || t.includes('abuelo') || t.includes('suegr') || t.includes('cunad')), tope: 2, anual: false, sinGoce: false, base: 'CCT', nombre: 'Fallecimiento familiar político' },
  { key: 'fallecimiento',        match: (t) => t.includes('fallecimiento'),                                       tope: 4,  anual: false, sinGoce: false, base: 'Art. 158 LCT / CCT', nombre: 'Fallecimiento familiar directo' },
  { key: 'examen',               match: (t) => t.includes('examen') || t.includes('estudio'),                     tope: 20, anual: true,  sinGoce: false, base: 'CCT (día de estudio)', nombre: 'Examen / estudio' },
  { key: 'enf_familiar',         match: (t) => t.includes('familiar'),                                            tope: 30, anual: true,  sinGoce: true,  base: 'Art. 78 CCT 130/75', nombre: 'Enfermedad de familiar a cargo' },
];

// Devuelve la regla que aplica a un tipo de licencia, o null si no tiene tope especial.
export function reglaDe(tipo) {
  const t = norm(tipo);
  return REGLAS.find((r) => r.match(t)) || null;
}

// true si el tipo de licencia es SIN goce de haberes (impacta la liquidación).
export function esSinGoce(tipo) {
  const r = reglaDe(tipo);
  return !!(r && r.sinGoce);
}
