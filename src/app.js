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
import anticiposRoutes from './routes/anticipos.routes.js';
import parametrosRoutes from './routes/parametros.routes.js';
import conceptosRoutes from './routes/conceptos.routes.js';

export function createApp() {
  const app = express();
  app.use(helmet());
  app.use(cors({ origin: config.corsOrigin, credentials: true }));
  app.use(express.json({ limit: '5mb' }));
  app.use(morgan('dev'));

  app.get('/api/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));
  app.use('/api/auth', authRoutes);
  app.use('/api/empleados', empleadosRoutes);
  app.use('/api/mensajes', mensajesRoutes);
  app.use('/api/cbus', cbusRoutes);
  app.use('/api/anticipos', anticiposRoutes);
  app.use('/api/parametros', parametrosRoutes);
  app.use('/api/conceptos', conceptosRoutes);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
