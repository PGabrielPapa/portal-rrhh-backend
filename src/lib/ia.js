// Cliente de IA agnóstico del proveedor (Anthropic / OpenAI o compatible).
// La clave y el modelo se configuran por variables de entorno (ver config.ia).
// Si no hay clave, iaDisponible() = false y las funciones lanzan un error claro.
import { config } from '../config.js';

const DEFAULT_MODEL = {
  anthropic: 'claude-3-5-haiku-latest',
  openai: 'gpt-4o-mini',
};

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
  const r = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': config.ia.apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: modelo(), max_tokens: max, system: system || '', messages: [{ role: 'user', content: prompt }] }),
  });
  if (!r.ok) throw new Error(`IA (Anthropic) respondió ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const data = await r.json();
  return (data.content || []).map((c) => c.text || '').join('').trim();
}

async function openai(system, prompt, max) {
  const base = config.ia.baseUrl || 'https://api.openai.com';
  const r = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.ia.apiKey}` },
    body: JSON.stringify({ model: modelo(), max_tokens: max, messages: [{ role: 'system', content: system || '' }, { role: 'user', content: prompt }] }),
  });
  if (!r.ok) throw new Error(`IA (OpenAI) respondió ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const data = await r.json();
  return (data.choices?.[0]?.message?.content || '').trim();
}
