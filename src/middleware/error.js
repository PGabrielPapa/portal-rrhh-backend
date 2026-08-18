import crypto from 'node:crypto';
import { config } from '../config.js';

// 404 + manejador central de errores.
export function notFound(req, res) {
  res.status(404).json({ error: 'Recurso no encontrado' });
}

// Campos de un error de Postgres que pueden contener VALORES de la fila
// (nombres, DNI, CBU…). Nunca deben viajar al cliente ni al log de acceso.
function detalleSeguro(err) {
  if (!err) return '';
  // `constraint` sí es útil y no filtra datos: dice qué regla se violó.
  return err.constraint ? `restricción ${err.constraint}` : '';
}

export function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  // Identificador corto para poder cruzar lo que ve el usuario con el log del servidor
  // sin exponerle nada del error.
  const ref = crypto.randomBytes(4).toString('hex');
  const quien = req.user ? (req.user.pid ? `persona#${req.user.pid}` : `empleado#${req.user.id}`) : 'anónimo';

  // En el log: mensaje y stack, nunca el cuerpo del pedido (trae datos personales
  // y, en el login, la contraseña). En producción, sin stack para no llenar disco
  // ni volcar rutas internas a un agregador de logs de terceros.
  const linea = `[api] error ${ref} · ${req.method} ${req.path} · ${quien} · ${err?.code || ''} ${err?.message || err}`;
  if (config.isProd) console.error(linea);
  else console.error(linea, '\n', err?.stack || '');

  // Violación de unicidad de Postgres: antes se devolvía `err.detail`, que incluye
  // el valor duplicado ("Key (dni)=(30123456) already exists") — una fuga directa
  // de datos personales a quien solo probaba dar de alta un registro.
  if (err && err.code === '23505') {
    return res.status(409).json({ error: 'Ya existe un registro con esos datos.', detail: detalleSeguro(err), ref });
  }
  // Violación de clave foránea / dato fuera de rango: error del cliente, no del servidor.
  if (err && ['23503', '23502', '22P02', '23514'].includes(err.code)) {
    return res.status(400).json({ error: 'Los datos enviados no son válidos.', ref });
  }
  // Cuerpo JSON malformado o demasiado grande.
  if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
    return res.status(400).json({ error: 'El cuerpo del pedido no es JSON válido.', ref });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'El contenido enviado es demasiado grande.', ref });
  }

  const status = err?.status || 500;
  // Solo se devuelve un mensaje propio si el código lo marcó explícitamente como
  // publicable; cualquier otro texto podría venir de la base o de un servicio externo.
  const publico = err?.publicMessage || (status < 500 ? 'Pedido inválido' : 'Error interno del servidor');
  res.status(status).json({ error: publico, ref });
}
