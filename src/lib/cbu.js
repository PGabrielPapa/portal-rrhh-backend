// Tabla de entidades BCRA + detección de banco y validación de CBU (portado de la app vanilla).
export const BANCOS_BCRA = {
  '005': 'The Royal Bank of Scotland',
  '007': 'Galicia',
  '011': 'Banco Nación',
  '014': 'Provincia de Buenos Aires',
  '015': 'ICBC',
  '016': 'Citibank',
  '017': 'BBVA',
  '018': 'Citibank N.A.',
  '020': 'Banco Pcia Buenos Aires',
  '027': 'Supervielle',
  '028': 'Comafi',
  '029': 'Banco Ciudad',
  '030': 'Central de la R.A.',
  '034': 'Patagonia',
  '044': 'Comafi',
  '045': 'Banco BHN',
  '060': 'Banco del Tucumán',
  '065': 'Itaú',
  '072': 'Santander',
  '083': 'Banco del Chubut',
  '086': 'Banco Sta. Cruz',
  '093': 'Banco Coop. La Plata',
  '094': 'Banco Pcia Tierra del Fuego',
  '097': 'Banco Pcia Neuquén',
  '143': 'Brubank',
  '147': 'Banco Interfinanzas',
  '150': 'HSBC',
  '165': 'JP Morgan',
  '170': 'HSBC',
  '180': 'Banco BIND',
  '191': 'Credicoop',
  '198': 'Banco Saenz',
  '247': 'Banco Roela',
  '254': 'Banco Mariva',
  '259': 'Banco Itaú',
  '262': 'Banco Mariva',
  '266': 'BNP Paribas',
  '268': 'Banco Provincia Córdoba',
  '269': 'Banco de la República O. del Uruguay',
  '277': 'Banco Servicios y Transacciones',
  '281': 'Banco Mendoza',
  '285': 'Macro',
  '295': 'Banco Voii',
  '299': 'Banco Comafi',
  '300': 'Banco de la República Oriental del Uruguay',
  '301': 'Banco Mariva',
  '305': 'Banco Voii',
  '309': 'Banco Tierra del Fuego',
  '310': 'Banco del Sol',
  '311': 'Banco Pcia Río Negro',
  '312': 'Banco del Sol',
  '315': 'Banco de Formosa',
  '319': 'BICE',
  '321': 'Banco Sta. Cruz',
  '322': 'Banco Industrial',
  '330': 'Nuevo Banco Industrial',
  '336': 'Wilobank',
  '338': 'Banco de la República Oriental',
  '339': 'BACS',
  '340': 'Comafi',
  '341': 'Naranja X',
  '384': 'Banco Wal-Mart',
  '386': 'Nuevo Banco de Entre Ríos',
  '389': 'Banco Columbia',
  '402': 'Banco Pcia Tucumán',
  '405': 'Banco Pcia Catamarca',
  '406': 'Banco de Formosa',
  '408': 'Banco Pcia Corrientes',
  '409': 'Banco Pcia Chubut',
  '426': 'Nuevo Banco de Bisel',
  '431': 'Banco Bansud',
  '432': 'Banco Bansud',
  '435': 'Banco Mariva',
  '443': 'Banco BIND'
};

export function bancoDesdeCBU(cbu) {
  const limpio = String(cbu || '').replace(/\\D/g, '');
  if (limpio.length < 3) return '';
  const cod = limpio.slice(0, 3);
  return BANCOS_BCRA[cod] || `Otro (cód ${cod})`;
}

function _calcDV(digitos, pesos) {
  let suma = 0;
  for (let i = 0; i < digitos.length; i++) suma += parseInt(digitos[i], 10) * pesos[i];
  return (10 - (suma % 10)) % 10;
}

// Validación BCRA: 22 dígitos, DV1 sobre banco+sucursal, DV2 sobre la cuenta.
export function validarCBU(cbu) {
  const limpio = String(cbu || '').replace(/\\D/g, '');
  if (!limpio) return { ok: false, error: 'CBU vacío' };
  if (limpio.length !== 22) return { ok: false, error: `El CBU debe tener 22 dígitos (tiene ${limpio.length})` };
  const dv1Calc = _calcDV(limpio.slice(0, 7), [7, 1, 3, 9, 7, 1, 3]);
  if (dv1Calc !== parseInt(limpio[7], 10)) return { ok: false, error: 'Dígito verificador del banco/sucursal inválido' };
  const dv2Calc = _calcDV(limpio.slice(8, 21), [3, 9, 7, 1, 3, 9, 7, 1, 3, 9, 7, 1, 3]);
  if (dv2Calc !== parseInt(limpio[21], 10)) return { ok: false, error: 'Dígito verificador de la cuenta inválido' };
  return { ok: true, cbu: limpio, banco: bancoDesdeCBU(limpio) };
}
