# Respaldo y restauración de la base — Portal RR.HH.

## Qué hace el sistema solo
- Al arrancar el backend queda activado un **respaldo automático diario** de la base con `pg_dump`.
- Los respaldos se guardan en la carpeta **`portal-rrhh-backend/backups/`**, con nombre
  `portal_rrhh_AAAA-MM-DD_hhmm.sql` (o `.sql.enc` si están cifrados, ver abajo).
- Se conservan los **últimos 14** respaldos (los más viejos se borran solos).
- Requisito: que `pg_dump` esté instalado y accesible (viene con PostgreSQL). Si el backend no lo encuentra, lo avisa en el log y no rompe nada.

## ⚠ Cifrado del respaldo (importante)

Un respaldo contiene **toda la base**: sueldos, DNI, CUIL, CBU, certificados médicos,
sanciones y los hashes de contraseña. Quien acceda al disco, a un volumen mal montado o a
una copia del contenedor se lleva el padrón completo sin necesidad de credenciales.

Por eso, si definís `BACKUP_PASSPHRASE` en el `.env`, el respaldo se cifra con
**AES-256-GCM** (clave derivada con scrypt) **mientras se escribe**: nunca existe una
versión en claro en el disco. El archivo queda como `.sql.enc`, con permisos `0600` y la
carpeta `0700`.

> **Guardá la passphrase fuera del servidor.** Sin ella, un respaldo cifrado **no se puede
> restaurar**. No la pongas en el mismo lugar que los respaldos.

Si no definís `BACKUP_PASSPHRASE`, el respaldo se hace igual pero en texto plano, y el
backend lo avisa en el log en cada corrida.

## Configuración (en el archivo `.env` del backend)
```
BACKUP_AUTO=true        # false para desactivar el respaldo automático
BACKUP_HORA=3           # hora del día (0-23) en que corre el respaldo
BACKUP_RETENCION=14     # cuántos respaldos conservar
BACKUP_PASSPHRASE=      # si la definís, el respaldo se cifra (AES-256-GCM)
# BACKUP_DIR=           # carpeta destino (por defecto: backend/backups)
```

## Hacer un respaldo manual (Git Bash)
```bash
cd ~/Desktop/RRHH-Portal-New/portal-rrhh-backend
npm run backup
```
Te va a decir la ruta del archivo generado y si quedó cifrado.

## Restaurar un respaldo
> Importante: restaurar **reemplaza** los datos actuales por los del respaldo. Hacé un respaldo nuevo antes, por las dudas.

### Opción recomendada: el asistente
Sirve para respaldos cifrados y sin cifrar. Lista los disponibles, pide confirmación,
respalda el estado actual y recién entonces restaura. Si el archivo está cifrado, lo
descifra a un temporal con permisos `0600` que borra siempre, incluso si algo falla:

```bash
cd ~/Desktop/RRHH-Portal-New/portal-rrhh-backend
npm run restore
```

Necesita `BACKUP_PASSPHRASE` en el entorno para poder descifrar. Si la passphrase es
incorrecta o el archivo fue alterado, el descifrado falla y aborta (lo detecta el tag GCM).

### Opción manual (solo para respaldos SIN cifrar)
Con `psql`, usando la misma URL de conexión que el backend (`DATABASE_URL` del `.env`):
```bash
cd ~/Desktop/RRHH-Portal-New/portal-rrhh-backend
psql "postgres://portal:portal@localhost:5432/portal_rrhh" -f backups/portal_rrhh_2026-07-14_0300.sql
```
(Reemplazá la URL por la de tu `.env` y el nombre del archivo por el que quieras restaurar.)

Después, reiniciá el backend (`npm run dev` o `npm start`).

## Buenas prácticas
- Copiá de vez en cuando la carpeta `backups/` a otro disco o a la nube (un respaldo en el mismo disco no protege si ese disco falla).
- Si los respaldos están cifrados, la passphrase va **en otro lugar** que las copias.
- Antes de una corrida grande o un cambio importante de configuración, corré un `npm run backup` manual.
- Probá una restauración de vez en cuando: un respaldo que nunca se restauró no es un respaldo verificado.
