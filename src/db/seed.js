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
      // CUIT por empresa (idempotente: solo donde no haya CUIT, no pisa cargas manuales).
      try {
        const cuits = JSON.parse(fs.readFileSync(path.join(dataDir, 'empresas_cuit.seed.json'), 'utf8'));
        const norm = (x) => String(x || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
        for (const [nombre, cuit] of Object.entries(cuits)) {
          await client.query(
            `UPDATE empresas SET cuit=$1 WHERE (cuit IS NULL OR cuit='') AND (upper(regexp_replace(nombre,'[^A-Za-z0-9]','','g'))=$2 OR ($3='IDEE' AND nombre ILIKE 'IDEE%'))`,
            [cuit, norm(nombre), norm(nombre)]);
        }
        console.log('[seed] CUIT de empresas: ok');
      } catch (e) { console.warn('[seed] cuit empresas:', e.message); }
      // Datos del firmante (nombre/cargo) en parámetros globales, para los documentos.
      if (firma.nombre) {
        await client.query("UPDATE parametros_liq SET data = data || $1::jsonb WHERE id = 1",
          [JSON.stringify({ firmante: { nombre: firma.nombre, cargo: firma.cargo || '' } })]);
        console.log('[seed] firmante de documentos: ok');
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

    // Catálogo de conceptos COMPLETO (réplica de la vanilla). Idempotente.
    const conceptos = JSON.parse(fs.readFileSync(path.join(dataDir, 'conceptos.seed.json'), 'utf8'));
    const tieneNuevo = await client.query("SELECT 1 FROM conceptos WHERE codigo='20000' LIMIT 1");
    if (!tieneNuevo.rowCount) {
      await client.query("DELETE FROM conceptos WHERE codigo IN ('001','002','003','010','020','100','101','102','103','200','300')");
    }
    for (const c of conceptos) {
      await client.query(
        `INSERT INTO conceptos (codigo, descripcion, tipo, formula, base_legal, data) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (codigo) DO NOTHING`,
        [c.codigo, c.descripcion, c.tipo, c.formula || null, c.base_legal || null, JSON.stringify({ categoria: c.categoria || null, columna: c.columna || null, ...(c.data || {}) })]
      );
    }
    console.log(`[seed] conceptos: ${conceptos.length}`);

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

    // Escalas a JUNIO 2026 (idempotente: solo crea la versión jun-2026 si no existe).
    // Aplica el incremento sobre la escala vigente y CONSERVA los montos no remunerativos.
    try {
      const incJun2026 = { SEC: 1.5, UOCRA: 2.1, UECARA: 2.1, UOYEP: 1.0, UOM: 0, ASIMRA: 0 };
      const notaJun = {
        SEC: 'Junio 2026: +1,5% (escalonado abr–jun, hom. 27/04/2026). NR vigentes.',
        UOCRA: 'Junio 2026: +2,1% s/básicos al 31/05 (acumulado 6,12% jun–ago). NR Zona A vigentes.',
        UECARA: 'Junio 2026: +2,1% s/básicos al 31/05 (+ absorción parcial de NR de mayo).',
        UOYEP: 'Junio 2026: +1% (tramo jun–ago del acuerdo mar–ago).',
        UOM: 'Junio 2026: sin cambios (paritaria congelada por intervención judicial; se liquida igual que abril).',
        ASIMRA: 'Junio 2026: sin acuerdo confirmado (sector metalúrgico sin paritaria nueva). Sin cambios hasta nuevo acuerdo homologado.',
      };
      for (const [codigo, pct] of Object.entries(incJun2026)) {
        const ya = await client.query("SELECT 1 FROM convenio_versiones WHERE codigo=$1 AND vigencia='2026-06-01' LIMIT 1", [codigo]);
        if (ya.rowCount) continue;
        const cv = await client.query('SELECT data FROM convenios WHERE codigo=$1', [codigo]);
        if (!cv.rows[0]) continue;
        const d = cv.rows[0].data || {};
        const factor = 1 + Number(pct) / 100;
        const tablas = (d.tablas || []).map((t) => ({ ...t, cats: (t.cats || []).map((c) => {
          const o = { ...c };
          if (typeof c.basico === 'number') o.basico = Math.round(c.basico * factor);
          if (typeof c.valorHora === 'number') o.valorHora = Math.round(c.valorHora * factor * 100) / 100;
          return o;
        }) }));
        const data = { acuerdo: notaJun[codigo] || `Actualización junio 2026 (+${pct}%)`, mesLabel: 'Junio 2026', tablas, adicionales: d.adicionales || [], noRemunerativos: d.noRemunerativos || [] };
        await client.query(
          "INSERT INTO convenio_versiones (codigo, vigencia, mes_label, origen, porcentaje, comentario, data) VALUES ($1,'2026-06-01','Junio 2026','porcentaje',$2,$3,$4)",
          [codigo, pct, `Escala junio 2026 (+${pct}% sobre la vigente)`, JSON.stringify(data)]);
        await client.query("UPDATE convenios SET vigencia='2026-06-01', data=$2, updated_at=now() WHERE codigo=$1", [codigo, JSON.stringify(data)]);
      }
      console.log('[seed] escalas junio 2026: ok');
    } catch (e) { console.warn('[seed] escalas jun 2026:', e.message); }

    // Parámetros de Ganancias — período inicial (solo si no hay ninguno)
    try {
      const gan = JSON.parse(fs.readFileSync(path.join(dataDir, 'ganancias.seed.json'), 'utf8'));
      const vig = /(\d{4})-S([12])/.exec(gan.periodo || '');
      const vigenciaDesde = vig ? `${vig[1]}-${vig[2] === '1' ? '01' : '07'}-01` : '2026-01-01';
      // UPSERT por período: corrige los valores si la fila ya existe (tablas vigentes ARCA).
      await client.query(
        `INSERT INTO ganancias_periodos (periodo, vigencia_desde, rg, mni_anual, ded_esp_anual, ded_esp2_anual, carga_conyuge_anual, carga_hijo_anual, carga_hijo_inc_anual, escala)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (periodo) DO UPDATE SET vigencia_desde=EXCLUDED.vigencia_desde, rg=EXCLUDED.rg,
           mni_anual=EXCLUDED.mni_anual, ded_esp_anual=EXCLUDED.ded_esp_anual, ded_esp2_anual=EXCLUDED.ded_esp2_anual,
           carga_conyuge_anual=EXCLUDED.carga_conyuge_anual, carga_hijo_anual=EXCLUDED.carga_hijo_anual,
           carga_hijo_inc_anual=EXCLUDED.carga_hijo_inc_anual, escala=EXCLUDED.escala, updated_at=now()`,
        [gan.periodo || '2026-S1', vigenciaDesde, gan.rg || null, gan.mniAnual || 0, gan.dedEspAnual || 0, gan.dedEsp2Anual || 0,
         gan.cargaConyugeAnual || 0, gan.cargaHijoAnual || 0, gan.cargaHijoIncAnual || 0, JSON.stringify(gan.escala || [])]
      );
      console.log('[seed] ganancias período (upsert): ok');
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

    // Tablas de codigos de ARCA/AFIP (desplegables del ABM y SICOSS) - idempotente.
    try {
      const codigos = JSON.parse(fs.readFileSync(path.join(dataDir, 'codigos_afip.seed.json'), 'utf8'));
      let nCod = 0;
      for (const [tipo, lista] of Object.entries(codigos)) {
        for (const it of lista) {
          await client.query(
            `INSERT INTO codigos_afip (tipo, codigo, nombre) VALUES ($1,$2,$3)
             ON CONFLICT (tipo, codigo) DO UPDATE SET nombre = EXCLUDED.nombre`,
            [tipo, it.codigo, it.nombre]);
          nCod++;
        }
      }
      console.log(`[seed] codigos AFIP: ${nCod}`);
    } catch (e) { console.warn('[seed] codigos AFIP:', e.message); }

    // Padron de obras sociales (RNOS) - idempotente. codigo_sicoss = digitos del RNOS (6).
    try {
      const oss = JSON.parse(fs.readFileSync(path.join(dataDir, 'obras_sociales.seed.json'), 'utf8'));
      let nOs = 0;
      for (const os of oss) {
        const sic = String(os.codigo || '').replace(/\D/g, '').padStart(6, '0').slice(-6);
        await client.query(
          `INSERT INTO obras_sociales (codigo, codigo_sicoss, nombre) VALUES ($1,$2,$3)
           ON CONFLICT (codigo) DO UPDATE SET nombre = EXCLUDED.nombre, codigo_sicoss = EXCLUDED.codigo_sicoss`,
          [os.codigo, sic, os.nombre]);
        nOs++;
      }
      await client.query(
        `INSERT INTO arca_tablas_meta (id, ultimo_chequeo_at, detalle) VALUES (1, now(), $1)
         ON CONFLICT (id) DO UPDATE SET ultimo_chequeo_at = now(), detalle = EXCLUDED.detalle`,
        [`seed inicial: ${nOs} obras sociales`]);
      console.log(`[seed] obras sociales (RNOS): ${nOs}`);
    } catch (e) { console.warn('[seed] obras sociales:', e.message); }

    // Integrantes del Comité de HyS (REG-002-CHS): set inicial por nombre. Solo si nunca se definió (respeta cambios manuales en ABM Usuarios).
    try {
      const comite = ['AGUIAR, LUNA%', 'BOZZUTO%', 'CLAUDINO%', 'GUILLEN%', 'DIAZ OLIVIERI%', 'MORINI%', 'RODRIGUEZ FERREYRA%', 'PAPA, PABLO GABRIEL%', 'PARERA, PABLO%', 'DIMASI%', 'MONTERO, AGUSTIN%', 'SAAVEDRA%', 'SECCHI%'];
      const cond = comite.map((_, i) => `nom ILIKE $${i + 1}`).join(' OR ');
      const upd = await client.query(`UPDATE empleados SET data = data || '{"comite_hys": true}'::jsonb WHERE NOT (data ? 'comite_hys') AND (${cond})`, comite);
      console.log(`[seed] Comité HyS marcados: ${upd.rowCount}`);
    } catch (e) { console.warn('[seed] comite hys:', e.message); }
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
