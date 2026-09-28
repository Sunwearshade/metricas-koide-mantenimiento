# db/ — base de datos de Métricos

Motor: **MySQL 8.0.16+** o **MariaDB 10.4+** (XAMPP en desarrollo). Colación `utf8mb4_unicode_ci`
(funciona en ambos). El directorio físico de datos de MySQL **no** se versiona; este
directorio contiene todo lo necesario para reconstruir la base.

```text
db/
├── migrations/               esquema versionado (se aplica en orden, una sola vez)
│   ├── 001_esquema_inicial.sql      tablas de la app (tiempo muerto, gastos, contramedidas, bonos...)
│   ├── 002_usuarios_sesiones.sql    usuarios, roles, sesiones
│   ├── 003_atenciones_paro.sql      atención de paros por el operador + evidencia + bitácora
│   └── 004_bitacora_migracion.sql   claves migradas desde los JSON (migración repetible)
├── seed/README.md            qué datos iniciales existen y de dónde salen
└── metricos-dev.sql          volcado completo de la base de desarrollo (npm run db:dump)
```

## Reconstruir la base de desarrollo

**Opción A — desde las fuentes (recomendada, verifica todo):**

```bash
DB_ADMIN_USER=root DB_ADMIN_PASSWORD= node scripts/db-setup.js --admin   # base + usuario + migraciones
npm run migrate                                                         # data/*.json -> MySQL (no destructiva)
npm run seed:dev                                                        # usuarios admin / operador de desarrollo
```

**Opción B — desde el volcado:**

```bash
/Applications/XAMPP/xamppfiles/bin/mysql -uroot -e "CREATE DATABASE metricos CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
/Applications/XAMPP/xamppfiles/bin/mysql -uroot metricos < db/metricos-dev.sql
DB_ADMIN_USER=root DB_ADMIN_PASSWORD= node scripts/db-setup.js --admin   # (solo crea el usuario de la app)
```

El volcado se restaura sobre una base **vacía** (contiene `DROP TABLE IF EXISTS` de sus propias tablas).

## Migraciones de esquema

- `lib/db.js · applyMigrations()` aplica los archivos `NNN_nombre.sql` pendientes y los
  registra en `schema_migraciones` (con checksum). Se ejecuta en `npm run db:setup`,
  en `npm run migrate` y **al iniciar el servidor**.
- Todas las sentencias son `CREATE TABLE IF NOT EXISTS`: aplicarlas sobre una base
  existente no cambia datos.
- Para cambiar el esquema: agregar un archivo nuevo (`005_...sql`). No editar uno ya
  aplicado (el servidor avisa si su checksum cambió). Nada de `DROP`/`DELETE` en migraciones.

## Migración de datos (JSON históricos → MySQL)

`npm run migrate` — ver `MIGRACION-MYSQL.md`. No destructiva y repetible; `npm run migrate:verify`
solo compara. Reporte en `logs/migracion-*.json` y en la tabla `migraciones`.
