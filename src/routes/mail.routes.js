import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { mailConfigurado, verificarSMTP, enviarMail } from '../lib/mailer.js';

const router = Router();
router.use(requireAuth);

router.get('/estado', requireRole('rrhh', 'admin'), (req, res) => res.json({ configurado: mailConfigurado() }));

router.post('/test', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const to = (req.body?.to || '').trim();
    if (!to) return res.status(400).json({ error: 'Indicá un destinatario de prueba' });
    await verificarSMTP();
    await enviarMail({ to, subject: 'Prueba de correo — Portal RR.HH.', html: '<p>El envío de correo está configurado correctamente. ✔</p>' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
