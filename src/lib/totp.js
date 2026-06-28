// TOTP (RFC 6238) sin dependencias externas — para 2FA de usuarios RR.HH./admin.
import crypto from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function generarSecret(bytes = 20) {
  const buf = crypto.randomBytes(bytes);
  let bits = '', out = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

function base32Decode(s) {
  const clean = String(s || '').toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = '';
  for (const c of clean) { const idx = B32.indexOf(c); if (idx < 0) continue; bits += idx.toString(2).padStart(5, '0'); }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function hotp(secret, counter) {
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const off = hmac[hmac.length - 1] & 0x0f;
  const bin = ((hmac[off] & 0x7f) << 24) | (hmac[off + 1] << 16) | (hmac[off + 2] << 8) | hmac[off + 3];
  return String(bin % 1_000_000).padStart(6, '0');
}

// Verifica un token de 6 dígitos con ventana ±1 (tolerancia de reloj).
export function verificarToken(secret, token, ventana = 1) {
  const t = String(token || '').replace(/\D/g, '');
  if (t.length !== 6 || !secret) return false;
  const counter = Math.floor(Date.now() / 1000 / 30);
  for (let w = -ventana; w <= ventana; w++) {
    if (crypto.timingSafeEqual(Buffer.from(hotp(secret, counter + w)), Buffer.from(t))) return true;
  }
  return false;
}

// otpauth:// URI para el QR del autenticador.
export function otpauthURI(secret, cuenta, emisor = 'Portal RRHH') {
  return `otpauth://totp/${encodeURIComponent(emisor)}:${encodeURIComponent(cuenta)}?secret=${secret}&issuer=${encodeURIComponent(emisor)}&digits=6&period=30`;
}
