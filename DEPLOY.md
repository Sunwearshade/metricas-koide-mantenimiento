# Metricos de Mantenimiento: despliegue en Windows Server

Guía para instalar la aplicación **desde cero** en un Windows Server de la red
interna, con MySQL 8, Node.js y Python 3.12, como **servicio de Windows**.
Al terminar, los usuarios solo tienen que abrir `http://<servidor>:4173/` desde
cualquier equipo de la planta.

---

## 1. Qué cambió respecto a la versión anterior

| Antes | Ahora |
|---|---|
| Datos en archivos `data/*.json` | Datos en **MySQL** (base `metricos`) |
| `INICIAR.bat` abría una ventana CMD que debía quedar abierta | **Servicio de Windows** (NSSM): arranca con el servidor y se reinicia solo si falla |
| Rutas fijas de una PC (`C:\Users\NKM - 0115\...python.exe`, `C:\metricos\...`) | Todo configurable en **`.env`** |
| Contraseñas en `config.json` y en los scripts Python | Contraseñas solo en `.env` (con permisos restringidos) |
| Sin respaldos | **Respaldo diario automático** de MySQL + archivos, con retención |

Lo que **no** cambió: la interfaz, las rutas `/api/...` y las respuestas (se
verificó byte a byte contra la versión anterior), el horario de actualización
diaria de koide (7:00) y la lógica de extracción de los Excel.

Las fotos, los Excel de calendarios, la plantilla de bonos y los documentos
siguen en disco (`data\`); MySQL guarda su ruta.

### Estructura

```
C:\Metricos\
  server.js                 servidor web (Node.js)
  lib\                      env.js (.env), db.js (MySQL), store.js (acceso a datos)
  db\schema.sql             esquema MySQL
  scripts\
    extract_v4.py           Excel de requisiciones  -> tabla gastos
    extract_entregas.py     Excel tiempos de entrega -> tabla entregas
    metricos_db.py          conexión MySQL para Python
    db-setup.js             crea BD, usuario y tablas
    migrate-json-to-mysql.js  migración JSON -> MySQL con verificación
    db-counts.js            filas por tabla (manifiesto de respaldos)
    legacy\                 scripts de depuración antiguos (no se usan)
  deploy\windows\
    install.ps1             instalación / actualización completa
    service.ps1             start | stop | restart | status | uninstall
    backup.ps1              respaldo (lo ejecuta la tarea programada)
    restore.ps1             restaurar un respaldo
  tests\                    pruebas de integración (npm test)
  data\                     fotos, calendarios, plantilla, documentos (+ JSON originales)
  logs\                     logs del servicio, respaldos y reportes de migración
  backups\                  respaldos .zip (configurable)
  .env                      configuración y contraseñas (NO compartir)
```

---

## 2. Requisitos

| Componente | Versión | Notas |
|---|---|---|
| Windows Server | 2016 o posterior | Windows PowerShell 5.1 (viene incluido) |
| MySQL Server | 8.0.16 o posterior (probado con 8.4 LTS) | Instalado como servicio de Windows |
| Node.js | 18.17 o posterior (recomendado **22 LTS x64**) | Probado con 22.x |
| Python | **3.12 x64**, instalado "para todos los usuarios" | Paquetes: openpyxl, msoffcrypto-tool, PyMySQL |
| NSSM | 2.24 | Registra Node.js como servicio. `install.ps1` lo descarga si hay Internet |

Acceso de red **desde el servidor**:

- API koide: `http://192.168.1.201:4000`
- Carpeta compartida donde están los Excel (la que hoy es la unidad `Z:`)

### Información que debe tener a la mano

1. Contraseña de **root** de MySQL (la define al instalar MySQL).
2. Contraseña de la API koide del departamento Mantenimiento (la que estaba en `config.json`).
3. Contraseña del Excel `MANTENIMIENTO_2026.xlsx`.
4. **Ruta UNC** de la unidad `Z:`. En una PC donde `Z:` funciona, ejecute `net use`
   y copie la columna "Remoto", por ejemplo `\\FS01\Compras`.
5. (Recomendado) Una **cuenta de servicio** con permiso de lectura en esa carpeta
   compartida, por ejemplo `PLANTA\svc_metricos` (ver sección 6).

---

## 3. Instalación paso a paso

### 3.1 Instalar MySQL 8

1. Descargue **MySQL Installer for Windows** (dev.mysql.com/downloads/installer) o el MSI de MySQL Server 8.4 LTS.
2. Tipo de instalación: **Server only**.
3. Config Type: *Server Computer*, puerto **3306**. Deje el Firewall de Windows **sin** abrir el 3306 (la app se conecta localmente).
4. Defina la contraseña de **root** y guárdela.
5. *Configure MySQL Server as a Windows Service*: **sí**, con inicio automático (nombre típico `MySQL84` o `MySQL80`).

### 3.2 Instalar Node.js

1. Descargue el instalador **Windows x64 .msi** de Node.js 22 LTS (nodejs.org).
2. Instale con las opciones por defecto (incluye "Add to PATH").
3. Abra una **nueva** consola y compruebe: `node -v`.

### 3.3 Instalar Python 3.12

1. Descargue **Windows installer (64-bit)** de Python 3.12 (python.org).
2. Marque **"Add python.exe to PATH"** y elija **Customize installation**.
3. En *Advanced Options* marque **"Install Python 3.12 for all users"**.
   Quedará en `C:\Program Files\Python312\python.exe`, accesible para el servicio.

### 3.4 Copiar la aplicación (corte desde la PC actual)

> Para no perder capturas, detenga la versión anterior **antes** de copiar los datos.

1. En la PC donde corre hoy la aplicación, **cierre la ventana "Metricos Tiempo Muerto"**.
   Así nadie guarda nada en los JSON después de la copia.
2. Copie la carpeta **completa** del proyecto al servidor, por ejemplo a
   **`C:\Metricos`**. Incluya:
   - `data\`: JSON actuales, fotos, calendarios, plantilla y documentos.
   - `node_modules\`: permite instalar sin Internet.
3. Si el servidor no tiene Internet, siga antes la sección 9 (instalación sin Internet).

### 3.5 Ejecutar el instalador

Abra **PowerShell como Administrador** y ejecute:

```powershell
cd C:\Metricos
powershell -ExecutionPolicy Bypass -File deploy\windows\install.ps1 -ServiceUser 'PLANTA\svc_metricos'
```

Parámetros opcionales:

| Parámetro | Por defecto | Uso |
|---|---|---|
| `-Port` | 4173 (o el de `.env`) | Puerto web. Con `-Port 80` los usuarios abren `http://servidor/` (el 80 no debe estar ocupado por IIS) |
| `-ServiceUser` | *(LocalSystem)* | Cuenta con la que corre el servicio (ver sección 6) |
| `-AllowedNetworks` | `Any` | Orígenes permitidos en el Firewall, p.ej. `192.168.0.0/16` |
| `-BackupTime` | `02:00` | Hora del respaldo diario |
| `-SkipMigration` | | No ejecutar la migración de JSON |

El instalador:

1. Verifica Node.js, Python y el servicio de MySQL.
2. Instala dependencias (`npm ci` solo si faltan paquetes; `pip install -r requirements.txt`).
3. Crea `.env` desde `.env.example` y pide:
   - contraseña de koide;
   - contraseña del Excel;
   - confirmación de las rutas de los Excel (propone la ruta UNC de `Z:` si la detecta).

   La contraseña del usuario MySQL de la app la **genera** automáticamente.
   Restringe los permisos de `.env` a Administradores, SYSTEM y la cuenta del servicio.
4. Pide la contraseña de **root** de MySQL. Crea la base `metricos`, el usuario
   `metricos` (solo local) y las tablas.
5. **Migra** `data\*.json` a MySQL y verifica conteos y contenido
   (reporte en `logs\migracion-*.json`). Si algo no coincide, se detiene y **no**
   instala el servicio. Si la base ya tenía datos, no toca nada.
6. Registra el servicio **"Metricos"** con NSSM:
   - inicio automático, dependiente del servicio de MySQL;
   - reinicio automático a los 5 s si el proceso termina;
   - logs en `logs\servicio.log` y `logs\servicio-error.log`, con rotación de 10 MB.
7. Crea la regla de Firewall de entrada para el puerto.
8. Programa la tarea **"Metricos - Respaldo diario"** (como SYSTEM).
9. Inicia el servicio, comprueba `/api/health`, hace un respaldo de prueba y
   muestra las URL para la red interna.

### 3.6 Verificación después de instalar

1. Desde **otra PC** de la planta abra `http://<nombre-del-servidor>:4173/`.
2. Revise que aparezcan los datos de tiempo muerto, contramedidas, bonos, gastos y entregas.
3. En la vista de gastos pulse **Actualizar**. Esto ejecuta Python contra los Excel
   de la carpeta compartida y confirma el acceso a la red con la cuenta del servicio.
4. `powershell -File deploy\windows\service.ps1 status` muestra el servicio, la salud y el último respaldo.
5. Cuando todo esté bien, retire el acceso directo `INICIAR.bat` de la PC anterior.

---

## 4. Operación

```powershell
cd C:\Metricos
powershell -ExecutionPolicy Bypass -File deploy\windows\service.ps1 status
powershell -ExecutionPolicy Bypass -File deploy\windows\service.ps1 restart   # como Administrador
powershell -ExecutionPolicy Bypass -File deploy\windows\service.ps1 stop
powershell -ExecutionPolicy Bypass -File deploy\windows\service.ps1 start
```

También puede usar `services.msc` → "Metricos de Mantenimiento".
En el servidor, `INICIAR.bat` solo abre el navegador; no inicia una segunda copia.

**Logs** (`C:\Metricos\logs\`):

| Archivo | Contenido |
|---|---|
| `servicio.log` | Salida normal: actualizaciones de koide, cargas de archivos |
| `servicio-error.log` | Errores |
| `respaldos.log` | Resultado de cada respaldo |
| `migracion-*.json` | Reporte de la migración |

**Actualizar la aplicación a una versión nueva:** detenga el servicio, reemplace
los archivos de código **sin tocar** `.env`, `data\`, `logs\` ni `backups\`, y
vuelva a ejecutar `install.ps1`. Es idempotente: no borra datos y la migración
se omite porque la base ya tiene datos.

**Cambiar configuración:** edite `.env` como Administrador y ejecute `service.ps1 restart`.

---

## 5. Respaldos

- Diario a la hora configurada, en `BACKUP_DIR` (por defecto `C:\Metricos\backups`).
- Cada respaldo es `metricos-AAAAMMDD-HHMMSS.zip` con:
  - `metricos.sql` (mysqldump consistente, `--single-transaction`);
  - `data\` completo;
  - `config.json`;
  - `manifiesto.json` (filas por tabla).
- `.env` **no** se incluye porque contiene contraseñas; guárdelo aparte en un lugar seguro.
- Se conservan `BACKUP_RETENTION_DAYS` días (30 por defecto).
- **Recomendado:** apunte `BACKUP_DIR` a otro disco o copie los .zip a otro equipo.
  Si `BACKUP_DIR` es una carpeta de red, la tarea corre como SYSTEM: la cuenta de
  equipo del servidor necesita permiso de escritura ahí.
- Respaldo manual: `powershell -ExecutionPolicy Bypass -File deploy\windows\backup.ps1`

**Restaurar** (reemplaza la base y `data\`; la carpeta actual se conserva renombrada):

```powershell
powershell -ExecutionPolicy Bypass -File deploy\windows\restore.ps1 -BackupZip C:\Metricos\backups\metricos-20261001-020000.zip
```

---

## 6. La unidad Z: y la cuenta del servicio (importante)

Un servicio de Windows **no ve las unidades mapeadas** (`Z:`); esas existen solo
en la sesión del usuario que las mapeó. Por eso en `.env` las rutas de los Excel
deben ser **UNC**:

```
GASTOS_EXCEL_PATH=\\FS01\Compras\1.REQUISICIONES\6. REQUISICIONES 2026\12.- MANTENIMIENTO\2.-  MANTENIMIENTO_2026.xlsx
ENTREGAS_EXCEL_PATH=\\FS01\Compras\1.REQUISICIONES\6. REQUISICIONES 2026\0. TIEMPOS DE ENTREGA\TIEMPO DE ENTREGA.xlsx
```

(Observe los **dos espacios** en `2.-  MANTENIMIENTO_2026.xlsx`: así se llama el archivo.)

La cuenta con la que corre el servicio debe poder leer esa carpeta:

- **Con `-ServiceUser DOMINIO\usuario`** (recomendado): dele permiso de lectura en
  la carpeta compartida. El instalador le da permiso de modificación sobre `C:\Metricos`.
- **Sin `-ServiceUser`** (LocalSystem): accede a la red como la cuenta de equipo
  `DOMINIO\SERVIDOR$`. Funciona si el recurso compartido la permite. Fuera de un
  dominio, LocalSystem no tiene acceso a carpetas de red.

Cuando el año cambie (`REQUISICIONES 2027`), actualice las dos rutas en `.env` y
reinicie el servicio.

---

## 7. Variables de `.env`

| Variable | Descripción |
|---|---|
| `PORT` | Puerto HTTP (4173) |
| `HOST` | Vacío = todas las interfaces (necesario para la LAN) |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | Conexión MySQL de la app |
| `DATA_DIR` | Carpeta de archivos (`data`) |
| `LOG_DIR` | Carpeta de logs (`logs`) |
| `BACKUP_DIR`, `BACKUP_RETENTION_DAYS` | Destino y retención de respaldos |
| `MYSQLDUMP_PATH` | (Opcional) ruta a `mysqldump.exe` si no se detecta sola |
| `KOIDE_BASE_URL`, `KOIDE_DEPARTMENT`, `KOIDE_PASSWORD` | API koide |
| `PYTHON_PATH` | Ruta completa a `python.exe` |
| `GASTOS_EXCEL_PATH`, `ENTREGAS_EXCEL_PATH` | Excel en la carpeta compartida (UNC) |
| `GASTOS_EXCEL_PASSWORD` | Contraseña del Excel de requisiciones |

`config.json` conserva la configuración funcional: técnicos, pesos de desempeño,
bonos, colores y hora de actualización diaria.

---

## 8. Base de datos

| Tabla | Contenido | Origen |
|---|---|---|
| `tiempo_muerto`, `maquinas` | Espejo de la API koide (se reemplaza en cada actualización) | koide |
| `gastos` | Partidas del Excel de requisiciones | `extract_v4.py` |
| `entregas` | Tiempos de entrega de MTTO | `extract_entregas.py` |
| `contramedidas`, `contramedida_fotos` | Contramedidas y rutas de sus fotos | App |
| `bonos_plantilla`, `bonos_semanas` | Plantilla Excel parseada y captura semanal | App |
| `calendarios` | Calendarios subidos (ruta del .xlsx, hojas y estatus) | App |
| `documentos` | Documentos por categoría (ruta, tamaño); se sincroniza con la carpeta | App |
| `fuentes_sync` | Última actualización de cada fuente externa | Sistema |
| `migraciones` | Bitácora de migraciones JSON → MySQL | Sistema |

Las tablas espejo tienen columnas tipadas para consultas SQL y una columna
`payload` con el registro exacto que entrega la API. Ejemplo:

```sql
SELECT machine_code, COUNT(*) paros, SUM(downtime_minutes) minutos
FROM tiempo_muerto WHERE record_date >= '2026-09-01'
GROUP BY machine_code ORDER BY minutos DESC;
```

Los JSON originales se quedan en `data\` como archivo histórico. La aplicación ya
no los lee. Para volver a comparar la base contra ellos:
`node scripts\migrate-json-to-mysql.js --verify-only`. Este comando **solo** coincide
mientras nadie haya modificado datos en la aplicación.

---

## 9. Instalación sin Internet

1. **node_modules**: copie la carpeta desde el equipo de desarrollo. El instalador
   no ejecuta `npm ci` si ya está completa.
2. **Paquetes Python**: en un equipo con Internet y el mismo Python 3.12 x64:
   ```
   pip download -r requirements.txt -d tools\wheels --only-binary=:all: --python-version 3.12 --platform win_amd64
   ```
   Copie `tools\wheels` al servidor. El instalador lo usa si `pip install` falla.
3. **NSSM**: descargue `nssm-2.24.zip` (nssm.cc) y copie `win64\nssm.exe` a `C:\Metricos\tools\nssm.exe`.

---

## 10. Pruebas

Las pruebas de integración usan una base **aparte**, cuyo nombre debe terminar en
`_test` porque la prueba borra su contenido. También usan un simulador de la API
koide y Excel sintéticos.

1. Cree la base y dé permisos al usuario de la app (como root en MySQL):
   ```sql
   CREATE DATABASE metricos_test CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
   GRANT ALL ON metricos_test.* TO 'metricos'@'localhost', 'metricos'@'127.0.0.1', 'metricos'@'::1';
   ```
2. Cree `C:\Metricos\.env.test`:
   ```
   DB_HOST=127.0.0.1
   DB_PORT=3306
   DB_NAME=metricos_test
   DB_USER=metricos
   DB_PASSWORD=<la de .env>
   PYTHON_PATH=C:\Program Files\Python312\python.exe
   ```
3. `npm test`

---

## 11. Solución de problemas

| Síntoma | Causa probable / solución |
|---|---|
| Desde otras PCs no abre, en el servidor sí | Regla de Firewall o puerto: `service.ps1 status`, `Get-NetFirewallRule -DisplayName 'Metricos*'` |
| El servicio arranca y se detiene | `logs\servicio-error.log`. Si dice "No se pudo conectar a MySQL", revise el servicio de MySQL y `DB_PASSWORD` |
| "Actualizar" gastos muestra error | Ruta UNC o permisos de la cuenta del servicio sobre la carpeta compartida; contraseña del Excel. Pruebe como esa cuenta: `python scripts\extract_v4.py` |
| Tiempo muerto no se actualiza (`lastError`) | Conectividad a `192.168.1.201:4000` o `KOIDE_PASSWORD` |
| `install.ps1` se detiene en la migración | Abra `logs\migracion-*.json`: indica la tabla y el primer dato distinto |
| Respaldo falla | `logs\respaldos.log`; si no se encuentra mysqldump, defina `MYSQLDUMP_PATH` en `.env` |
