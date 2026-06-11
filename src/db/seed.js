// Seed: carga empresas y empleados desde los JSON generados a partir del seed
// vanilla (data/empleados.js). Idempotente (ON CONFLICT DO NOTHING).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { pool } from '../db.js';
import { config } from '../config.js';
import { empSlug } from '../lib/identity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '..', 'data');

function toDateISO(ddmmyyyy) {
  if (!ddmmyyyy) return null;
  const m = String(ddmmyyyy).match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(ddmmyyyy)) return ddmmyyyy;
  return null;
}

async function main() {
  const empleados = JSON.parse(fs.readFileSync(path.join(dataDir, 'empleados.seed.json'), 'utf8'));
  const empresas = [...new Set(empleados.map((e) => e.emp).filter(Boolean))].sort();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Empresas
    const empresaId = {};
    for (const nombre of empresas) {
      const r = await client.query(
        `INSERT INTO empresas (nombre, slug) VALUES ($1, $2)
         ON CONFLICT (nombre) DO UPDATE SET slug = EXCLUDED.slug
         RETURNING id`,
        [nombre, empSlug(nombre)]
      );
      empresaId[nombre] = r.rows[0].id;
    }
    console.log(`[seed] empresas: ${empresas.length}`);

    // Contraseña inicial = DNI (hasheada). must_change_pwd = true.
    let ok = 0, skip = 0;
    for (const e of empleados) {
      const eid = empresaId[e.emp];
      if (!eid || !e.dni || !e.leg) { skip++; continue; }
      const hash = await bcrypt.hash(String(e.dni), config.bcryptRounds);
      const core = ['leg', 'dni', 'cuil', 'nom', 'mail', 'cat', 'tramo', 'ing', 'bruto', 'neto', 'emp'];
      const data = {}; for (const k of Object.keys(e)) if (!core.includes(k)) data[k] = e[k];
      const r = await client.query(
        `INSERT INTO empleados
           (empresa_id, leg_num, dni, cuil, nom, email, cat, tramo, ingreso, bruto, neto,
            es_alta, password_hash, role, must_change_pwd, data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,false,$12,'employee',true,$13)
         ON CONFLICT (dni) DO NOTHING
         RETURNING id`,
        [eid, String(e.leg), String(e.dni), e.cuil || null, e.nom || '', e.mail || null,
         e.cat || null, e.tramo || null, toDateISO(e.ing), e.bruto || 0, e.neto || 0,
         hash, JSON.stringify(data)]
      );
      if (r.rowCount) ok++; else skip++;
    }
    await client.query('COMMIT');
    console.log(`[seed] empleados cargados: ${ok} · omitidos: ${skip}`);
    console.log('[seed] contraseña inicial = DNI (cambio forzado en primer login).');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  await pool.end();
}

main().catch((e) => { console.error('[seed] error:', e); process.exit(1); });
