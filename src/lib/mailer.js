import { config } from '../config.js';

let _tx = null;
export function mailConfigurado() { return !!config.smtp.host; }

async function transporter() {
  if (!mailConfigurado()) throw new Error('SMTP no configurado: definí SMTP_HOST, SMTP_USER y SMTP_PASS en las variables de entorno del servidor.');
  if (_tx) return _tx;
  const nodemailer = (await import('nodemailer')).default; // dependencia opcional
  _tx = nodemailer.createTransport({
    host: config.smtp.host, port: config.smtp.port, secure: config.smtp.secure,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  });
  return _tx;
}

export async function enviarMail({ to, subject, html, text, attachments }) {
  if (!to) throw new Error('Falta el destinatario (el empleado no tiene e-mail cargado).');
  const tx = await transporter();
  const info = await tx.sendMail({ from: config.smtp.from || config.smtp.user, to, subject, html, text, attachments });
  return { messageId: info.messageId, accepted: info.accepted };
}

export async function verificarSMTP() {
  const tx = await transporter();
  await tx.verify();
  return true;
}
