import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { verificarValoresLegales } from './valoresLegales.routes.js';
import { enviarMail } from '../lib/mailer.js';

const router = Router();
router.use(requireAuth);
const diasEntre = (a, b) => Math.round((new Date(a).getTime() - new Date(b).getTime()) / 864e5);

// Alertas de vencimientos: ART, mediciones HyS, período de prueba, contratos a plazo.
async function construirAlertas(dias) {
    const horizonte = Number(dias) || 30; // ventana de aviso (días)
    const pParams = (await query('SELECT data FROM parametros_liq WHERE id=1')).rows[0]?.data || {};
    const mesesPP = Number(pParams.mesesPeriodoPrueba) || 6; // Ley Bases 27.742: 6 meses
    const hoy = new Date().toISOString().slice(0, 10);
    const limite = new Date(Date.now() + horizonte * 864e5).toISOString().slice(0, 10);
    const out = [];
    const sev = (d) => d < 0 ? 'vencido' : (d <= 7 ? 'urgente' : 'proximo');

    // ART por empresa
    for (const a of (await query(
      `SELECT a.*, em.nombre AS empresa FROM art_contratos a JOIN empresas em ON em.id=a.empresa_id
         WHERE a.activo=true AND a.fecha_fin IS NOT NULL AND a.fecha_fin <= $1`, [limite])).rows) {
      const d = diasEntre(a.fecha_fin, hoy);
      out.push({ tipo: 'ART', titulo: `ART ${a.art_nombre} — ${a.empresa}`, detalle: `Contrato ${a.nro_contrato || ''} vence`, fecha: a.fecha_fin, dias: d, severidad: sev(d) });
    }
    // Mediciones HyS
    for (const m of (await query(
      `SELECT * FROM chs_mediciones WHERE fecha_vencimiento IS NOT NULL AND fecha_vencimiento <= $1`, [limite])).rows) {
      const d = diasEntre(m.fecha_vencimiento, hoy);
      out.push({ tipo: 'Medición HyS', titulo: `${m.tipo || 'Medición'} — ${m.empresa || ''} ${m.lugar || ''}`.trim(), detalle: 'Medición a renovar', fecha: m.fecha_vencimiento, dias: d, severidad: sev(d) });
    }
    // Período de prueba (LCT 92 bis: 3 meses desde el ingreso)
    for (const e of (await query(
      `SELECT id, nom, leg_num, ingreso FROM empleados WHERE activo=true AND ingreso IS NOT NULL
         AND (ingreso + ($3 || ' months')::interval)::date <= $1 AND (ingreso + ($3 || ' months')::interval)::date >= $2`, [limite, hoy, mesesPP])).rows) {
      const finPP = new Date(new Date(e.ingreso).getTime()); finPP.setMonth(finPP.getMonth() + mesesPP);
      const f = finPP.toISOString().slice(0, 10); const d = diasEntre(f, hoy);
      out.push({ tipo: 'Período de prueba', titulo: `${e.nom} (leg. ${e.leg_num})`, detalle: `Fin del período de prueba (${mesesPP} meses — Ley Bases)`, fecha: f, dias: d, severidad: sev(d), empleadoId: e.id });
    }
    // Contratos a plazo fijo (si el legajo tiene data.fechaFinContrato)
    for (const e of (await query(
      `SELECT id, nom, leg_num, data FROM empleados WHERE activo=true
         AND (data->>'fechaFinContrato') IS NOT NULL AND (data->>'fechaFinContrato') <= $1`, [limite])).rows) {
      const f = e.data.fechaFinContrato; const d = diasEntre(f, hoy);
      out.push({ tipo: 'Contrato a plazo', titulo: `${e.nom} (leg. ${e.leg_num})`, detalle: 'Vencimiento de contrato a plazo fijo', fecha: f, dias: d, severidad: sev(d), empleadoId: e.id });
    }

    // Valores legales del período actual y el próximo (para no liquidar con datos viejos)
    const _now = new Date();
    for (const off of [0, 1]) {
      const d2 = new Date(_now.getFullYear(), _now.getMonth() + off, 1);
      const va = await verificarValoresLegales(d2.getFullYear(), d2.getMonth() + 1);
      if (va.faltan || va.desactualizado) {
        out.push({ tipo: 'Valores legales', titulo: `Valores legales ${String(d2.getMonth() + 1).padStart(2, '0')}/${d2.getFullYear()}`,
          detalle: va.mensaje || 'Verificá tope SIPA, SMVM, SCVO y FFEP del período', fecha: d2.toISOString().slice(0, 10),
          dias: off === 0 ? -1 : 0, severidad: va.faltan ? 'urgente' : 'proximo' });
      }
    }

    out.sort((a, b) => a.dias - b.dias);
    const resumen = { total: out.length, vencidos: out.filter((x) => x.severidad === 'vencido').length, urgentes: out.filter((x) => x.severidad === 'urgente').length };
    return { horizonte, resumen, alertas: out };
}

router.get('/', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try { res.json(await construirAlertas(req.query.dias)); } catch (e) { next(e); }
});

// Enviar el digest de alertas por correo (RR.HH./admin).
router.post('/enviar-mail', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const to = (req.body?.to || '').trim();
    if (!to) return res.status(400).json({ error: 'Indicá el destinatario' });
    const data = await construirAlertas(req.body?.dias || 30);
    if (!data.alertas.length) return res.json({ ok: true, sinAlertas: true });
    const COLOR = { vencido: '#b91c1c', urgente: '#b45309', proximo: '#1d4ed8' };
    const fmt = (s) => { const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}/${m[2]}/${m[1]}` : (s || ''); };
    const filas = data.alertas.map((a) => `<tr><td style="padding:3px 8px;color:${COLOR[a.severidad] || '#333'};font-weight:600">${a.tipo}</td><td style="padding:3px 8px">${a.titulo} — ${a.detalle}</td><td style="padding:3px 8px;white-space:nowrap">${fmt(a.fecha)}</td></tr>`).join('');
    const html = `<div style="font-family:sans-serif;max-width:680px"><h2>Alertas de vencimientos</h2><p>${data.resumen.total} alertas · ${data.resumen.vencidos} vencidas · ${data.resumen.urgentes} urgentes</p><table style="width:100%;border-collapse:collapse;font-size:14px">${filas}</table></div>`;
    await enviarMail({ to, subject: `RR.HH. — ${data.resumen.total} alertas de vencimientos`, html });
    res.json({ ok: true, enviadas: data.resumen.total });
  } catch (e) { next(e); }
});

export default router;
