import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { config } from './config.js';
import { notFound, errorHandler } from './middleware/error.js';
import { limiteGeneral, limitePesado, limiteIA, limiteMail } from './middleware/rateLimit.js';
import authRoutes from './routes/auth.routes.js';
import empleadosRoutes from './routes/empleados.routes.js';
import chsRoutes from './routes/chs.routes.js';
import personasRoutes from './routes/personas.routes.js';
import siradigRoutes from './routes/siradig.routes.js';
import acumuladoresRoutes from './routes/acumuladores.routes.js';
import embargosRoutes from './routes/embargos.routes.js';
import dashboardRoutes from './routes/dashboard.routes.js';
import alertasRoutes from './routes/alertas.routes.js';
import provisionRoutes from './routes/provision.routes.js';
import valoresLegalesRoutes from './routes/valoresLegales.routes.js';
import mailRoutes from './routes/mail.routes.js';
import novedadesRoutes from './routes/novedades.routes.js';
import vacacionesRoutes from './routes/vacaciones.routes.js';
import legajoRoutes from './routes/legajo.routes.js';
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
import aprobacionesRoutes from './routes/aprobaciones.routes.js';
import parametrosRoutes from './routes/parametros.routes.js';
import conceptosRoutes from './routes/conceptos.routes.js';
import liquidacionRoutes from './routes/liquidacion.routes.js';
import produccionRoutes from './routes/produccion.routes.js';
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
import fichadasRoutes from './routes/fichadas.routes.js';
import prosoftRoutes from './routes/prosoft.routes.js';
import delegacionesRoutes from './routes/delegaciones.routes.js';
import arcaRoutes from './routes/arca.routes.js';
import obraSocialRoutes from './routes/obraSocial.routes.js';
import puestosRoutes from './routes/puestos.routes.js';
import camposRoutes from './routes/campos.routes.js';
import valoresAuxRoutes from './routes/valoresAux.routes.js';
import plantillasRoutes from './routes/plantillas.routes.js';
import modeloReciboRoutes from './routes/modeloRecibo.routes.js';
import agrupacionesRoutes from './routes/agrupaciones.routes.js';
import configHistRoutes from './routes/configHist.routes.js';
import reclutamientoRoutes from './routes/reclutamiento.routes.js';
import desempenoRoutes from './routes/desempeno.routes.js';
import compensacionesRoutes from './routes/compensaciones.routes.js';
import lmsRoutes from './routes/lms.routes.js';
import desarrolloRoutes from './routes/desarrollo.routes.js';
import comunicacionesRoutes from './routes/comunicaciones.routes.js';
import fichajeWebRoutes from './routes/fichajeWeb.routes.js';
import firmasRoutes from './routes/firmas.routes.js';
import miFormacionRoutes from './routes/miFormacion.routes.js';
import miFeedbackRoutes from './routes/miFeedback.routes.js';
import iaRoutes from './routes/ia.routes.js';
import sicoreRoutes from './routes/sicore.routes.js';
import matrizAntiguedadRoutes from './routes/matrizAntiguedad.routes.js';
import modalidadesRoutes from './routes/modalidades.routes.js';
import competenciasRoutes from './routes/competencias.routes.js';
import unidadesRoutes from './routes/unidades.routes.js';
import posicionesRoutes from './routes/posiciones.routes.js';
import workflowsRoutes from './routes/workflows.routes.js';
import talentoRoutes from './routes/talento.routes.js';
import formacionRoutes from './routes/formacion.routes.js';
import encuestasRoutes from './routes/encuestas.routes.js';

export function createApp() {
  const app = express();
  // No anunciar el framework: no ayuda a nadie salvo a quien busca exploits conocidos.
  app.disable('x-powered-by');
  // Detrás del nginx/reverse-proxy: confiar en X-Forwarded-* para IP real (rate-limit) y HTTPS.
  app.set('trust proxy', Number(process.env.TRUST_PROXY || 1));

  // ── Cabeceras de seguridad ────────────────────────────────────────────────
  // helmet() a secas no fija CSP útil para una API ni HSTS con precarga. Acá:
  //  - CSP restrictiva: la API solo devuelve JSON y archivos adjuntos; nada de
  //    scripts ni marcos. Si algún día un adjunto se sirviera como HTML, no podría
  //    ejecutar nada ni salir a buscar recursos externos.
  //  - frameguard DENY: impide embeber el portal en un iframe (clickjacking).
  //  - HSTS: fuerza HTTPS en el navegador durante un año.
  //  - noSniff: el navegador respeta el Content-Type que declaramos.
  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'none'"],
        'frame-ancestors': ["'none'"],
        'base-uri': ["'none'"],
        'form-action': ["'none'"],
        'img-src': ["'self'", 'data:'],
        'sandbox': ['allow-downloads'],
      },
    },
    crossOriginResourcePolicy: { policy: 'same-site' },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'no-referrer' },
    hsts: config.isProd ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
    frameguard: { action: 'deny' },
  }));
  app.use((req, res, next) => {
    // Los datos del portal son personales: que ningún proxy ni el navegador los cachee.
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
    next();
  });

  // ── CORS ──────────────────────────────────────────────────────────────────
  // Lista blanca explícita (config.js rechaza '*' en producción). Se permiten
  // credenciales solo cuando el origen está declarado.
  const permitidos = config.corsOrigin;
  app.use(cors({
    origin: permitidos === '*' ? '*' : (origin, cb) => {
      // Sin cabecera Origin (curl, apps móviles, health checks) se deja pasar:
      // esas peticiones no las origina un navegador de un tercero.
      if (!origin) return cb(null, true);
      if (permitidos.includes(origin)) return cb(null, true);
      return cb(null, false);   // el navegador bloquea; no se filtra por qué
    },
    credentials: permitidos !== '*',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 600,
  }));

  // Cuerpo JSON: 5 MB alcanza para los adjuntos en base64 y corta los envíos
  // desmedidos que buscan agotar memoria. Los endpoints de credenciales, en
  // cambio, solo reciben un DNI y una contraseña: aceptar 5 MB ahí era regalar
  // un vector barato de consumo de CPU y memoria SIN estar autenticado.
  app.use('/api/auth', express.json({ limit: '16kb' }));
  app.use(express.json({ limit: '5mb' }));
  // En producción, formato de log sin colores y sin cuerpos; `dev` es para consola local.
  app.use(morgan(config.isProd ? 'combined' : 'dev', {
    skip: (req) => req.path === '/api/health',
  }));

  // Límite de tasa global (antes solo existía en el login).
  app.use('/api', limiteGeneral);

  app.get('/api/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));
  app.use('/api/auth', authRoutes);
  app.use('/api/empleados', empleadosRoutes);
  app.use('/api/mensajes', mensajesRoutes);
  app.use('/api/cbus', cbusRoutes);
  app.use('/api/ganancias', gananciasRoutes);
  app.use('/api/escala', escalaRoutes);
  app.use('/api/convenios', conveniosRoutes);
  app.use('/api/art', artRoutes);
  app.use('/api/reportes', limitePesado, reportesRoutes);
  app.use('/api/sindicatos', sindicatosRoutes);
  app.use('/api/hys', hysRoutes);
  app.use('/api/reglamento', reglamentoRoutes);
  app.use('/api/cierres', cierresRoutes);
  app.use('/api/anticipos', anticiposRoutes);
  app.use('/api/aprobaciones', aprobacionesRoutes);
  app.use('/api/parametros', parametrosRoutes);
  app.use('/api/conceptos', conceptosRoutes);
  app.use('/api/liquidacion', limitePesado, liquidacionRoutes);
  app.use('/api/produccion', limitePesado, produccionRoutes);
  app.use('/api/recibos', recibosRoutes);
  app.use('/api/licencias', licenciasRoutes);
  app.use('/api/sanciones', sancionesRoutes);
  app.use('/api/evaluaciones', evaluacionesRoutes);
  app.use('/api/certificados', certificadosRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/elementos', elementosRoutes);
  app.use('/api/beneficios', beneficiosRoutes);
  app.use('/api/cambios-domicilio', domicilioRoutes);
  app.use('/api/cambios-obra-social', obraSocialRoutes);
  app.use('/api/puestos', puestosRoutes);
  app.use('/api/campos', camposRoutes);
  app.use('/api/valores-aux', valoresAuxRoutes);
  app.use('/api/plantillas-legajo', plantillasRoutes);
  app.use('/api/modelo-recibo', modeloReciboRoutes);
  app.use('/api/agrupaciones', agrupacionesRoutes);
  app.use('/api/config-hist', configHistRoutes);
  app.use('/api/reclutamiento', reclutamientoRoutes);
  app.use('/api/desempeno', desempenoRoutes);
  app.use('/api/compensaciones', compensacionesRoutes);
  app.use('/api/lms', lmsRoutes);
  app.use('/api/desarrollo', desarrolloRoutes);
  app.use('/api/comunicaciones', comunicacionesRoutes);
  app.use('/api/fichaje', fichajeWebRoutes);
  app.use('/api/firmas', firmasRoutes);
  app.use('/api/mi-formacion', miFormacionRoutes);
  app.use('/api/mi-feedback', miFeedbackRoutes);
  app.use('/api/ia', limiteIA, iaRoutes);
  app.use('/api/sicore', limitePesado, sicoreRoutes);
  app.use('/api/matriz-antiguedad', matrizAntiguedadRoutes);
  app.use('/api/modalidades', modalidadesRoutes);
  app.use('/api/competencias', competenciasRoutes);
  app.use('/api/unidades', unidadesRoutes);
  app.use('/api/posiciones', posicionesRoutes);
  app.use('/api/workflows', workflowsRoutes);
  app.use('/api/talento', talentoRoutes);
  app.use('/api/formacion', formacionRoutes);
  app.use('/api/encuestas', encuestasRoutes);
  app.use('/api/arca', limitePesado, arcaRoutes);
  app.use('/api/familiares', familiaresRoutes);
  app.use('/api/fichadas', fichadasRoutes);
  app.use('/api/prosoft', limitePesado, prosoftRoutes);
  app.use('/api/delegaciones', delegacionesRoutes);
  app.use('/api/chs', chsRoutes);
  app.use('/api/personas', personasRoutes);
  app.use('/api/siradig', siradigRoutes);
  app.use('/api/acumuladores', acumuladoresRoutes);
  app.use('/api/embargos', embargosRoutes);
  app.use('/api/dashboard', dashboardRoutes);
  app.use('/api/alertas', alertasRoutes);
  app.use('/api/provision', provisionRoutes);
  app.use('/api/valores-legales', valoresLegalesRoutes);
  app.use('/api/mail', limiteMail, mailRoutes);
  app.use('/api/novedades', novedadesRoutes);
  app.use('/api/vacaciones', vacacionesRoutes);
  app.use('/api/legajo-docs', legajoRoutes);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
