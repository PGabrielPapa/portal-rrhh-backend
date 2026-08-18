// Cliente de IA agnóstico del proveedor (Anthropic / OpenAI o compatible).
// La clave y el modelo se configuran por variables de entorno (ver config.ia).
// Si no hay clave, iaDisponible() = false y las funciones lanzan un error claro.
import { config } from '../config.js';

const DEFAULT_MODEL = {
  anthropic: 'claude-3-5-haiku-latest',
  openai: 'gpt-4o-mini',
};

// Timeout de las llamadas al proveedor de IA: sin él, una respuesta que no llega
// deja la petición del usuario colgada y ocupa una conexión del portal.
const TIMEOUT_MS = Number(process.env.IA_TIMEOUT_MS || 60_000);
async function fetchConTimeout(url, opts) {
  const ac = new AbortController();
  const id = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try { return await fetch(url, { ...opts, signal: ac.signal }); }
  catch (e) { throw new Error(e.name === 'AbortError' ? 'La IA no respondió a tiempo.' : `No se pudo contactar al proveedor de IA (${e.message}).`); }
  finally { clearTimeout(id); }
}

export function iaDisponible() {
  return !!(config.ia && config.ia.apiKey);
}
export function iaInfo() {
  return { disponible: iaDisponible(), provider: config.ia?.provider || null, modelo: modelo() };
}
function modelo() {
  return config.ia?.model || DEFAULT_MODEL[config.ia?.provider] || DEFAULT_MODEL.anthropic;
}

// Llama al modelo con un prompt de sistema + uno de usuario y devuelve el texto.
export async function iaCompletar({ system, prompt, maxTokens }) {
  if (!iaDisponible()) throw new Error('La IA no está configurada. Definí IA_API_KEY en el backend.');
  const provider = config.ia.provider;
  const max = maxTokens || config.ia.maxTokens || 1200;
  if (provider === 'openai') return openai(system, prompt, max);
  return anthropic(system, prompt, max);
}

async function anthropic(system, prompt, max) {
  const base = config.ia.baseUrl || 'https://api.anthropic.com';
  const r = await fetchConTimeout(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': config.ia.apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: modelo(), max_tokens: max, system: system || '', messages: [{ role: 'user', content: prompt }] }),
  });
  if (!r.ok) {
    // El cuerpo de error del proveedor suele repetir el prompt (con datos del
    // legajo). Se registra en el servidor, pero al usuario solo le llega el código.
    console.error('[ia] Anthropic respondió', r.status, (await r.text()).slice(0, 500));
    throw new Error(`La IA respondió con un error (HTTP ${r.status}).`);
  }
  const data = await r.json();
  return (data.content || []).map((c) => c.text || '').join('').trim();
}

async function openai(system, prompt, max) {
  const base = config.ia.baseUrl || 'https://api.openai.com';
  const r = await fetchConTimeout(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.ia.apiKey}` },
    body: JSON.stringify({ model: modelo(), max_tokens: max, messages: [{ role: 'system', content: system || '' }, { role: 'user', content: prompt }] }),
  });
  if (!r.ok) {
    console.error('[ia] OpenAI respondió', r.status, (await r.text()).slice(0, 500));
    throw new Error(`La IA respondió con un error (HTTP ${r.status}).`);
  }
  const data = await r.json();
  return (data.choices?.[0]?.message?.content || '').trim();
}
