// Importación de fichadas desde Pro-Soft (Reporte Marcas Extendido).
// Flujo: RR.HH. sube el Excel del período → se parsea y se cruza por legajo
// contra los empleados del portal → preview (matcheados / sin match / a revisar).
// Con ?confirmar=true se persisten las novedades en fichadas_periodo.
//
// Esta etapa NO toca el motor de liquidación: las horas extra quedan guardadas
// como informativas hasta tener el circuito de autorización del gerente.
import { Router } from 'express';
import multer from 'multer';
import * as XLSX from 'xlsx';
import { pool, query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { parseExtendido, normLegajo, minToHhmm } from '../lib/fichadasProsoft.js';

const router = Router();
router.use(requireAuth);

// Archivo en memoria (no se persiste el .xlsx). Límite 30 MB.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

// Da formato de presentación a un agregado por empleado.
function vista(a) {
  return {
    diasTrabajados: a.diasTrabajados,
    hsNetas: minToHhmm(a.hsNetasMin),
    horasExtra50: minToHhmm(a.horasExtra50Min),
    horasExtra100: minToHhmm(a.horasExtra100Min),
    horasExtra50Min: a.horasExtra50Min,
    horasExtra100Min: a.horasExtra100Min,
    hsNetasMin: a.hsNetasMin,
    horasExtraDescartada: minToHhmm(a.horasExtraDescartadaMin),
    horasExtraDescartadaMin: a.horasExtraDescartadaMin,
    bancoNeto: minToHhmm(a.bancoNetoMin),
    bancoNetoMin: a.bancoNetoMin,
    tardanzas: minToHhmm(a.tardanzasMin),
    tardanzasMin: a.tardanzasMin,
    diasTardanza: a.diasTardanza,
    diasARevisar: a.diasARevisar,
    dias: a.dias,
  };
}

// POST /api/fichadas/importar?confirmar=true|false   (multipart: archivo, anio, mes)
router.post('/importar', requireRole('rrhh', 'admin'), upload.single('archivo'), async (req, res, next) => {
  try {
    const anio = Number(req.body.anio);
    const mes = Number(req.body.mes);
    const confirmar = String(req.query.confirmar || req.body.confirmar || '') === 'true';
    if (!req.file) return res.status(400).json({ error: 'Subí el archivo Excel (campo "archivo").' });
    if (!anio || !mes || mes < 1 || mes > 12) return res.status(400).json({ error: 'Indicá año y mes válidos.' });

    // Leer el Excel desde el buffer en memoria.
    let rows;
    try {
      const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
      const ws = wb.Sheets[wb.SheetNames[0]];
      rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true });
    } catch {
      return res.status(400).json({ error: 'No pude leer el Excel. ¿Es el "Reporte Marcas Extendido" de Pro-Soft?' });
    }

    const parsed = parseExtendido(rows);
    if (parsed.columnasFaltantes.length) {
      return res.status(400).json({ error: `Al Excel le faltan columnas esperadas: ${parsed.columnasFaltantes.join(', ')}. Asegurate de exportar el "Extendido".` });
    }

    // Mapa de empleados del portal por legajo normalizado.
    const { rows: emps } = await query(
      `SELECT e.id, e.leg_num, e.nom, em.nombre AS empresa FROM empleados e JOIN empresas em ON em.id = e.empresa_id`
    );
    const porLeg = new Map();
    for (const e of emps) porLeg.set(normLegajo(e.leg_num), e);

    const matcheados = [];
    const sinMatch = [];
    for (const [leg, a] of Object.entries(parsed.porLegajo)) {
      const emp = porLeg.get(leg);
      const v = vista(a);
      if (emp) {
        matcheados.push({ empleadoId: emp.id, legNum: emp.leg_num, nom: emp.nom, empresa: emp.empresa, legajoProsoft: a.legajoProsoft, ...v });
      } else {
        sinMatch.push({ legajoProsoft: a.legajoProsoft, empleado: a.empleado, empresaProsoft: a.empresaProsoft, area: a.area, ...v });
      }
    }
    matcheados.sort((x, y) => x.nom.localeCompare(y.nom));
    sinMatch.sort((x, y) => x.empleado.localeCompare(y.empleado));
    const conRevisar = matcheados.filter((m) => m.diasARevisar.length).length;

    const resumen = {
      filas: parsed.filas,
      legajos: parsed.legajos,
      matcheados: matcheados.length,
      sinMatch: sinMatch.length,
      conRevisar,
    };

    // Si no se confirma, devolvemos solo el preview (no se persiste).
    if (!confirmar) {
      return res.json({ confirmado: false, periodo: { anio, mes }, resumen, matcheados, sinMatch });
    }

    // Persistir: upsert por (empleado, período) + log de importación, en transacción.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const m of matcheados) {
        const data = {
          legajoProsoft: m.legajoProsoft,
          diasTrabajados: m.diasTrabajados,
          hsNetasMin: m.hsNetasMin,
          horasExtra50Min: m.horasExtra50Min,
          horasExtra100Min: m.horasExtra100Min,
          horasExtraDescartadaMin: m.horasExtraDescartadaMin,
          bancoNetoMin: m.bancoNetoMin,
          tardanzasMin: m.tardanzasMin,
          diasTardanza: m.diasTardanza,
          diasARevisar: m.diasARevisar,
          dias: m.dias,
        };
        await client.query(
          `INSERT INTO fichadas_periodo (empleado_id, anio, mes, data, origen, importado_por)
           VALUES ($1,$2,$3,$4,'prosoft-extendido',$5)
           ON CONFLICT (empleado_id, anio, mes)
           DO UPDATE SET data = EXCLUDED.data, origen = EXCLUDED.origen, importado_por = EXCLUDED.importado_por`,
          [m.empleadoId, anio, mes, JSON.stringify(data), req.user.dni || null]
        );
      }
      await client.query(
        `INSERT INTO fichadas_importaciones (anio, mes, archivo, filas, legajos, matcheados, sin_match, importado_por, detalle)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [anio, mes, req.file.originalname || null, parsed.filas, parsed.legajos, matcheados.length, sinMatch.length,
         req.user.dni || null, JSON.stringify({ sinMatch: sinMatch.map((s) => ({ legajo: s.legajoProsoft, empleado: s.empleado })) })]
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    return res.json({ confirmado: true, periodo: { anio, mes }, resumen, matcheados, sinMatch });
  } catch (e) { next(e); }
});

// GET /api/fichadas/:anio/:mes — novedades importadas del período.
router.get('/:anio/:mes', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const anio = Number(req.params.anio), mes = Number(req.params.mes);
    const { rows } = await query(
      `SELECT f.empleado_id, e.leg_num, e.nom, em.nombre AS empresa, f.data, f.importado_por, f.updated_at
         FROM fichadas_periodo f
         JOIN empleados e ON e.id = f.empleado_id
         JOIN empresas em ON em.id = e.empresa_id
        WHERE f.anio = $1 AND f.mes = $2
        ORDER BY e.nom`,
      [anio, mes]
    );
    res.json(rows);
  } catch (e) { next(e); }
});

// GET /api/fichadas/importaciones/log — historial de importaciones.
router.get('/importaciones/log', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const { rows } = await query(`SELECT * FROM fichadas_importaciones ORDER BY created_at DESC LIMIT 50`);
    res.json(rows);
  } catch (e) { next(e); }
});

export default router;
