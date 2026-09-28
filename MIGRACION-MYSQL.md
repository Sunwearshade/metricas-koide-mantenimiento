# Migración a MySQL, usuarios y operador de mantenimiento

Fecha: 2026-09-28 · Base de desarrollo: XAMPP **MariaDB 10.4.28** (`127.0.0.1:3306`) · Producción: MySQL 8 o MariaDB 10.4+.

Resultado: la aplicación trabaja **solo contra MySQL**. Los JSON de `data/` quedan como respaldo y fuente histórica de la migración; la app no los lee. Se agregaron login, roles (`mantenimiento_admin`, `mantenimiento_op`), la pantalla del operador de mantenimiento y el flujo *código de reporte → atención → evidencia → código de cierre*. El dashboard existente no cambió: mismas vistas, reglas, rutas `/api/*` y respuestas.

---

## 1. Origen de datos

| Fuente | Qué contiene | Dueño |
|---|---|---|
| `~/Downloads/metricos.zip` (sistema original) | Node.js (`server.js`) + frontend + scripts Python + `data/` | — |
| `data/*.json` del repositorio | **Idénticos byte a byte** a los del ZIP (verificado con `cmp`) | — |
| API koide `192.168.1.201:4000` | Paros (`/api/downtime-records`) y máquinas | Sistema externo |
| Excel de requisiciones y tiempos de entrega (carpeta de red) | Gastos y entregas (vía `extract_v4.py` / `extract_entregas.py`) | Compras |

## 2. Datos encontrados en `metricos.zip`

Se revisaron **todos** los archivos del ZIP (2 847; 2 790 son `node_modules`). Se buscaron `.db .sqlite .sqlite3 .db3 .sql .dump .csv .mdb .accdb .bak .json .xlsx .xls` en todo el ZIP, incluido `node_modules`.

| Archivo | Contenido | Registros |
|---|---|---|
| `data/tiempo-muerto.json` | Espejo de koide: paros + catálogo de máquinas | 1 967 paros (2026-05-19 → 2026-09-23), 52 máquinas |
| `data/gastos.json` | Partidas del Excel de requisiciones 2026 | 1 563 |
| `data/entregas.json` | Partidas de tiempos de entrega (MTTO) | 403 |
| `data/contramedidas.json` + `contramedidas-fotos/` | Contramedidas | 5 (1 con foto) |
| `data/bonos.json` + `template-bonos.xlsx` | Plantilla de bono + semanas capturadas | 1 plantilla, 6 semanas |
| `data/calendarios.json` | Calendarios registrados en la app | 0 |
| `data/calendarios/*.xls(x)` | 6 Excel de calendarios preventivos/predictivos (KMD-MA01/MA02) | 6 archivos, **nunca registrados en la app** |
| `data/documentos/<6 categorías>/` | Carpetas vacías | 0 |
| `data/Bono semanal mantenimiento.xlsx` | Copia idéntica (mismo MD5) de `template-bonos.xlsx` | — |
| `config.json` | Técnicos (6), pesos de desempeño, bonos, colores; **credenciales de koide en claro** | — |
| `scripts/*.py` | Extractores de Excel; **contraseña del Excel en claro** | — |

**No existe en el ZIP ni en este equipo ninguna base SQLite, dump SQL ni CSV del sistema.** Se buscó en todo `~` (excepto `Library`): no hay `.sqlite`/`.db` de métricos.

### Piezas / refacciones / almacén / inventario

> **NO DETERMINADO — REQUIERE VERIFICACIÓN.** El ZIP no contiene piezas, refacciones, existencias, movimientos, ubicaciones ni mínimos/máximos; tampoco hay código de inventario en el `server.js`, `app.js` ni en los `.py` originales (búsqueda de `inventar|almac|refacc|existenc|stock|pieza|localStorage`). Las 6 hojas de calendario y la plantilla de bonos se revisaron hoja por hoja: son calendarios y formato de bono, no inventario.
> En este equipo, almacén/inventario solo existen en el **MES** (`koide-general`: `migrations/20260806_060_almacen_dominio.sql`, `src/routes/almacen.js`; `Koide-Dashboard/pages/almacen/`). Por instrucción, no se tocó ni se integró. **No se creó un modelo de inventario nuevo.** Si esos datos vienen de otra copia del sistema viejo, hay que proporcionarla.

## 3. Datos migrados (inventario de migración)

`npm run migrate` · resultado de la ejecución sobre `metricos` (XAMPP):

| Dataset | Fuente | Destino | Original | MySQL | Dif. | Decisión | Estado |
|---|---|---|---|---|---|---|---|
| Contramedidas | contramedidas.json | `contramedidas` | 5 | 5 | 0 | **CONSERVAR / MIGRAR** | OK (contenido exacto) |
| Fotos de contramedidas | contramedidas-fotos/ | `contramedida_fotos` + disco | 1 | 1 | 0 | **CONSERVAR / MIGRAR** | OK |
| Bonos: plantilla | bonos.json + template-bonos.xlsx | `bonos_plantilla` + disco | 1 | 1 | 0 | **CONSERVAR / MIGRAR** | OK (contenido exacto) |
| Bonos: semanas | bonos.json | `bonos_semanas` | 6 | 6 | 0 | **CONSERVAR / MIGRAR** | OK |
| Calendarios registrados | calendarios.json | `calendarios` | 0 | 0 | 0 | CONSERVAR / MIGRAR | OK |
| Documentos | data/documentos/ | `documentos` (índice) | 0 | 0 | 0 | CONSERVAR (disco = fuente) | OK |
| Paros koide | tiempo-muerto.json | `tiempo_muerto` | 1 967 | 1 967 | 0 | **ORIGEN EXTERNO** (copia de trabajo, ver §4) | OK (contenido exacto) |
| Máquinas koide | tiempo-muerto.json | `maquinas` | 52 | 52 | 0 | ORIGEN EXTERNO | OK (contenido exacto) |
| Gastos | gastos.json | `gastos` | 1 563 | 1 563 | 0 | ORIGEN EXTERNO (Excel), se conserva | OK (contenido exacto) |
| Entregas | entregas.json | `entregas` | 403 | 403 | 0 | ORIGEN EXTERNO (Excel), se conserva | OK (contenido exacto) |
| Calendarios sin registrar | data/calendarios/*.xls | (disco) | 6 | 0 | −6 | **REQUIERE VERIFICACIÓN** | Se conservan en disco, sin tocar |
| Configuración | config.json | archivo (sin cambios) | — | — | — | CONSERVAR | — |

«Contenido exacto» significa que la API sirve desde MySQL **el mismo JSON** que antes servía del archivo, incluido el orden de las claves.

Verificaciones: conteos, IDs (ids de koide, ids base36 de contramedidas y claves `AAAA-Www` preservados), relaciones (fotos → contramedida), valores, fechas y montos (comparación campo a campo del JSON completo), y existencia en disco de fotos y plantilla.

## 4. Datos deliberadamente no migrados y decisiones

- **Paros de koide (§21 del encargo).** Determinación técnica: `tiempo_muerto` y `maquinas` son el espejo de la API koide. Ya se reemplazaban completos en cada sincronización (07:00 diario y botón «Actualizar»), y koide devuelve todo el historial (ids 3–4528). **No son dato propio.** Decisión:
  - no se diseñó ningún historial permanente alrededor de ellos;
  - la carga inicial desde el JSON existe solo para que el dashboard funcione sin koide (por ejemplo, en desarrollo);
  - la sincronización normal los sigue reemplazando.
  - Lo propio de mantenimiento (la **atención**) vive en tablas nuevas que la sincronización nunca toca, con una copia del reporte al aceptarlo (`paro_atenciones.reporte_snapshot`).
- **Gastos/entregas:** se conservan como estaban (el proceso Python sigue reemplazando la tabla con el Excel). Riesgo ya documentado: al cambiar la ruta al Excel de 2027, se reemplaza 2026. No se cambió porque el encargo pide no tocar gastos/entregas más allá de lo necesario.
- **6 Excel de calendarios en `data/calendarios/`:** la app nunca los registró. No se registraron automáticamente para no inventar estado; siguen en disco. Si deben usarse, súbalos desde *Calendarios de mantenimiento*.
- **`data/Bono semanal mantenimiento.xlsx`:** duplicado idéntico de la plantilla; se deja en disco.
- **`data/server*.log`:** logs antiguos, no son datos.
- **Credenciales en claro del sistema viejo** (koide en `config.json` del ZIP; contraseña del Excel en `scripts/legacy/*.py`, también en git): **no se migraron**. Se recomienda rotarlas.
- **Inventario/almacén:** ver §2 (NO DETERMINADO).

## 5. Esquema final

Migraciones en `db/migrations/` (aplicadas y registradas en `schema_migraciones`):

| Tabla | Migración | Tipo | Contenido |
|---|---|---|---|
| `tiempo_muerto`, `maquinas` | 001 | Copia de trabajo (origen koide) | payload exacto + columnas tipadas |
| `gastos`, `entregas` | 001 | Origen externo (Excel) | payload exacto + columnas tipadas |
| `fuentes_sync` | 001 | Control | última sincronización por fuente |
| `contramedidas`, `contramedida_fotos` | 001 | **Propio** | contramedidas + rutas de fotos (FK en cascada) |
| `bonos_plantilla`, `bonos_semanas` | 001 | **Propio** | plantilla parseada + semanas capturadas |
| `calendarios` | 001 | **Propio** | hojas + estatus por celda |
| `documentos` | 001 | Índice | espejo de `data/documentos/` |
| `migraciones` | 001 | Bitácora | reportes de cada ejecución de la migración |
| `usuarios` | 002 | **Propio** | usuarios, rol, hash de contraseña, número de empleado |
| `sesiones` | 002 | Operativo | sesiones activas (solo SHA-256 del token) |
| `paro_atenciones` | 003 | **Propio** | atención de un reporte: aceptación, trabajo, tiempos, código de cierre |
| `paro_atencion_fotos` | 003 | **Propio** | evidencia (antes/después) |
| `paro_atencion_eventos` | 003 | **Propio** (solo altas) | bitácora ACEPTADO / FINALIZADO / CIERRE_VALIDADO |
| `migracion_registros` | 004 | Control | claves ya migradas (hace la migración repetible) |
| `schema_migraciones` | lib/db.js | Control | migraciones de esquema aplicadas |

Compatibilidad: la colación del esquema original (`utf8mb4_0900_ai_ci`) solo existe en MySQL 8; se cambió a `utf8mb4_unicode_ci`, válida en MySQL 8 y MariaDB (XAMPP).

## 6. Usuarios y roles

| Rol | Acceso |
|---|---|
| `mantenimiento_admin` | Todo el dashboard actual: tiempo muerto, MTTR/MTBF, técnicos, bonos, contramedidas, calendarios, documentos, gastos, entregas, actualizar datos. También puede usar la pantalla de operador. |
| `mantenimiento_op` | Solo `/operador-mantenimiento` y `/api/operador/*`. |

La autorización se valida **en el backend** (`server.js`), no solo ocultando botones:

| Petición | Sin sesión | `mantenimiento_op` | `mantenimiento_admin` |
|---|---|---|---|
| `/` (dashboard), `/app.js` | 302 → `/login` | 302 → `/operador-mantenimiento` / 403 | 200 |
| `/api/*` existentes (data, bonos, gastos, contramedidas, documentos…) | 401 | **403** | 200 |
| `/operador-mantenimiento`, `/api/operador/*` | 302 / 401 | 200 | 200 |
| `/api/terminal/*` | requiere `X-Terminal-Key` (una sesión de usuario no sirve) | | |
| `/login`, `/api/auth/login`, `/api/health`, estilos, logo | público | | |

Contraseñas:
- Se guardan con **scrypt** (N=16384, sal aleatoria de 16 bytes) y se comparan en tiempo constante.
- Mínimo 8 caracteres.
- Tras 5 intentos fallidos por usuario e IP hay un bloqueo de 5 minutos (HTTP 429).

Sesiones:
- Cookie `metricos_sid`, `HttpOnly`, `SameSite=Strict` (`Secure` con `COOKIE_SECURE=1`).
- Token aleatorio de 256 bits; en la base solo se guarda su SHA-256.
- Expiran a las `SESSION_HOURS` (12 h por defecto) y sobreviven a reinicios del servidor.
- «Cerrar sesión» invalida la sesión en el servidor.

Administración: `node scripts/usuarios.js listar | crear <usuario> <rol> "<nombre>" [num_empleado] | password <usuario> | activar | desactivar`.
- La contraseña se pide oculta y nunca va en la línea de comandos.
- Cambiarla o desactivar al usuario cierra sus sesiones.
- `num_empleado` es el número que koide usa en `repair_started_by_employee_number` / `closed_by_employee_number` (el mismo del roster de `config.json`). Créelo para cada operador para que su atención quede ligada a su número.

## 7. Credenciales de desarrollo (no son secretos reales)

| Usuario | Contraseña | Rol |
|---|---|---|
| `admin` | `admin-dev-2026` | mantenimiento_admin |
| `operador` | `operador-dev-2026` | mantenimiento_op |

- Los crea `npm run seed:dev`, que no corre con `NODE_ENV=production`.
- La base usa el usuario MySQL `metricos` con una contraseña aleatoria, guardada en `.env` (fuera de git).
- La clave de la terminal (`TERMINAL_API_KEY`) está en `.env`.
- **No usar estos usuarios en producción.**

## 8. Levantar MySQL (XAMPP)

1. Abrir **XAMPP → Manage Servers → MySQL Database → Start**. Queda en `127.0.0.1:3306`; `root` no tiene contraseña (así viene XAMPP).
2. Solo la primera vez, crear la base y el usuario de la app:
   ```bash
   cp .env.example .env        # y poner DB_PASSWORD, TERMINAL_API_KEY (ver comentarios)
   DB_ADMIN_USER=root DB_ADMIN_PASSWORD= npm run db:setup -- --admin
   ```
   Esto crea la base `metricos`, el usuario `metricos`@localhost/127.0.0.1/::1 (solo esa base) y aplica las migraciones.

En este equipo ya está hecho. Las bases `koide_*` del MES que viven en el mismo XAMPP **no se tocaron**.

## 9. Ejecutar Node

```bash
npm install          # si falta node_modules
npm start            # http://localhost:4173  -> /login
```

Al iniciar se aplican las migraciones pendientes y se avisa si no hay usuarios.

Koide no es alcanzable fuera de la planta. En ese caso el dashboard usa la última copia guardada, y la pantalla del operador lo indica. Para probar el flujo del operador con paros nuevos:

```bash
npm run koide:sim    # simulador de desarrollo en http://127.0.0.1:4000 (crear paros en /sim)
# en .env:  KOIDE_BASE_URL=http://127.0.0.1:4000   KOIDE_PASSWORD=sim   -> reiniciar npm start
```

El simulador parte de una copia en memoria de `data/tiempo-muerto.json` y no modifica el archivo. Al sincronizar, la copia de trabajo `tiempo_muerto` recibe también los paros simulados; no lo use en producción.

## 10. Ejecutar la migración

```bash
npm run migrate          # inserta lo que falte y verifica (reporte en logs/migracion-*.json)
npm run migrate:verify   # solo compara JSON vs MySQL
```

- **No destructiva.** No ejecuta `DROP`, `DELETE` ni `UPDATE` sobre datos. `--force` ya no existe.
- **Repetible:**
  - las claves migradas quedan en `migracion_registros`;
  - repetirla no duplica;
  - no pisa lo editado en la app;
  - no revive lo que se borró desde la app. En el reporte aparece como «borradas después en la app», no como pérdida.
- Las fuentes externas (koide, Excel) se cargan una sola vez como copia inicial, solo si nunca se han sincronizado.
- Termina con código 1 y `RESULTADO: ERROR` si hay una **pérdida inexplicada** (un registro del JSON que no está en MySQL ni fue borrado desde la app).

## 11. Reconstruir la base

Ver `db/README.md`. Resumen:

- **Desde las fuentes:** `npm run db:setup -- --admin` → `npm run migrate` → `npm run seed:dev`.
- **Desde el volcado:** crear la base vacía y `mysql -uroot metricos < db/metricos-dev.sql` (4.5 MB, sin filas de sesiones).
  - Verificado: restaurado en otra base, `CHECKSUM TABLE` idéntico en las 15 tablas con datos.
  - Regenerar con `npm run db:dump`.

## 12. Endpoints nuevos

| Método | Ruta | Rol | Descripción |
|---|---|---|---|
| POST | `/api/auth/login` | público | `{username, password}` → cookie de sesión + `{user, redirect}`. 401 credenciales, 429 bloqueo, 503 sin base |
| POST | `/api/auth/logout` | — | Cierra la sesión (servidor y cookie) |
| GET | `/api/auth/me` | sesión | Usuario actual y pantalla de inicio |
| GET | `/api/operador/reportes/:codigo` | op, admin | Busca el reporte: `{reporte, puedeAceptar, motivo, aviso, atencion}` |
| POST | `/api/operador/reportes/:codigo/aceptar` | op, admin | Crea la atención (EN_ATENCION). 404 no existe, 409 ya aceptado / ya atendido / paro finalizado |
| GET | `/api/operador/atenciones` | op, admin | Atenciones en curso y últimas finalizadas del usuario (admin: todas) |
| GET | `/api/operador/atenciones/:id` | dueño o admin | Detalle |
| POST | `/api/operador/atenciones/:id/finalizar` | dueño o admin | `{actionTaken, comments, fotos:[{tipo:"antes"\|"despues", name, base64}]}` → FINALIZADA + código de cierre |
| GET | `/api/operador/atenciones/:id/fotos/:nombre` | dueño o admin | Evidencia |
| POST | `/api/terminal/cierres/validar` | `X-Terminal-Key` | `{codigoCierre, codigoReporte?, terminal?}` → valida y marca CERRADA (idempotente) |
| GET | `/api/health` | público | Ahora incluye `db` y responde 503 si MySQL no está disponible |

Pantallas nuevas:
- `/login`
- `/operador-mantenimiento`
- `/operador-mantenimiento/atender/:id`
- `/operador-mantenimiento/cierre/:id`

El dashboard ahora muestra el usuario y un botón «Cerrar sesión» (`public/sesion.js`). Si la sesión expira, regresa a `/login`.

## 13. Flujo del operador

```text
login (mantenimiento_op) → /operador-mantenimiento
  "Ingresa código del reporte" → ACEPTAR
    → valida: formato · existe · área Mantenimiento · paro abierto en koide · sin atención previa
    → muestra máquina, proceso, fecha/turno, inicio, categoría, problema, quién reportó
  ACEPTAR PARO → atención EN_ATENCION (usuario + fecha/hora; evento ACEPTADO)
  Captura:  Trabajo realizado* · Comentarios · Foto antes · Foto después
  COMPLETAR REPORTE → FINALIZADA + código de cierre (evento FINALIZADO)
  → el operador lo captura en la terminal → POST /api/terminal/cierres/validar → CERRADA (evento CIERRE_VALIDADO)
```

Campos capturados: no se inventaron. Son los que ya existen en el modelo de paro de koide y la evidencia que ya usan las contramedidas.

| Pantalla | Campo koide equivalente | Regla de origen |
|---|---|---|
| Aceptado por / fecha-hora | `repair_start`, `repair_started_by_employee_number` | koide |
| Técnico (número y nombre del usuario) | `closed_by_employee_number` | koide |
| Trabajo realizado (obligatorio) | `action_taken` | koide; obligatorio como `trabajoRealizado` al completar contramedidas |
| Comentarios | `comments` | koide |
| Tiempo de respuesta | `response_time_minutes` = aceptado − inicio del paro | misma definición verificada en los datos de koide |
| Tiempo de reparación | `repair_time_minutes` = finalizado − aceptado | idem |
| Fotos antes/después | — | contramedidas: máx. 2, JPG/PNG, ≤ 5 MB (además se valida que el archivo sea imagen) |

El registro original del paro **nunca se modifica**; se guarda una copia al aceptarlo. La atención es independiente de la sincronización con koide. Los tiempos de la atención **no** alimentan MTTR/MTBF: esas reglas no cambiaron.

## 14. Código de reporte

> **NO DETERMINADO — REQUIERE VERIFICACIÓN: el formato del código que muestra la terminal.** La terminal no está en este repositorio. Ni el paro de koide (`/api/downtime-records`) ni `koide_production.paros` tienen un campo «código de reporte».

Implementación actual: **código de reporte = id del paro en koide** (numérico; acepta `#26` o `26`).
- Si no está en la copia local, se resincroniza con koide para encontrar paros recién creados (como máximo una vez cada `KOIDE_LOOKUP_MIN_MS`, 5 s).
- Si la terminal usa otro código, solo cambian `normalizarCodigoReporte()` en `lib/atenciones.js` y `buscarReporte()` en `server.js`.

No se cancela una atención aceptada: el encargo no define quién ni cómo. Hoy, si un operador acepta un reporte y no lo termina, queda EN_ATENCION y nadie más puede aceptarlo. **NO DETERMINADO — REQUIERE VERIFICACIÓN**.

## 15. Código de cierre

- **Formato:** `C-XXXX-XXXX`, con 8 caracteres de `ABCDEFGHJKMNPQRSTUVWXYZ23456789`.
  - Sin 0/O, 1/I/L, para evitar confusiones al dictarlo o teclearlo.
  - Unas 8.5 × 10¹¹ combinaciones, generadas con `crypto.randomInt`.
  - Índice único en la base; si choca, se reintenta.
- **Captura en la terminal:** se aceptan minúsculas, sin guiones y sin la `C` inicial.
- **Contrato para la terminal (implementarlo en su propio proyecto):**

```http
POST /api/terminal/cierres/validar
X-Terminal-Key: <TERMINAL_API_KEY del .env>
Content-Type: application/json

{ "codigoCierre": "C-8F42-K9QM", "codigoReporte": "26", "terminal": "TERM-CORTE-01" }
```

| Respuesta | Significado |
|---|---|
| 200 `{valido:true, yaConfirmado:false, estado:"CERRADA", codigoReporte, maquina, tecnico, aceptadoEn, finalizadoEn, responseTimeMinutes, repairTimeMinutes, actionTaken}` | código válido → paro cerrado |
| 200 `{valido:true, yaConfirmado:true, ...}` | ya se había validado (idempotente) |
| 400 `{valido:false}` | formato inválido |
| 404 `{valido:false}` | código inexistente |
| 409 `{valido:false}` | el código es de otro reporte (si se envía `codigoReporte`) |
| 401 | clave de terminal ausente o incorrecta |
| 503 | `TERMINAL_API_KEY` no configurada, o la base no está disponible |

## 16. Pruebas ejecutadas

`npm test` usa la base `metricos_test` en XAMPP, un simulador de koide, Excel sintéticos (Python en `.venv`) y un **proxy TCP hacia MySQL** para simular caídas sin detener XAMPP.

| # | Prueba | Cubre |
|---|---|---|
| 1–9 | Pruebas originales (estáticos, tiempo muerto, contramedidas, bonos, calendarios, documentos, gastos/entregas vía Python, error de Python, reinicio) | el dashboard existente sigue igual, ahora con sesión |
| 10 | login | credenciales, cookie HttpOnly/SameSite, `/me`, logout, hash scrypt, token hasheado, bloqueo 429, usuario desactivado |
| 11 | autorización | 12 rutas administrativas: 401 sin sesión, 403 como operador; redirecciones de páginas; admin puede usar la pantalla de operador |
| 12 | operador | código inválido/inexistente/paro finalizado, aceptar, doble aceptación (mismo y otro usuario), validaciones (sin trabajo, 3 fotos, .gif, archivo no imagen), aislamiento entre operadores, finalizar con 2 fotos, reporte ya atendido, espejo koide intacto, bitácora, paro recién creado en koide |
| 13 | terminal | sin clave, clave mala, sesión de usuario no sirve, formato, inexistente, código de otro reporte, válido (minúsculas/sin guiones), repetido idempotente, estado CERRADA, bitácora |
| 14 | migración repetida | sin duplicados en 11 tablas; lo borrado en la app no revive; `--force` rechazado; JSON intacto |
| 15 | reinicio | la sesión y la atención persisten |
| 16 | pérdida de MySQL | 503 en API, health y login sin tumbar el servidor; se recupera sola al volver MySQL |

Además:
- **Navegador real** (Chrome headless vía CDP), contra `metricos_test` y el simulador de koide:
  - login incorrecto, login admin y las 9 vistas del dashboard con datos;
  - cerrar sesión;
  - login operador, intento de abrir `/`, código inexistente, código válido;
  - confirmar, aceptar, recargar la página, capturar trabajo, subir foto y completar;
  - código de cierre y lista de recientes.
  - **Sin errores de JavaScript en consola.**
- **Base de desarrollo:** `npm start`; admin ve 1 967 paros, 5 contramedidas, 6 semanas de bono, 1 563 gastos y 403 entregas. El operador puede aceptar el reporte 26.
- **Flujo manual con curl sobre la base de desarrollo** (aceptar 26 → finalizar → validar en terminal → reinicio). Después se borraron esas filas de prueba (atención id 1, sus fotos y eventos) para dejar el reporte 26 libre para su prueba.

## 17. Resultados de validación

- `npm test`: **16/16 aprobadas**.
- `npm run migrate` sobre datos reales: **13 verificaciones OK**, 1 «REQUIERE VERIFICACIÓN» (calendarios sin registrar), 0 errores. Segunda ejecución: «Nada nuevo que migrar», conteos idénticos.
- `db/metricos-dev.sql` restaurado en otra base (`metricos_test`): checksums idénticos.
- Conteos finales en `metricos`:
  - `tiempo_muerto` 1 967 · `maquinas` 52
  - `gastos` 1 563 · `entregas` 403
  - `contramedidas` 5 · `contramedida_fotos` 1
  - `bonos_plantilla` 1 · `bonos_semanas` 6
  - `calendarios` 0 · `documentos` 0
  - `usuarios` 2 · `paro_atenciones` 0

### Cambios de comportamiento en código existente (solo lo necesario)

- Toda ruta requiere sesión; el dashboard requiere `mantenimiento_admin`.
- `GET /api/health` responde 503 si la base no está disponible (antes siempre 200).
- Un error de conexión con MySQL devuelve 503 en lugar de 500.
- Llamadas a koide con timeout (`KOIDE_TIMEOUT_MS`, 20 s). Las sincronizaciones simultáneas esperan la misma en curso; antes devolvían la copia vieja.
- Un cuerpo de petición mayor al límite ya no deja la petición colgada: se responde como cuerpo vacío (400).
- Las páginas HTML se sirven con `Cache-Control: no-store`.
- `migrate-json-to-mysql.js` ahora es incremental y no destructivo. Se quitaron el código de salida 3 y `--force`; `install.ps1` está ajustado y ofrece crear el primer admin.
- `install.ps1` genera `TERMINAL_API_KEY`.

### Pendientes

- **NO DETERMINADO:** formato del código de reporte de la terminal (§14).
- **NO DETERMINADO:** cancelar o reasignar una atención abandonada (§14).
- **NO DETERMINADO:** inventario/almacén del sistema viejo (§2).
- Rotar la contraseña de koide y la del Excel expuestas en el sistema viejo y en `scripts/legacy/`.
- Decidir si se registran los 6 calendarios de `data/calendarios/`.
