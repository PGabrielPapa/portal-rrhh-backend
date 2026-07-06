// Migración idempotente y segura de claves foráneas que faltaban (auditoría #6).
// Para cada FK: primero limpia huérfanos (referencias a filas inexistentes) y
// recién después agrega la constraint (si no existe). Cada ítem va en su propio
// try/catch para que un problema en uno no bloquee el arranque ni a los demás.
import { pool } from '../db.js';

// clean: sentencias que dejan la columna consistente (NULL en huérfanos, o borra
//        filas huérfanas de tablas de historial que ya no sirven).
// name:  nombre de la constraint (para chequear si ya existe).
// ddl:   ALTER TABLE ... ADD CONSTRAINT ...
const FKS = [
  { name: 'fk_recibos_corrida',
    clean: ["UPDATE recibos SET corrida_id=NULL WHERE corrida_id IS NOT NULL AND corrida_id NOT IN (SELECT id FROM corridas)"],
    ddl: "ALTER TABLE recibos ADD CONSTRAINT fk_recibos_corrida FOREIGN KEY (corrida_id) REFERENCES corridas(id) ON DELETE SET NULL" },
  { name: 'fk_anticipo_cuotas_recibo',
    clean: ["UPDATE anticipo_cuotas SET recibo_id=NULL WHERE recibo_id IS NOT NULL AND recibo_id NOT IN (SELECT id FROM recibos)"],
    ddl: "ALTER TABLE anticipo_cuotas ADD CONSTRAINT fk_anticipo_cuotas_recibo FOREIGN KEY (recibo_id) REFERENCES recibos(id) ON DELETE SET NULL" },
  { name: 'fk_anticipo_cuotas_corrida',
    clean: ["UPDATE anticipo_cuotas SET corrida_id=NULL WHERE corrida_id IS NOT NULL AND corrida_id NOT IN (SELECT id FROM corridas)"],
    ddl: "ALTER TABLE anticipo_cuotas ADD CONSTRAINT fk_anticipo_cuotas_corrida FOREIGN KEY (corrida_id) REFERENCES corridas(id) ON DELETE SET NULL" },
  { name: 'fk_beneficios_hist_emp',
    clean: ["DELETE FROM beneficios_hist WHERE empleado_id IS NOT NULL AND empleado_id NOT IN (SELECT id FROM empleados)"],
    ddl: "ALTER TABLE beneficios_hist ADD CONSTRAINT fk_beneficios_hist_emp FOREIGN KEY (empleado_id) REFERENCES empleados(id) ON DELETE CASCADE" },
  { name: 'fk_elementos_hist_emp',
    clean: ["DELETE FROM elementos_hist WHERE empleado_id IS NOT NULL AND empleado_id NOT IN (SELECT id FROM empleados)"],
    ddl: "ALTER TABLE elementos_hist ADD CONSTRAINT fk_elementos_hist_emp FOREIGN KEY (empleado_id) REFERENCES empleados(id) ON DELETE CASCADE" },
];

export async function migrarFKs() {
  let agregadas = 0;
  for (const fk of FKS) {
    try {
      const ya = await pool.query('SELECT 1 FROM pg_constraint WHERE conname=$1', [fk.name]);
      if (ya.rowCount) continue;
      for (const c of fk.clean) await pool.query(c);
      await pool.query(fk.ddl);
      agregadas++;
    } catch (e) {
      console.error(`[migrate-fks] no se pudo agregar ${fk.name}:`, e.message);
    }
  }
  return { agregadas };
}
