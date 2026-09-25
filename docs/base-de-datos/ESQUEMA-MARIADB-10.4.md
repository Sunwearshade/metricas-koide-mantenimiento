# Propuesta de esquema de base de datos para MariaDB 10.4.32 (XAMPP)

- **Estado:** PROPUESTA. Todavía no se ejecuta ningún `CREATE TABLE` ni se inserta ningún dato.
- **Fecha:** 2026-09-24
- **Motor:** MariaDB 10.4.32 (XAMPP), puerto 3306, administrado con phpMyAdmin 5.2.1.
- **Fuente de los datos:** `data/`, validado contra el legacy. Ver `docs/migracion-legacy/manifiesto-legacy.json`.

---

## 1. Compatibilidad del esquema existente (`db/schema.sql`) con MariaDB 10.4

`db/schema.sql` se escribió para MySQL 8. **No se modifica.** Se usará como referencia para una migración base nueva, adaptada a MariaDB.

| Elemento en `schema.sql` / `db-setup.js` | MariaDB 10.4.32 | Acción propuesta |
|---|---|---|
| `COLLATE utf8mb4_0900_ai_ci` (todas las tablas y el `CREATE DATABASE`) | ❌ **No existe** (error 1273, collation desconocida) | Usar **`utf8mb4_unicode_520_ci`**: también ignora acentos y mayúsculas, como `0900_ai_ci`. Las claves de texto se quedan en `utf8mb4_bin` |
| `utf8mb4_bin` en columnas clave | ✅ | Sin cambio |
| `CHECK (JSON_VALID(...))` | ✅ Se aplica desde la versión 10.2.1 | Sin cambio |
| `LONGTEXT` para JSON | ✅ En MariaDB, `JSON` es alias de `LONGTEXT` y conserva el orden de las claves | Se mantiene `LONGTEXT` + `CHECK`, que es explícito y portable |
| `DATETIME(3)`, `DECIMAL(16,2)`, `TINYINT(1)`, `DOUBLE` | ✅ | Sin cambio |
| `AUTO_INCREMENT` en `orden` (no es PK) con `UNIQUE KEY` | ✅ InnoDB lo permite porque la columna tiene índice | Sin cambio |
| Índices sobre VARCHAR(255) utf8mb4 (hasta 1,420 bytes) | ✅ Formato de fila DYNAMIC, límite de 3,072 bytes | Validar `innodb_default_row_format` → `REQUIERE VALIDACIÓN` |
| `INSERT … ON DUPLICATE KEY UPDATE col = VALUES(col)` | ✅ | Sin cambio |
| `CREATE USER IF NOT EXISTS`, `ALTER USER` | ✅ | Sin cambio |

### 1.1 Configuración de XAMPP que afecta el diseño (leída de `C:\xampp\mysql\bin\my.ini`; no se modifica)

| Parámetro de `[mysqld]` | Valor | Impacto | Mitigación, sin tocar XAMPP |
|---|---|---|---|
| `max_allowed_packet` | **1M** | Cada sentencia debe pesar menos de 1 MB. El lote más grande de la migración pesa unos 479 KB (300 paros): ✅. **No cabe** guardar `tiempo-muerto.json` completo (2.3 MB) en una sola fila | La foto histórica se guarda **un registro por fila** (tabla `legacy_registros`) |
| `sql_mode` | `NO_ZERO_IN_DATE,NO_ZERO_DATE,NO_ENGINE_SUBSTITUTION`, **sin STRICT** | Sin modo estricto, MariaDB **trunca en silencio** los valores que no caben en una columna. Eso sería una corrección silenciosa | Los scripts de migración ejecutarán `SET SESSION sql_mode='STRICT_ALL_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION'`. La aplicación Node también debe hacerlo (sección 7) |
| `collation-server` | `utf8mb4_general_ci` | Las tablas que se creen sin collation explícita la heredarían | Todas las tablas declaran su charset y collation |
| `character-set-server` | `utf8mb4` | ✅ Admite `U+FFFD` y los acentos de los datos de KOIDE | — |
| `time_zone` | `REQUIERE VALIDACIÓN` | `DATETIME` no guarda zona horaria. La aplicación escribe y lee en UTC (`mysql2` con `timezone: 'Z'`) | Todas las fechas y horas se guardan en **UTC**, igual que en el JSON (`...Z`) |

---

## 2. Principios del diseño

1. **Sin pérdida y sin corrección silenciosa.** Cada registro conserva su JSON original **exacto** en `payload` (las tablas espejo) o en columnas tipadas más `extra` (las tablas propias). Las anomalías se documentan en `legacy_anomalias`; no se corrigen.
2. **Compatibilidad con la aplicación.** Las 12 tablas existentes conservan sus nombres y columnas, porque `lib/store.js` y los scripts de Python dependen de ellas. La API sigue respondiendo el mismo JSON.
3. **Trazabilidad de la migración separada de los datos operativos.** Todo lo del legacy va en tablas `legacy_*` que la aplicación no lee. Así se aplican las decisiones (W37, R13, calendarios) sin cambiar la API.
4. **Original contra calculado.** Cada columna se clasifica en `diccionario_datos` (sección 5).
5. **Extensible.** Hay migraciones versionadas (`schema_migrations`) y cada cambio futuro es un archivo nuevo. MariaDB admite `ADD COLUMN IF NOT EXISTS`, lo que facilita migraciones idempotentes.

---

## 3. Entidades

La columna **Origen** indica de dónde viene cada dato:

| Clave | Significado |
|---|---|
| `KOIDE` | Dato original de la API de KOIDE |
| `KOIDE-calc` | Calculado por KOIDE |
| `Excel` | Celda del Excel de requisiciones o de tiempos de entrega |
| `Script` | Calculado por el script de Python |
| `Usuario` | Capturado en la aplicación |
| `App` | Generado o calculado por la aplicación |
| `Copia` | Columna tipada copiada de `payload`, para hacer consultas |
| `Mig` | Metadato de la migración |

### 3.1 Tablas existentes (se conservan; solo cambia la collation)

#### `fuentes_sync`: última actualización de cada fuente externa

| Campo | Tipo | NULL | PK | FK | Default | Descripción | Origen legacy |
|---|---|---|---|---|---|---|---|
| fuente | VARCHAR(40) | NOT NULL | ✅ | — | — | `tiempo_muerto`, `gastos`, `entregas` | App |
| area | VARCHAR(100) | NULL | | | NULL | Área consultada | `tiempo-muerto.json → area` |
| actualizado | DATETIME(3) | NOT NULL | | | — | Fecha y hora de la foto (UTC) | `tiempo-muerto.json → updatedAt`; en gastos y entregas, fecha del archivo |
| registros | INT | NOT NULL | | | 0 | Número de registros | App |
| detalle | VARCHAR(255) | NULL | | | NULL | Texto libre | App |

#### `maquinas`: espejo del catálogo de KOIDE (52 filas)

| Campo | Tipo | NULL | PK | FK | Default | Descripción | Origen legacy |
|---|---|---|---|---|---|---|---|
| id | INT | NOT NULL | ✅ | — | — | **ID original de KOIDE** | `machines[].id` (KOIDE) |
| orden | INT | NOT NULL | | | — | Posición en el arreglo original | Mig |
| code | VARCHAR(50) | NULL | | | NULL | Código (B4, CNC5…); índice | `code` (KOIDE) |
| name | VARCHAR(255) | NULL | | | NULL | Modelo | `name` (KOIDE) |
| process | VARCHAR(100) | NULL | | | NULL | BISELADO, CORTE, CNC o PRENSA | `process` (KOIDE) |
| active | TINYINT | NULL | | | NULL | 1 = activa | `active` (KOIDE) |
| target_pcs_per_hour | INT | NULL | | | NULL | Meta de piezas por hora | KOIDE |
| effective_hours_per_day | DOUBLE | NULL | | | NULL | 21.6. **El MTBF no lo usa**: la regla legacy es de 22 h | KOIDE |
| created_at / updated_at | DATETIME(3) | NULL | | | NULL | Fechas en KOIDE (UTC) | KOIDE |
| payload | LONGTEXT (JSON) | NOT NULL | | | — | **JSON original exacto** | `machines[i]` completo |

Índices: `idx_maquinas_orden(orden)`, `idx_maquinas_code(code)`.

#### `tiempo_muerto`: espejo de los paros de KOIDE (1,967 filas)

| Campo | Tipo | NULL | PK | FK | Default | Descripción | Origen legacy |
|---|---|---|---|---|---|---|---|
| id | INT | NOT NULL | ✅ | — | — | **ID original de KOIDE** (del 3 al 4528) | `records[].id` |
| orden | INT | NOT NULL | | | — | Posición original | Mig |
| record_date | DATE | NULL | | | NULL | Fecha local de operación. **No se convierte** a UTC | KOIDE |
| shift / group_name | VARCHAR(20) | NULL | | | NULL | Turno (T1–T3) y grupo (A–C) | KOIDE |
| machine_id | INT | NULL | | lógica → `maquinas.id` | NULL | Máquina | KOIDE |
| machine_code | VARCHAR(50) | NULL | | | NULL | Código de la máquina (KOIDE lo toma de su catálogo) | KOIDE |
| operator_employee_number / operator_name | VARCHAR(50) / VARCHAR(255) | NULL | | | NULL | Operador | KOIDE |
| downtime_start / downtime_end | DATETIME(3) | NULL | | | NULL | Inicio y fin del paro (UTC). `end` es NULL en 1 caso | KOIDE |
| downtime_minutes | INT | NULL | | | NULL | Fin menos inicio. **Hay 95 paros de más de 24 h, que se conservan** | **KOIDE-calc** |
| responsible_area | VARCHAR(100) | NULL | | | NULL | Siempre "Mantenimiento" | KOIDE |
| downtime_category | VARCHAR(100) | NULL | | | NULL | Falla mecánica, eléctrica, etc. | KOIDE |
| problem_description / action_taken | TEXT | NULL | | | NULL | Texto libre. **311 registros tienen `U+FFFD` y se conservan** | KOIDE |
| responsible_person | VARCHAR(255) | NULL | | | NULL | Texto libre | KOIDE |
| status | VARCHAR(50) | NULL | | | NULL | Finalizado o En reparación | KOIDE |
| response_time_minutes | INT | NULL | | | NULL | Inicio de reparación menos inicio del paro | **KOIDE-calc** |
| repair_time_minutes | INT | NULL | | | NULL | Fin menos inicio de reparación, menos `external_minutes` | **KOIDE-calc** |
| external_minutes | INT | NULL | | | NULL | Minutos externos | KOIDE |
| created_at / updated_at | DATETIME(3) | NULL | | | NULL | Fechas en KOIDE (UTC) | KOIDE |
| payload | LONGTEXT (JSON) | NOT NULL | | | — | **JSON exacto de los 37 campos.** Incluye los que no tienen columna: `repair_started_by_employee_number` y `closed_by_employee_number` (**con 22 valores de texto libre que se conservan**), `repair_start`, `started_by_employee_number`, `external_note`, `external_started_at`, `comments`, `captured_by_department`, `production_receiver_*`, `machine_name`, `machine_process` y `product_*` | `records[i]` completo |

Índices: `idx_tm_orden`, `idx_tm_fecha(record_date)`, `idx_tm_maquina(machine_id)`.

#### `gastos`: espejo del Excel de requisiciones (1,563 filas)

| Campo | Tipo | NULL | PK | FK | Default | Descripción | Origen legacy |
|---|---|---|---|---|---|---|---|
| id | INT AUTO_INCREMENT | NOT NULL | ✅ | — | — | Técnico. **Cambia en cada actualización desde el Excel** | App |
| orden | INT | NOT NULL | | | — | **Posición original de la partida (desde 0). Es el identificador legacy** | Mig |
| sheet | VARCHAR(100) | NULL | | | NULL | Hoja del Excel (`1-ENERO`…) | Excel |
| cotizacion | VARCHAR(50) | NULL | | | NULL | Número de cotización (en el JSON es número) | Excel |
| proveedor, producto, observaciones | TEXT | NULL | | | NULL | Texto sin normalizar | Excel |
| cantidad, precio_unitario | DOUBLE | NULL | | | NULL | — | Excel |
| importe, iva, total_partida | DECIMAL(16,2) | NULL | | | NULL | Montos. **No se recalculan** (hay 5, 1 y 3 inconsistencias, que se conservan) | Excel |
| po | VARCHAR(50) | NULL | | lógica ↔ `entregas.po` | NULL | Orden de compra | Excel |
| tiene_po, entregado | TINYINT(1) | NULL | | | NULL | Banderas | **Script** |
| fecha_elaboracion, fecha_entrega | DATE | NULL | | | NULL | 27 fechas de entrega vacías se guardan como NULL (el valor `""` queda en `payload`) | Excel |
| mes_entrega | TINYINT | NULL | | | NULL | **En realidad es el índice del mes de la hoja** (del 0 al 11) | **Script** |
| moneda, proyecto, termino_pago | VARCHAR | NULL | | | NULL | **Sin normalizar** (`MXM`, `INGENEIRIA`…) | Excel |
| comentario | TEXT | NULL | | | NULL | Si no está vacío, la partida cuenta como "extraordinario" | Excel |
| payload | LONGTEXT (JSON) | NOT NULL | | | — | JSON exacto (incluye `entregado_meses`) | `gastos[i]` |

Índices: `idx_gastos_orden`, `idx_gastos_po`.

#### `entregas`: espejo del Excel de tiempos de entrega (403 filas)

| Campo | Tipo | NULL | PK | FK | Default | Descripción | Origen legacy |
|---|---|---|---|---|---|---|---|
| id | INT AUTO_INCREMENT | NOT NULL | ✅ | — | — | Técnico, no estable | App |
| orden | INT | NOT NULL | | | — | **Posición original (identificador legacy)** | Mig |
| proveedor, material, observaciones | TEXT | NULL | | | NULL | — | Excel |
| cantidad | DOUBLE | NULL | | | NULL | — | Excel |
| depto, serie | VARCHAR | NULL | | | NULL | — | Excel |
| po | VARCHAR(50) | NULL | | lógica ↔ `gastos.po` | NULL | 398 de 403 están en gastos | Excel |
| fecha_envio, fecha_estimada | DATE | NULL | | | NULL | — | Excel |
| dias | INT | NULL | | | NULL | En el origen es número o `""`; `""` se guarda como NULL (se conserva en `payload`) | Excel |
| estatus | VARCHAR(50) | NULL | | | NULL | ENTREGADO, PENDIENTE o PARCIAL. **"RETRASADO" no se guarda**: se calcula en pantalla | Excel |
| mes | TINYINT | NULL | | | NULL | Mes de `fecha_envio` | **Script** |
| payload | LONGTEXT (JSON) | NOT NULL | | | — | JSON exacto | `entregas[i]` |

#### `contramedidas`: propia de la aplicación (5 filas)

| Campo | Tipo | NULL | PK | FK | Default | Descripción | Origen legacy |
|---|---|---|---|---|---|---|---|
| id | VARCHAR(40) utf8mb4_bin | NOT NULL | ✅ | — | — | **ID legacy original** (`mt07hwfck0ns2`…) | `id` |
| orden | BIGINT AUTO_INCREMENT | NOT NULL | UNIQUE | | — | Orden de inserción, que coincide con el orden del arreglo | Mig |
| tipo | VARCHAR(255) | NULL | | | NULL | MTTR, Falla común, Correctivo… | Usuario |
| maquina | VARCHAR(255) | NULL | | lógica → `maquinas.code` | NULL | Código de la máquina | Usuario |
| maquina_nombre | VARCHAR(255) | NULL | | | NULL | Copia del catálogo al crear | App (copia) |
| falla_comun | TEXT | NULL | | | NULL | Falla más frecuente **en el momento de crear**. Valor congelado | **App-calc** |
| referencia | VARCHAR(255) | NULL | | | NULL | Igual a `maquina` | App |
| categoria, descripcion | VARCHAR / TEXT | NULL | | | NULL | Casi siempre vacíos | Usuario |
| responsable | VARCHAR(255) | NULL | | | NULL | **Nombre**, no número de empleado | Usuario |
| fecha_limite | DATE | NULL | | | NULL | El valor `""` se guarda como NULL y se devuelve como `""` | Usuario |
| estado | VARCHAR(100) | NULL | | | NULL | Pendiente, En proceso o Completado | Usuario |
| creada | DATETIME(3) | NULL | | | NULL | UTC | App |
| trabajo_realizado | TEXT | NULL | | | NULL | Al completar | Usuario |
| extra | LONGTEXT (JSON) | NULL | | | NULL | Campos desconocidos, valores que no caben y la lista `__ausentes` | Mig |

Índices: `idx_cm_maquina`, `idx_cm_estado`.

#### `contramedida_fotos` (1 fila)

| Campo | Tipo | NULL | PK | FK | Default | Descripción | Origen legacy |
|---|---|---|---|---|---|---|---|
| id | INT AUTO_INCREMENT | NOT NULL | ✅ | | — | Técnico | App |
| contramedida_id | VARCHAR(40) bin | NOT NULL | | ✅ → `contramedidas.id` `ON DELETE CASCADE` | — | — | Carpeta `contramedidas-fotos/<id>` |
| orden | INT | NOT NULL | | | — | Posición en `fotos[]` | Mig |
| nombre | VARCHAR(255) bin | NOT NULL | | | — | `foto_mt07wegj_rr8.png` | `fotos[i]` |
| ruta | VARCHAR(600) | NOT NULL | | | — | Relativa a `DATA_DIR`. El archivo sigue en disco | App |
| creada | DATETIME(3) | NOT NULL | | | — | Fecha de migración (el legacy no la guardaba) | Mig |

#### `bonos_plantilla` (1 fila, `id = 1`)

| Campo | Tipo | NULL | PK | FK | Default | Descripción | Origen legacy |
|---|---|---|---|---|---|---|---|
| id | TINYINT, CHECK `id = 1` | NOT NULL | ✅ | | — | Una sola fila | — |
| hoja | VARCHAR(255) | NULL | | | NULL | `"bono por eficiencia "` (con el espacio original) | `template.sheet` |
| archivo_ruta | VARCHAR(600) | NULL | | | NULL | `template-bonos.xlsx` | Archivo |
| plantilla | LONGTEXT (JSON) | NULL | | | NULL | Celdas, combinaciones, columnas, `maxRow` y `maxCol` exactos (15.7 KB). **Incluye los datos de la semana 32** | `bonos.json → template` |
| actualizado | DATETIME(3) | NULL | | | NULL | 2026-08-10T16:46:18.245Z | `updatedAt` |
| extra | LONGTEXT (JSON) | NULL | | | NULL | — | Mig |

#### `bonos_semanas` (5 filas: se excluye `2026-W37`)

| Campo | Tipo | NULL | PK | FK | Default | Descripción | Origen legacy |
|---|---|---|---|---|---|---|---|
| clave | VARCHAR(100) bin | NOT NULL | ✅ | — | — | **Clave legacy** `2026-Www` | `weeks` (clave) y `key` |
| orden | BIGINT AUTO_INCREMENT | NOT NULL | UNIQUE | | — | Orden original de las claves en el JSON | Mig |
| semana | INT | NULL | | | NULL | Número de semana ISO | App |
| periodo_ini, periodo_fin, fecha | VARCHAR(50) | NULL | | | NULL | `YYYY-MM-DD`, tal como se guardó | App |
| celdas | LONGTEXT (JSON) | NULL | | | NULL | 49 celdas exactas. **N, H, J y P = calculadas o editadas; R = captura; R13 = heredado de plantilla** (ver `legacy_marcas`) | `cells` |
| guardado | DATETIME(3) | NULL | | | NULL | UTC | `guardado` |
| extra | LONGTEXT (JSON) | NULL | | | NULL | — | Mig |

#### `calendarios` (0 filas)

Los 6 archivos **no se registran aquí**, porque esta tabla equivale a "calendario activo".

| Campo | Tipo | NULL | PK | FK | Default | Descripción |
|---|---|---|---|---|---|---|
| id | VARCHAR(40) bin | NOT NULL | ✅ | | — | Generado al subir |
| orden | BIGINT AUTO_INCREMENT | NOT NULL | UNIQUE | | — | — |
| nombre | VARCHAR(255) | NULL | | | NULL | Nombre original |
| archivo_ruta | VARCHAR(600) | NOT NULL | | | — | `calendarios/<id>.xlsx` |
| subido | DATETIME(3) | NULL | | | NULL | — |
| hojas | LONGTEXT (JSON) | NULL | | | NULL | Hojas parseadas. Los 6 históricos pesarían entre 12 y 143 KB: caben en 1 MB |
| estado | LONGTEXT (JSON) | NULL | | | NULL | Estatus por celda |
| extra | LONGTEXT (JSON) | NULL | | | NULL | — |

#### `documentos` (0 filas; se sincroniza con el disco)

| Campo | Tipo | NULL | PK | FK | Default | Descripción |
|---|---|---|---|---|---|---|
| id | INT AUTO_INCREMENT | NOT NULL | ✅ | | — | — |
| categoria | VARCHAR(100) bin | NOT NULL | UNIQUE (categoria, nombre) | | — | Una de las 6 categorías |
| nombre | VARCHAR(255) bin | NOT NULL | | | — | Nombre de archivo |
| ruta | VARCHAR(600) | NOT NULL | | | — | `documentos/<categoria>/<nombre>` |
| tamano | BIGINT | NOT NULL | | | — | Bytes |
| modificado, registrado | DATETIME(3) | NOT NULL | | | — | — |

#### `migraciones`: bitácora de `migrate-json-to-mysql.js`

Campos: `id` (INT AUTO_INCREMENT, PK), `ejecutada` (DATETIME(3)), `origen` (VARCHAR(600)), `resultado` (VARCHAR(20)) y `resumen` (LONGTEXT).

### 3.2 Tablas nuevas (control y trazabilidad del legacy)

#### `schema_migrations`: control de versiones del esquema

| Campo | Tipo | NULL | PK | Default | Descripción |
|---|---|---|---|---|---|
| version | VARCHAR(20) bin | NOT NULL | ✅ | — | `0001`, `0002`… |
| nombre | VARCHAR(255) | NOT NULL | | — | Nombre de la migración |
| checksum_sha256 | CHAR(64) | NOT NULL | | — | Si alguien edita una migración ya aplicada, se detecta y el ejecutor se detiene |
| aplicada | DATETIME(3) | NOT NULL | | CURRENT_TIMESTAMP(3) | UTC |
| duracion_ms | INT | NULL | | NULL | — |

#### `legacy_lotes`: una fila por cada importación del legacy

| Campo | Tipo | NULL | PK | Default | Descripción |
|---|---|---|---|---|---|
| id | INT AUTO_INCREMENT | NOT NULL | ✅ | — | — |
| ejecutado | DATETIME(3) | NOT NULL | | CURRENT_TIMESTAMP(3) | — |
| origen | VARCHAR(600) | NOT NULL | | — | Ruta de `data/` |
| manifiesto_sha256 | CHAR(64) | NOT NULL | | — | SHA-256 de `manifiesto-legacy.json` |
| resultado | ENUM('en_proceso','ok','error') | NOT NULL | | 'en_proceso' | — |
| resumen | LONGTEXT (JSON) | NULL | | NULL | Conteos y verificaciones |

#### `legacy_archivos`: inventario de los 18 archivos de `data/` con su checksum

| Campo | Tipo | NULL | PK | FK | Default | Descripción |
|---|---|---|---|---|---|---|
| id | INT AUTO_INCREMENT | NOT NULL | ✅ | | — | — |
| lote_id | INT | NOT NULL | | ✅ → `legacy_lotes.id` | — | — |
| ruta | VARCHAR(600) | NOT NULL | UNIQUE (lote_id, ruta) | | — | `data/...` |
| bytes | BIGINT | NOT NULL | | | — | — |
| sha256 | CHAR(64) | NOT NULL | | | — | SHA-256 del legacy |
| tipo | ENUM('json','excel','imagen','log','otro') | NOT NULL | | | — | — |
| estado | VARCHAR(60) | NOT NULL | | 'migrado' | `migrado`, `conservado_en_disco` o **`historico_pendiente_validacion`** (los 6 calendarios) |
| nota | VARCHAR(500) | NULL | | | NULL | — |

#### `legacy_registros`: foto histórica validada, un registro por fila

Existe por el límite de 1 MB, que impide guardar un archivo completo en una fila. Además, protege el historial: el servidor reemplaza `tiempo_muerto`, `gastos` y `entregas` en cada actualización, y esta tabla no la toca nadie.

| Campo | Tipo | NULL | PK | FK | Default | Descripción |
|---|---|---|---|---|---|---|
| id | BIGINT AUTO_INCREMENT | NOT NULL | ✅ | | — | — |
| lote_id | INT | NOT NULL | | ✅ → `legacy_lotes.id` | — | — |
| fuente | VARCHAR(40) bin | NOT NULL | UNIQUE (lote_id, fuente, clave_legacy) | | — | `tiempo_muerto`, `maquinas`, `gastos`, `entregas`, `contramedidas`, `bonos_semanas`, `bonos_plantilla`, `tiempo_muerto_meta` |
| clave_legacy | VARCHAR(100) bin | NOT NULL | | | — | **Identificador original:** `id` de KOIDE, `id` de contramedida, clave de semana o `orden` (posición) en gastos y entregas |
| orden | INT | NOT NULL | | | — | Posición en el archivo original |
| payload | LONGTEXT (JSON) | NOT NULL | | | — | JSON exacto del registro |
| sha256 | CHAR(64) | NOT NULL | | | — | SHA-256 del `payload` |
| estado_migracion | ENUM('migrado','excluido') | NOT NULL | | 'migrado' | **`2026-W37` = excluido.** Se conserva su contenido completo |
| motivo | VARCHAR(500) | NULL | | | NULL | Motivo de la exclusión |

Índice: `idx_lr_fuente_estado(fuente, estado_migracion)`.

Contenido esperado: 1,967 + 52 + 1,563 + 403 + 5 + 6 (5 migradas y 1 excluida) + 1 + 1 = **3,998 filas**.

#### `legacy_marcas`: marcas sobre datos migrados, sin alterarlos

| Campo | Tipo | NULL | PK | Default | Descripción |
|---|---|---|---|---|---|
| id | INT AUTO_INCREMENT | NOT NULL | ✅ | — | — |
| tabla | VARCHAR(64) | NOT NULL | UNIQUE (tabla, registro, campo, marca) | — | `bonos_semanas` |
| registro | VARCHAR(100) bin | NOT NULL | | — | `2026-W28`… |
| campo | VARCHAR(100) | NOT NULL | | — | `celdas.R13` |
| marca | VARCHAR(60) | NOT NULL | | — | **`heredado_de_plantilla`** |
| valor | TEXT | NULL | | NULL | `suspensión 06 y 07 de agosto 2026` |
| nota | VARCHAR(500) | NULL | | NULL | Por ejemplo, "en W32 las fechas coinciden: REQUIERE VALIDACIÓN" |
| creada | DATETIME(3) | NOT NULL | | CURRENT_TIMESTAMP(3) | — |

Filas esperadas: **5** (W28, W29, W31, W32 y W34).

#### `legacy_anomalias`: incidencias conservadas deliberadamente

| Campo | Tipo | NULL | PK | FK | Default | Descripción |
|---|---|---|---|---|---|---|
| id | INT AUTO_INCREMENT | NOT NULL | ✅ | | — | — |
| lote_id | INT | NOT NULL | | ✅ → `legacy_lotes.id` | — | — |
| codigo | VARCHAR(20) | NOT NULL | | | — | `TM-1` (empleado con texto libre), `TM-2` (paro de más de 24 h), `TM-4` (duplicado lógico), `TM-5` (U+FFFD), `TM-open`, `GA-DUP`, `EN-DUP`, `CM-2`, `CM-1`, `CM-4`, `CM-5`, `BO-*` |
| fuente | VARCHAR(40) | NOT NULL | | | — | Tabla afectada |
| registro | VARCHAR(100) | NOT NULL | | | — | ID legacy afectado |
| campo | VARCHAR(100) | NULL | | | NULL | — |
| valor | TEXT | NULL | | | NULL | Valor tal cual (por ejemplo `adrian`) |
| descripcion | VARCHAR(500) | NOT NULL | | | — | — |
| estado | ENUM('abierta','validada','descartada') | NOT NULL | | 'abierta' | Para la revisión posterior |

Índices: `(codigo)` y `(fuente, registro)`. Filas esperadas: **unas 440**.

#### `diccionario_datos`: clasificación de cada campo como original o calculado

| Campo | Tipo | NULL | PK | Default | Descripción |
|---|---|---|---|---|---|
| tabla | VARCHAR(64) | NOT NULL | ✅ (tabla, campo) | — | — |
| campo | VARCHAR(100) | NOT NULL | ✅ | — | Columna o ruta JSON (`payload.repair_start`, `celdas.N*`) |
| origen | ENUM('original_koide','calculado_koide','original_excel','calculado_script','captura_usuario','calculado_app','copia_de_payload','heredado_de_plantilla','metadato_migracion') | NOT NULL | | — | — |
| descripcion | VARCHAR(500) | NULL | | NULL | — |

---

## 4. Mapa de relaciones

```
                      ┌──────────────┐
                      │ legacy_lotes │
                      └──────┬───────┘
          FK ┌───────────────┼──────────────────┐ FK
             ▼               ▼ FK               ▼
    legacy_archivos   legacy_registros   legacy_anomalias
             :               :                  :
             : (ruta)        : (fuente, clave_legacy = ID original)
             ▼               ▼                  ▼
   archivos en data/   tiempo_muerto.id · maquinas.id · contramedidas.id
                       bonos_semanas.clave · gastos.orden · entregas.orden

  maquinas.id ◄ · · · · tiempo_muerto.machine_id      (lógica, con índice)
  maquinas.code ◄ · · · contramedidas.maquina          (lógica, con índice)
  contramedidas.id ◄━━━ contramedida_fotos.contramedida_id  (FK, ON DELETE CASCADE)
  gastos.po ◄ · · · · · entregas.po                    (lógica, con índice)
  bonos_semanas.clave ◄ · legacy_marcas.registro        (lógica)
  bonos_plantilla.archivo_ruta · · ► data/template-bonos.xlsx
  calendarios.archivo_ruta · · · · ► data/calendarios/<id>.xlsx
  documentos.ruta · · · · · · · · ·► data/documentos/<categoria>/<nombre>

  ━━ = FOREIGN KEY física      · · = relación lógica, sin FK
```

**Por qué hay relaciones sin FK física:**
- `tiempo_muerto` y `maquinas` se reemplazan completas en cada actualización de KOIDE (`store.saveTiempoMuerto` inserta los paros antes que las máquinas). Con una FK, la actualización diaria fallaría.
- `gastos` y `entregas` también se reemplazan desde Python, y `po` no es único.

La integridad actual de estas relaciones ya se verificó: el 100 % de los paros y contramedidas apunta a máquinas existentes, y 398 de 403 entregas tienen su PO en gastos.

---

## 5. Cómo se conservan los IDs originales

| Fuente | ID legacy | Dónde queda |
|---|---|---|
| Paros | `id` de KOIDE | `tiempo_muerto.id` (PK, **no autoincremental**) y `legacy_registros.clave_legacy` |
| Máquinas | `id` y `code` de KOIDE | `maquinas.id` (PK) y `maquinas.code` |
| Contramedidas | `id` generado por el legacy | `contramedidas.id` (PK, binaria: distingue mayúsculas) |
| Fotos | Carpeta `<id>` y nombre del archivo | `contramedida_fotos.contramedida_id` y `nombre`; el archivo no se renombra |
| Semanas de bonos | Clave `2026-Www` | `bonos_semanas.clave` (PK) |
| Gastos y entregas | No tienen ID; se usa la **posición** en el arreglo | `orden` y `legacy_registros.clave_legacy`. El `id` autoincremental no se usa como referencia |
| Calendarios y documentos | Ruta del archivo | `legacy_archivos.ruta` y su SHA-256 |

---

## 6. Datos que se conservan literalmente

- **Todo `payload` y `extra`**, con el orden de claves original. La API devuelve exactamente lo que había en los JSON.
- **Textos con errores:** nombres (`FRANSICO`, doble espacio), `moneda` (`MXM`), `proyecto` (`INGENEIRIA`), `U+FFFD`.
- **Números de empleado con texto libre** (TM-1), **paros de más de 24 h** (TM-2), **duplicado 1169/1170** (TM-4) y duplicados exactos en gastos y entregas.
- **R13** en las celdas de cada semana.
- **Formatos de fecha mezclados** en `bonos_semanas.celdas`.
- **`record_date`** como fecha local, y las fechas y horas en UTC como en el JSON.

## 7. Relación con Node.js (etapa posterior; no se modifica nada ahora)

```
navegador ──HTTP──► server.js ──► lib/store.js (mapeo JSON ⇄ columnas) ──► lib/db.js (pool mysql2) ──► MariaDB 10.4 :3306 / base "metricos"
                        └──► scripts Python (PyMySQL, scripts/metricos_db.py) ──► gastos / entregas
```

- **Conexión:** `.env` con `DB_HOST=127.0.0.1`, `DB_PORT=3306`, `DB_NAME=metricos` y `DB_USER`/`DB_PASSWORD` de un usuario propio (no `root`).
- El driver `mysql2` es compatible con MariaDB 10.4 (autenticación `mysql_native_password`).
- **Cambios que harían falta en esa etapa** (se propondrán uno por uno antes de hacerlos):
  1. `lib/db.js`: ejecutar `SET SESSION sql_mode` estricto en cada conexión del pool, para evitar truncamientos silenciosos.
  2. `scripts/db-setup.js`: tiene fija la collation `utf8mb4_0900_ai_ci` en `CREATE DATABASE`. La base se creará con el nuevo ejecutor de migraciones y no con `--admin`.
  3. `lib/db.js → applySchema()` y `tests/integration.test.js` leen `db/schema.sql` (MySQL 8). Las pruebas deberán apuntar al esquema de MariaDB.
  4. `scripts/metricos_db.py`: también debe usar sesión estricta.
- `deploy/windows/*.ps1` y `DEPLOY.md` buscan un servicio de MySQL 8. No se usan en localhost con XAMPP.

## 8. Extensibilidad futura

- Cada cambio es un archivo nuevo, `db/migrations/NNNN_descripcion.sql`, registrado en `schema_migrations` con su checksum. **Nunca se edita una migración ya aplicada.**
- **Módulos previstos, que no se crean ahora:**
  - `usuarios`, `roles`, `permisos`, `rol_permisos` y `usuario_roles`.
  - Una `bitacora` de auditoría.
  - `tecnicos` (hoy en `config.json`).
  - Parámetros de reglas (22 h, ≥90), hoy en código y en `config.json`.
- Columnas **virtuales** generadas desde `payload` (MariaDB: `AS (JSON_VALUE(payload,'$.campo')) VIRTUAL`) para hacer reportes SQL sin tocar la aplicación. Por ejemplo, `repair_started_by_employee_number` o `closed_by_employee_number`.

## 9. Migraciones que se propondrán para ejecutar (pendientes de aprobación)

| Orden | Archivo nuevo | Contenido |
|---|---|---|
| 1 | `db/migrations/mariadb/0001_esquema_base.sql` | Las 12 tablas de `schema.sql` con la collation `utf8mb4_unicode_520_ci`. **`db/schema.sql` no se toca** |
| 2 | `db/migrations/mariadb/0002_trazabilidad_legacy.sql` | `legacy_lotes`, `legacy_archivos`, `legacy_registros`, `legacy_marcas`, `legacy_anomalias` y `diccionario_datos` |
| — | `scripts/db-migrate.js` | Crea `schema_migrations` y aplica las migraciones en orden, verificando el checksum y en modo estricto |
| — | `scripts/importar-legacy-mariadb.js` | En una transacción, y solo si las tablas están vacías: importa usando las mismas funciones de `lib/store.js`, excluye W37 (que queda como `excluido` en `legacy_registros`), registra las marcas, archivos y anomalías, y verifica conteos y contenido exacto contra los JSON, descontando únicamente W37 |

**Reversibilidad:** todo se crea en una base nueva, `metricos`. Para volver atrás basta con `DROP DATABASE metricos`. Los JSON y `data/` no se modifican, y las otras bases de XAMPP no se ven afectadas.
