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
    // Logos por empresa (data:image base64)
    try {
      const logos = JSON.parse(fs.readFileSync(path.join(dataDir, 'logos.seed.json'), 'utf8'));
      for (const [nombre, logo] of Object.entries(logos)) {
        if (empresaId[nombre]) await client.query('UPDATE empresas SET logo = $1 WHERE id = $2', [logo, empresaId[nombre]]);
      }
      console.log('[seed] logos de empresas: ok');
    } catch (e) { console.warn('[seed] logos:', e.message); }


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
    // Parámetros de liquidación (fila única id=1)
    const params = JSON.parse(fs.readFileSync(path.join(dataDir, 'params.seed.json'), 'utf8'));
    await client.query(
      `INSERT INTO parametros_liq (id, data) VALUES (1, $1) ON CONFLICT (id) DO NOTHING`,
      [JSON.stringify(params)]
    );
    console.log('[seed] parámetros de liquidación: ok');

    // Catálogo de conceptos estándar (idempotente)
    const conceptos = [
      ['001', 'Sueldo básico', 'remunerativo', 'Art. 103 LCT'],
      ['002', 'Antigüedad', 'remunerativo', 'CCT'],
      ['003', 'Presentismo', 'remunerativo', 'CCT'],
      ['010', 'SAC', 'remunerativo', 'Ley 23.041'],
      ['020', 'Asignación no remunerativa', 'no_remunerativo', 'Art. 103 bis LCT'],
      ['100', 'Jubilación', 'aporte', 'Ley 24.241'],
      ['101', 'Obra Social', 'aporte', 'Ley 23.660'],
      ['102', 'INSSJP (PAMI)', 'aporte', 'Ley 19.032'],
      ['103', 'Cuota sindical', 'aporte', 'Ley 23.551'],
      ['200', 'Anticipo de sueldo', 'descuento', 'Art. 130 LCT'],
      ['300', 'Impuesto a las Ganancias 4ta', 'descuento', 'RG 4003/2017'],
    ];
    for (const [codigo, descripcion, tipo, base_legal] of conceptos) {
      await client.query(
        `INSERT INTO conceptos (codigo, descripcion, tipo, base_legal) VALUES ($1,$2,$3,$4)
         ON CONFLICT (codigo) DO NOTHING`,
        [codigo, descripcion, tipo, base_legal]
      );
    }
    console.log('[seed] conceptos: ok');

    // Escala salarial inicial (solo si no hay ninguna versión)
    try {
      const exist = await client.query("SELECT 1 FROM escala_versiones LIMIT 1");
      if (!exist.rowCount) {
        const esc = JSON.parse(fs.readFileSync(path.join(dataDir, 'escala.seed.json'), 'utf8'));
        await client.query(
          `INSERT INTO escala_versiones (vigencia, mes_label, origen, porcentaje, alcance, comentario, data, creado_por)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [esc.vigencia, esc.mesLabel, esc.origen || 'inicial', esc.porcentaje, esc.alcance || 'todas', esc.comentario || null,
           JSON.stringify({ tramos: esc.tramos, categorias: esc.categorias, regionales: esc.regionales, montos_titulo: esc.montos_titulo }), null]
        );
        console.log('[seed] escala inicial: ok');
      } else { console.log('[seed] escala: ya existe'); }
    } catch (e) { console.warn('[seed] escala:', e.message); }

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
