// 404 + manejador central de errores.
export function notFound(req, res) {
  res.status(404).json({ error: 'Recurso no encontrado' });
}

export function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  console.error('[api] error:', err);
  // Violación de unicidad de Postgres
  if (err && err.code === '23505') {
    return res.status(409).json({ error: 'Registro duplicado', detail: err.detail });
  }
  const status = err.status || 500;
  res.status(status).json({ error: err.publicMessage || 'Error interno del servidor' });
}
