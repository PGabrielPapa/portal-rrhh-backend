import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { iaCompletar, iaInfo, iaDisponible } from '../lib/ia.js';

const router = Router();
router.use(requireAuth);

// Tope de texto libre que viaja al modelo: acota el costo por llamada y el
// tamano del prompt que un usuario puede inyectar.
const MAX_TEXTO = 8000;

const SYS = 'Sos un asistente de Recursos Humanos en Argentina. Respondés en español rioplatense, claro y profesional. No inventás datos: te basás solo en la información provista. Cuando resumís, sos conciso y accionable.';

// Estado (para que el front muestre u oculte los botones de IA).
router.get('/estado', (req, res) => res.json(iaInfo()));

// Guard para las funciones que consumen IA (solo RR.HH./admin salvo el asistente general).
const rh = requireRole('rrhh', 'admin');

// Resumen de una encuesta (comentarios + promedios), respetando el anonimato ya existente.
router.post('/resumir-encuesta', rh, async (req, res, next) => {
  try {
    if (!iaDisponible()) return res.status(503).json({ error: 'IA no configurada' });
    const id = Number((req.body || {}).encuestaId);
    const enc = (await query('SELECT titulo, tipo FROM encuestas WHERE id=$1', [id])).rows[0];
    if (!enc) return res.status(404).json({ error: 'Encuesta no encontrada' });
    const preg = (await query('SELECT id, texto, tipo FROM encuesta_preguntas WHERE encuesta_id=$1 ORDER BY orden, id', [id])).rows;
    const partes = [`Encuesta: ${enc.titulo} (tipo ${enc.tipo}).`];
    for (const p of preg) {
      if (p.tipo === 'texto') {
        const t = (await query('SELECT texto FROM encuesta_respuestas WHERE pregunta_id=$1 AND texto IS NOT NULL', [p.id])).rows.map((r) => `- ${r.texto}`);
        if (t.length) partes.push(`\nPregunta abierta "${p.texto}" (${t.length} respuestas):\n${t.join('\n')}`);
      } else {
        const rows = (await query('SELECT valor, count(*)::int n FROM encuesta_respuestas WHERE pregunta_id=$1 AND valor IS NOT NULL GROUP BY valor', [p.id])).rows;
        let suma = 0, tot = 0; for (const r of rows) { suma += r.valor * r.n; tot += r.n; }
        partes.push(`\nPregunta "${p.texto}" (${p.tipo}): promedio ${tot ? (suma / tot).toFixed(2) : 's/d'} sobre ${tot} respuestas.`);
      }
    }
    const prompt = `Resumí los resultados de esta encuesta para RR.HH.: 3-5 puntos con lo más importante, lo positivo, lo que preocupa y 2-3 acciones sugeridas.\n\n${partes.join('\n')}`;
    res.json({ texto: await iaCompletar({ system: SYS, prompt }) });
  } catch (e) { next(e); }
});

// Análisis de clima con acciones sugeridas.
router.post('/analizar-clima', rh, async (req, res, next) => {
  try {
    if (!iaDisponible()) return res.status(503).json({ error: 'IA no configurada' });
    const id = Number((req.body || {}).encuestaId);
    const preg = (await query('SELECT id, texto, tipo FROM encuesta_preguntas WHERE encuesta_id=$1', [id])).rows;
    const dims = [];
    for (const p of preg) {
      if (p.tipo === 'texto') continue;
      const rows = (await query('SELECT valor, count(*)::int n FROM encuesta_respuestas WHERE pregunta_id=$1 AND valor IS NOT NULL GROUP BY valor', [p.id])).rows;
      let suma = 0, tot = 0; for (const r of rows) { suma += r.valor * r.n; tot += r.n; }
      if (tot) dims.push(`${p.texto}: ${(suma / tot).toFixed(2)}`);
    }
    const prompt = `Estos son los promedios por dimensión de una encuesta de clima. Interpretá el clima general, señalá fortalezas y focos de mejora, y proponé un plan de acción de 3 pasos.\n\n${dims.join('\n') || 'Sin datos numéricos.'}`;
    res.json({ texto: await iaCompletar({ system: SYS, prompt }) });
  } catch (e) { next(e); }
});

// Resumen de un feedback 360 (resultados agregados + comentarios anónimos).
router.post('/resumir-feedback', rh, async (req, res, next) => {
  try {
    if (!iaDisponible()) return res.status(503).json({ error: 'IA no configurada' });
    const id = Number((req.body || {}).solicitudId);
    const rows = (await query('SELECT relacion, respuestas FROM feedback_respuestas WHERE solicitud_id=$1', [id])).rows;
    if (!rows.length) return res.status(400).json({ error: 'Todavía no hay respuestas para resumir.' });
    const agg = {}; const coment = [];
    for (const r of rows) for (const a of (r.respuestas || [])) {
      const c = a.competencia || 'General'; agg[c] = agg[c] || { s: 0, n: 0 }; agg[c].s += Number(a.puntaje) || 0; agg[c].n++;
      if (a.comentario) coment.push(`(${r.relacion}) ${a.comentario}`);
    }
    const prom = Object.entries(agg).map(([c, v]) => `${c}: ${(v.s / v.n).toFixed(2)}/5`).join('\n');
    const prompt = `Resumí este feedback 360 para una devolución de desarrollo: fortalezas, oportunidades y 2-3 recomendaciones concretas. No identifiques a los evaluadores.\n\nPromedios por competencia:\n${prom}\n\nComentarios:\n${coment.join('\n') || 'sin comentarios'}`;
    res.json({ texto: await iaCompletar({ system: SYS, prompt }) });
  } catch (e) { next(e); }
});

// Generación de borradores (comunicado, descripción de puesto, objetivos, devolución, etc.).
router.post('/borrador', rh, async (req, res, next) => {
  try {
    if (!iaDisponible()) return res.status(503).json({ error: 'IA no configurada' });
    const b = req.body || {};
    const tipos = {
      comunicado: 'un comunicado interno para el personal',
      'descripcion-puesto': 'una descripción de puesto (misión, principales funciones, requisitos y competencias)',
      objetivo: 'un objetivo con 2 o 3 resultados clave medibles (formato OKR)',
      devolucion: 'una devolución de desempeño constructiva y respetuosa',
      politica: 'una política interna breve',
    };
    // `Object.hasOwn`: con b.tipo="constructor" el indice directo devolvia una
    // funcion del prototipo de Object y se interpolaba en el prompt.
    const que = (Object.hasOwn(tipos, String(b.tipo)) && tipos[b.tipo]) || 'un texto de RR.HH.';
    const instrucciones = String(b.instrucciones || '').trim().slice(0, MAX_TEXTO);
    if (!instrucciones) return res.status(400).json({ error: 'Contame de que se trata (instrucciones)' });
    const contexto = String(b.contexto || '').slice(0, MAX_TEXTO);
    const prompt = `Redactá ${que} en español rioplatense, tono profesional y claro. Es un borrador para que RR.HH. edite.\n\nTema / instrucciones: ${instrucciones}${contexto ? `\nContexto: ${contexto}` : ''}`;
    res.json({ texto: await iaCompletar({ system: SYS, prompt }) });
  } catch (e) { next(e); }
});

// Resumen de CV + ajuste al perfil (apoyo a selección; nunca decisión automática).
router.post('/resumir-cv', rh, async (req, res, next) => {
  try {
    if (!iaDisponible()) return res.status(503).json({ error: 'IA no configurada' });
    const b = req.body || {};
    if (!b.texto || !String(b.texto).trim()) return res.status(400).json({ error: 'Pegá el texto del CV' });
    let perfil = String(b.perfil || '').slice(0, MAX_TEXTO);
    if (!perfil && b.puestoId) { const p = (await query('SELECT nombre, perfil FROM puestos WHERE id=$1', [b.puestoId])).rows[0]; if (p) perfil = `${p.nombre}. ${JSON.stringify(p.perfil || {})}`; }
    const prompt = `Resumí este CV en 5 líneas (experiencia, formación, fortalezas). ${perfil ? `Después, estimá el ajuste al siguiente perfil y explicá por qué, con una recomendación (avanzar / dudoso / no avanza). Es un apoyo, la decisión es humana.\nPerfil del puesto: ${perfil}` : ''}\n\nCV:\n${String(b.texto).slice(0, 6000)}`;
    res.json({ texto: await iaCompletar({ system: SYS, prompt }) });
  } catch (e) { next(e); }
});

// Asistente general de RR.HH. (no accede a datos sensibles; responde con criterio general).
router.post('/asistente', async (req, res, next) => {
  try {
    if (!iaDisponible()) return res.status(503).json({ error: 'IA no configurada' });
    // Sin tope, una sola consulta podia mandar megabytes y disparar el costo de
    // la API del proveedor y el tiempo de respuesta del portal.
    const preg = String((req.body || {}).pregunta || '').trim().slice(0, 4000);
    if (!preg) return res.status(400).json({ error: 'Escribí una pregunta' });
    const prompt = `Respondé la consulta de un usuario del portal de RR.HH. Si la pregunta requiere datos personales concretos (saldos, sueldos), aclará que debe consultarlos en la sección correspondiente del portal.\n\nConsulta: ${preg}`;
    res.json({ texto: await iaCompletar({ system: SYS, prompt, maxTokens: 800 }) });
  } catch (e) { next(e); }
});

export default router;
