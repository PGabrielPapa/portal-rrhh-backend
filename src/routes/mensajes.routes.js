import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// GET /api/mensajes — mensajes propios + broadcast (más nuevos primero)
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, titulo, cuerpo, autor, created_at, (empleado_id IS NULL) AS broadcast
         FROM mensajes
        WHERE empleado_id = $1 OR empleado_id IS NULL
        ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (e) { next(e); }
});

// POST /api/mensajes  (rrhh/admin) — enviar a un DNI o a todos (broadcast)
// body: { titulo, cuerpo, destinatarioDni? }  (sin DNI = broadcast)
router.post('/', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const { titulo, cuerpo, destinatarioDni } = req.body || {};
    if (!titulo || !cuerpo) return res.status(400).json({ error: 'Título y cuerpo son obligatorios' });

    let empleadoId = null;
    if (destinatarioDni) {
      const r = await query('SELECT id FROM empleados WHERE dni = $1', [String(destinatarioDni).trim()]);
      if (!r.rows[0]) return res.status(404).json({ error: `No existe un empleado con DNI ${destinatarioDni}` });
      empleadoId = r.rows[0].id;
    }
    const autor = req.user.dni;
    const ins = await query(
      `INSERT INTO mensajes (empleado_id, titulo, cuerpo, autor) VALUES ($1,$2,$3,$4) RETURNING id`,
      [empleadoId, String(titulo).trim(), String(cuerpo).trim(), autor]
    );
    res.status(201).json({ ok: true, id: ins.rows[0].id, broadcast: empleadoId === null });
  } catch (e) { next(e); }
});

export default router;
