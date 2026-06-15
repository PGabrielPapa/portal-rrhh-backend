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

    // Firma de RR.HH. — única para todas las empresas (igual que la vanilla).
    // Idempotente: solo completa donde no haya firma cargada (no pisa subidas manuales).
    try {
      const firma = JSON.parse(fs.readFileSync(path.join(dataDir, 'firmas.seed.json'), 'utf8'));
      if (firma.imagen) {
        for (const id of Object.values(empresaId)) {
          await client.query("UPDATE empresas SET firma = $1 WHERE id = $2 AND (firma IS NULL OR firma = '')", [firma.imagen, id]);
        }
        console.log('[seed] firma RR.HH. en empresas: ok');
      }
    } catch (e) { console.warn('[seed] firmas:', e.message); }


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

    // Convenios por sindicato (idempotente por código)
    try {
      const convs = JSON.parse(fs.readFileSync(path.join(dataDir, 'convenios.seed.json'), 'utf8'));
      for (const c of convs) {
        await client.query(
          `INSERT INTO convenios (codigo, nombre, cct, vigencia, data)
           VALUES ($1,$2,$3,$4,$5) ON CONFLICT (codigo) DO NOTHING`,
          [c.codigo, c.nombre, c.cct || null, c.vigencia || null,
           JSON.stringify({ mesLabel: c.mesLabel, acuerdo: c.acuerdo, tablas: c.tablas, adicionales: c.adicionales, noRemunerativos: c.noRemunerativos })]
        );
        const vex = await client.query('SELECT 1 FROM convenio_versiones WHERE codigo=$1 LIMIT 1', [c.codigo]);
        if (!vex.rowCount) {
          await client.query(
            `INSERT INTO convenio_versiones (codigo, vigencia, mes_label, origen, comentario, data)
             VALUES ($1,$2,$3,'inicial',$4,$5)`,
            [c.codigo, c.vigencia || '2026-01-01', c.mesLabel || null, c.acuerdo || null,
             JSON.stringify({ acuerdo: c.acuerdo, tablas: c.tablas, adicionales: c.adicionales, noRemunerativos: c.noRemunerativos })]
          );
        }
      }
      console.log(`[seed] convenios: ${convs.length}`);
    } catch (e) { console.warn('[seed] convenios:', e.message); }

    // Parámetros de Ganancias — período inicial (solo si no hay ninguno)
    try {
      const gex = await client.query('SELECT 1 FROM ganancias_periodos LIMIT 1');
      if (!gex.rowCount) {
        const gan = JSON.parse(fs.readFileSync(path.join(dataDir, 'ganancias.seed.json'), 'utf8'));
        const vig = /(\d{4})-S([12])/.exec(gan.periodo || '');
        const vigenciaDesde = vig ? `${vig[1]}-${vig[2] === '1' ? '01' : '07'}-01` : '2026-01-01';
        await client.query(
          `INSERT INTO ganancias_periodos (periodo, vigencia_desde, mni_anual, ded_esp_anual, ded_esp2_anual, carga_conyuge_anual, carga_hijo_anual, carga_hijo_inc_anual, escala)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [gan.periodo || '2026-S1', vigenciaDesde, gan.mniAnual || 0, gan.dedEspAnual || 0, gan.dedEsp2Anual || 0,
           gan.cargaConyugeAnual || 0, gan.cargaHijoAnual || 0, gan.cargaHijoIncAnual || 0, JSON.stringify(gan.escala || [])]
        );
        console.log('[seed] ganancias período inicial: ok');
      }
    } catch (e) { console.warn('[seed] ganancias:', e.message); }

    // Catálogo de sindicatos (idempotente)
    try {
      const SIND = [
        ['COMERCIO','Empleados de Comercio (SEC/FAECYS)',2.5,0.5,1,'Cuota sindical 2% + FAECYS 0,5%',true,'basico+antig+titulo'],
        ['UOM','Unión Obrera Metalúrgica',2.5,1.5,1,'Cuota sindical + FONDO',true,'basico+antig'],
        ['ASIMRA','Sup. Industria Metalmecánica',3,1.5,1,'Cuota sindical + fondo cultura',true,'basico+antig'],
        ['UOYEP','Unión Obreros y Emp. Plásticos',2,1.5,1,'Aporte UOYEP',false,'basico'],
        ['UOCRA','Unión Obrera de la Construcción (UOCRA)',2,2,1,'Cuota sindical construcción',false,'basico'],
        ['UECARA','Empl. de Conducción (UECARA)',2.5,1.5,1,'Personal jerárquico construcción',false,'basico'],
      ];
      for (const x of SIND) {
        await client.query(
          `INSERT INTO sindicatos (codigo, nombre, pct_empleado, pct_patronal, pct_antig_por_anio, nota, tiene_adicional_titulo, pres_base)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (codigo) DO NOTHING`, x);
      }
      console.log('[seed] sindicatos: ok');
    } catch (e) { console.warn('[seed] sindicatos:', e.message); }

    // Reglamento interno (vacaciones por antigüedad + licencias especiales) — solo si no existe
    try {
      const rex = await client.query('SELECT 1 FROM reglamento WHERE id=1');
      if (!rex.rowCount) {
        const data = {
          vacaciones: [
            { hasta: 5, dias: 14 }, { hasta: 10, dias: 21 }, { hasta: 20, dias: 28 }, { hasta: null, dias: 35 },
          ],
          licencias: [
            { tipo: 'Matrimonio', dias: 12, computo: 'corridos', art: 'Art. 158 inc. b LCT', nota: '12 días corridos' },
            { tipo: 'Nacimiento de hijo', dias: 2, computo: 'corridos', art: 'Art. 158 inc. a LCT', nota: '2 días corridos (al menos 1 hábil)' },
            { tipo: 'Fallecimiento familiar directo', dias: 4, computo: 'corridos', art: 'Art. 158 inc. c LCT', nota: 'Padres, cónyuge, hijos, hermanos/as' },
            { tipo: 'Fallecimiento familiar político', dias: 2, computo: 'corridos', art: 'Art. 158 inc. c LCT', nota: 'Abuelos, suegros, cuñados, hijastros' },
            { tipo: 'Examen', dias: 4, computo: 'corridos', art: 'Art. 158 inc. d LCT', nota: 'Hasta 4 días por examen, máx. 20 días por año' },
            { tipo: 'Donación de sangre', dias: 1, computo: 'corridos', art: 'Ley 22.990', nota: '1 día' },
            { tipo: 'Matrimonio de hijo', dias: 1, computo: 'hábil', art: 'CCT', nota: '1 día hábil' },
            { tipo: 'Mudanza', dias: 2, computo: 'corridos', art: 'CCT', nota: '2 días corridos' },
          ],
          texto: '',
        };
        await client.query('INSERT INTO reglamento (id, data) VALUES (1, $1)', [JSON.stringify(data)]);
        console.log('[seed] reglamento: ok');
      }
    } catch (e) { console.warn('[seed] reglamento:', e.message); }

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
