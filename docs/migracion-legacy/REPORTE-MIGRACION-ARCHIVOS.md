# Migración de archivos y datos legacy → proyecto nuevo

- **Fecha:** 2026-09-24
- **Origen (legacy):** `C:\Users\bg117\Downloads\metricos\metricos`
- **Destino:** `C:\Users\bg117\OneDrive\Documentos\metricas-koide-mantenimiento`
- **Alcance:** solo archivos y datos. La base de datos, MySQL/MariaDB y los cambios de lógica quedan para etapas posteriores.
- **Detalle en formato de máquina** (checksums, IDs y anomalías completas): [`manifiesto-legacy.json`](manifiesto-legacy.json).

## 1. Archivos copiados

No se copió ningún archivo de datos, porque todos ya existían en el proyecto nuevo con el mismo contenido.

Cambios agregados:

| Recurso | Motivo |
|---|---|
| `data/documentos/<6 categorías>/` (carpetas vacías) | Igualar la estructura del legacy. En el legacy también están vacías; git no versiona carpetas vacías |
| `docs/migracion-legacy/manifiesto-legacy.json` | Registro de decisiones, checksums y anomalías para la importación a la base de datos |
| `docs/migracion-legacy/REPORTE-MIGRACION-ARCHIVOS.md` | Este reporte |

**No se modificó ni se eliminó ningún archivo existente.** Se verificó con los hashes SHA-256 de los 61 archivos, tomados antes y después.

## 2. Datos migrados

Todos los datos del legacy ya están presentes en el proyecto nuevo con contenido idéntico, incluido el orden de las claves. Ver la sección 8.

## 3. Datos descartados

| Dato | Motivo | Cómo se aplica |
|---|---|---|
| `bonos.json → weeks["2026-W37"]` | Semana vacía, creada por el autoguardado de `buscarBono()` el 2026-08-10, antes de que ocurriera | **Sigue en `data/bonos.json`**, porque el archivo es idéntico al legacy y no se sobrescribe. La exclusión está registrada en el manifiesto y **se aplicará en la importación** |

No se copiaron contraseñas: `koideLogin.password` de `config.json` ni `PASSWORD` de `extract_v4.py` del legacy. El proyecto nuevo las toma de `.env`.

## 4. Datos que ya estaban presentes

Los 18 archivos de `data/` del legacy están presentes en el nuevo:

- **14 idénticos byte a byte:** `tiempo-muerto.json`, `gastos.json`, `entregas.json`, `calendarios.json`, `template-bonos.xlsx`, `Bono semanal mantenimiento.xlsx`, los 6 calendarios, la foto y `server-err.log`.
- **4 con el mismo contenido y diferente fin de línea** (CRLF por `core.autocrlf` de git): `bonos.json`, `contramedidas.json`, `server.log` y `server-out.log`.

`public/` también tiene el mismo contenido, y los scripts de depuración del legacy están en `scripts/legacy/`, con el mismo contenido.

## 5. Diferencias detectadas (no se sobrescribió nada)

| Archivo | Diferencia | Propuesta |
|---|---|---|
| `config.json` | El nuevo ya no tiene `koideLogin` (con la contraseña) | Conservar el nuevo |
| `INICIAR.bat` | El nuevo lee `PORT` de `.env`, detecta el servicio de Windows y no usa rutas fijas | Conservar el nuevo |
| `server.js`, `package.json`, `package-lock.json` | Versión para MySQL | Conservar el nuevo |
| `scripts/extract_v4.py`, `scripts/extract_entregas.py` | Rutas y contraseña vienen de `.env`, y escriben en MySQL en lugar de JSON. La lógica de extracción es la misma | Conservar el nuevo |

## 6. Anomalías conservadas deliberadamente (no se corrigieron)

- **Tiempo muerto (datos de KOIDE):**
  - 22 valores de número de empleado con texto libre.
  - 95 paros de más de 24 h.
  - 1 duplicado lógico: ids 1169 y 1170.
  - 311 registros con el carácter `U+FFFD` (codificación defectuosa en el origen).
  - 1 paro sin finalizar (id 26).
- **Gastos:** 7 grupos de registros duplicados exactos (9 registros de más).
- **Entregas:** 1 grupo de duplicados exactos (posiciones 345 y 347).
- **Contramedidas:**
  - El responsable `JOSE CARLOS FLORES MENCHACA` no está en `config.json`.
  - La foto no tiene etiqueta de "antes" o "después".
  - `mt07hwfck0ns2` no tiene fecha de completado y su fecha límite es anterior a su creación.
- **Bonos:**
  - `R13 = "suspensión 06 y 07 de agosto 2026"` es **heredado de la plantilla** y aparece en las 5 semanas que se migran (W28, W29, W31, W32 y W34). Se migrará tal cual, marcado en el manifiesto.
  - Formatos de fecha mezclados.
  - El encabezado de Eficiencia siempre muestra la semana 32.
  - Las filas 42 y 43 están vacías.
- **Reglas del legacy conservadas:** MTBF con 22 h por día, y bono A con índice ≥ 90.

## 7. Pendientes de validación

1. Los 6 calendarios en `data/calendarios/` están conservados pero **no registrados ni activos**.
2. Si en la semana 2026-W32 el valor de R13 es un dato propio de esa semana, porque las fechas de la suspensión coinciden con ella.
3. Si la copia legacy de Descargas es la más reciente. El legacy escribía los gastos en `C:\metricos\data`, una carpeta que no existe en esta PC.
4. Si la foto de `mt07hwfck0ns2` es de antes o de después.
5. Las anomalías de KOIDE (para reportarlas al área responsable).

## 8. Conteo final por fuente (proyecto nuevo)

| Fuente | Registros | Se migrarán a la base de datos |
|---|---|---|
| Paros (`tiempo-muerto.json`) | 1,967 (ids del 3 al 4528, todos únicos) | 1,967 |
| Máquinas | 52 | 52 |
| Gastos | 1,563 | 1,563 |
| Entregas | 403 | 403 |
| Contramedidas | 5 | 5 |
| Fotos de contramedidas | 1 | 1 |
| Plantilla de bonos | 1 (más el Excel) | 1 |
| Semanas de bonos | 6 en el archivo | **5** (se excluye W37) |
| Calendarios registrados | 0 | 0 |
| Archivos de calendario no registrados | 6 | Solo se conservan los archivos |
| Documentos | 0 | 0 |

## 9. Lo que falta migrar

Ningún archivo ni dato de negocio del legacy falta en el proyecto nuevo. Las acciones pendientes corresponden a la etapa de base de datos: aplicar la exclusión de W37 y la marca de R13 al importar.
