# Plan de migración — Portal RR.HH. (vanilla → backend/front)

Migración por fases de la SPA vanilla a la arquitectura cliente/servidor
(Express + Postgres + React/Vite). Cada módulo = endpoints en el backend +
página en el frontend que reemplaza su placeholder 🚧.

## Estado

- [x] **Fase 0 — Base:** auth (JWT+bcrypt), ABM Empleados, shell de navegación por roles.

### Fase 1 — Panel del empleado
- [x] Mis datos (perfil propio)
- [ ] Mis recibos (listar / ver / descargar)
- [x] Mensajes
- [x] Mis CBUs
- [x] Adelantos (solicitud + aprobación)
- [ ] Mis licencias

### Fase 2 — Núcleo de liquidación (RR.HH.)
- [ ] Parámetros de liquidación
- [ ] Conceptos
- [ ] Escalas / convenios
- [ ] Motor de liquidación (port de calcularItemLiquidacion)
- [ ] Generación de recibos
- [ ] Ganancias / F.1357 (+ tope 35% RG4003, SCVO)

### Fase 3 — Flujos RR.HH. / Gerencia
- [ ] Adelantos + Aprobaciones
- [ ] Licencias (solicitud / aprobación / reglamento)
- [ ] Sanciones
- [ ] Evaluaciones de desempeño
- [ ] Organigrama / equipo

### Fase 4 — Salidas / reportes
- [ ] F.931
- [ ] Libro de sueldos
- [ ] Asiento contable
- [ ] Archivos de banco / CBU novedades
- [ ] DDJJ sindical
- [ ] Generador de reportes

### Fase 5 — Administración
- [ ] Usuarios
- [ ] Niveles de usuario
- [ ] Auditoría
- [ ] Empresas (ABM)

## Convenciones
- **Identidad:** empresa+legajo (ver esquema). DNI = login.
- **Roles:** employee | manager | rrhh | admin (en `empleados.role`).
- Cada módulo: tabla(s) + rutas en `/backend/src/routes` + página en
  `/frontend/src/pages`, registrada en `lib/sections.ts` (ready:true) y mapeada
  en `components/SectionView.tsx`.
- Verificar: `node --check` backend, `npm run build` frontend, y prueba manual
  con `docker compose up`.
