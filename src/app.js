import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { config } from './config.js';
import { notFound, errorHandler } from './middleware/error.js';
import authRoutes from './routes/auth.routes.js';
import empleadosRoutes from './routes/empleados.routes.js';
import mensajesRoutes from './routes/mensajes.routes.js';
import cbusRoutes from './routes/cbus.routes.js';
import gananciasRoutes from './routes/ganancias.routes.js';
import escalaRoutes from './routes/escala.routes.js';
import conveniosRoutes from './routes/convenios.routes.js';
import artRoutes from './routes/art.routes.js';
import reportesRoutes from './routes/reportes.routes.js';
import sindicatosRoutes from './routes/sindicatos.routes.js';
import hysRoutes from './routes/hys.routes.js';
import reglamentoRoutes from './routes/reglamento.routes.js';
import cierresRoutes from './routes/cierres.routes.js';
import anticiposRoutes from './routes/anticipos.routes.js';
import parametrosRoutes from './routes/parametros.routes.js';
import conceptosRoutes from './routes/conceptos.routes.js';
import liquidacionRoutes from './routes/liquidacion.routes.js';
import recibosRoutes from './routes/recibos.routes.js';
import licenciasRoutes from './routes/licencias.routes.js';
import sancionesRoutes from './routes/sanciones.routes.js';
import evaluacionesRoutes from './routes/evaluaciones.routes.js';
import certificadosRoutes from './routes/certificados.routes.js';
import adminRoutes from './routes/admin.routes.js';
import elementosRoutes from './routes/elementos.routes.js';
import beneficiosRoutes from './routes/beneficios.routes.js';
import domicilioRoutes from './routes/domicilio.routes.js';
import familiaresRoutes from './routes/familiares.routes.js';

export function createApp() {
  const app = express();
  // Detrás del nginx/reverse-proxy: confiar en X-Forwarded-* para IP real (rate-limit) y HTTPS.
  app.set('trust proxy', Number(process.env.TRUST_PROXY || 1));
  app.use(helmet());
  // CORS: si el origen es '*' no se pueden enviar credenciales (regla del navegador).
  app.use(cors({ origin: config.corsOrigin, credentials: config.corsOrigin !== '*' }));
  app.use(express.json({ limit: '5mb' }));
  app.use(morgan('dev'));

  app.get('/api/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));
  app.use('/api/auth', authRoutes);
  app.use('/api/empleados', empleadosRoutes);
  app.use('/api/mensajes', mensajesRoutes);
  app.use('/api/cbus', cbusRoutes);
  app.use('/api/ganancias', gananciasRoutes);
  app.use('/api/escala', escalaRoutes);
  app.use('/api/convenios', conveniosRoutes);
  app.use('/api/art', artRoutes);
  app.use('/api/reportes', reportesRoutes);
  app.use('/api/sindicatos', sindicatosRoutes);
  app.use('/api/hys', hysRoutes);
  app.use('/api/reglamento', reglamentoRoutes);
  app.use('/api/cierres', cierresRoutes);
  app.use('/api/anticipos', anticiposRoutes);
  app.use('/api/parametros', parametrosRoutes);
  app.use('/api/conceptos', conceptosRoutes);
  app.use('/api/liquidacion', liquidacionRoutes);
  app.use('/api/recibos', recibosRoutes);
  app.use('/api/licencias', licenciasRoutes);
  app.use('/api/sanciones', sancionesRoutes);
  app.use('/api/evaluaciones', evaluacionesRoutes);
  app.use('/api/certificados', certificadosRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/elementos', elementosRoutes);
  app.use('/api/beneficios', beneficiosRoutes);
  app.use('/api/cambios-domicilio', domicilioRoutes);
  app.use('/api/familiares', familiaresRoutes);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
