// ─────────────────────────────────────────────────────────────────────────────
// Clasificador de contribuciones patronales del asiento de sueldos.
// Vive aparte de asientoSueldos.js —que necesita la base de datos— para que los
// tests puedan verificar que cada concepto que emite la liquidación encuentra su
// clave en esta tabla. Si la liquidación agrega una contribución y acá no hay
// expresión que la matchee, cae en CONT_OTRAS y el asiento la deja sin cuenta.
// ─────────────────────────────────────────────────────────────────────────────
export const CONTRIBUCIONES = [
  // El FAL va antes que SIJP: se paga a ARCA con código propio (266-019-019,
  // RG 5907/2026 art. 10), así que Contabilidad puede darle su propia cuenta en vez
  // de mezclarlo con el resto de las cargas sociales. Si no se la asigna, cae igual
  // en SUSS a pagar, como hasta ahora.
  ['CONT_FAL',       /asistencia\s+laboral/i],
  ['CONT_SIJP',      /jubilaci[óo]n\s+patronal|sipa/i],
  ['CONT_19032',     /inssjp|pami/i],
  ['CONT_FNE',       /fondo\s+nacional\s+de\s+empleo/i],
  ['CONT_AFAM',      /asignaciones\s+familiares/i],
  ['CONT_ANSSAL',    /anssal/i],
  ['CONT_OS',        /obra\s+social/i],
  ['CONT_ART',       /\bart\b|riesgos\s+del\s+trabajo|ffep/i],
  ['CONT_SIND',      /sindical|sindicato/i],
  ['CONT_SCVO',      /scvo|seguro\s+de\s+vida\s+oblig/i],
  ['CONT_ESTRELLA',  /estrella/i],
  ['CONT_FCESE',     /fondo\s+de\s+cese/i],
];

export default { CONTRIBUCIONES };
