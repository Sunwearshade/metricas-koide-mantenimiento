<#
.SYNOPSIS
  Instala / actualiza Metricos de Mantenimiento en Windows Server.

.DESCRIPTION
  1. Verifica Node.js, Python y MySQL.
  2. Instala dependencias (npm y pip).
  3. Genera/completa .env (credenciales y rutas).
  4. Crea la base de datos, el usuario y las tablas de MySQL.
  5. Migra los JSON de data\ a MySQL (solo si la base esta vacia) y verifica conteos.
  6. Registra el servicio de Windows con NSSM (arranque automatico, reinicio si falla).
  7. Abre el puerto en el Firewall para la red interna.
  8. Programa el respaldo diario (MySQL + archivos).
  9. Inicia el servicio y comprueba que responda.

  Se puede volver a ejecutar para actualizar: no borra datos.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File deploy\windows\install.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File deploy\windows\install.ps1 -Port 80 -ServiceUser 'PLANTA\svc_metricos'
#>
param(
    [string]$ServiceName = 'Metricos',
    [int]$Port = 0,
    [string]$ServiceUser = '',
    [string]$AllowedNetworks = 'Any',
    [string]$BackupTime = '02:00',
    [switch]$SkipMigration
)

. "$PSScriptRoot\common.ps1"
Assert-Admin
Set-Location $AppRoot

function Read-Secret([string]$Prompt) {
    $sec = Read-Host -Prompt $Prompt -AsSecureString
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

function New-RandomPassword([int]$Length = 24) {
    $chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'.ToCharArray()
    $bytes = New-Object byte[] $Length
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    return -join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] })
}

function Find-Python {
    $cands = @()
    $py = Get-Command py.exe -ErrorAction SilentlyContinue
    if ($py) {
        try { $cands += (& $py.Source -3.12 -c 'import sys; print(sys.executable)' 2>$null) } catch { }
        try { $cands += (& $py.Source -3 -c 'import sys; print(sys.executable)' 2>$null) } catch { }
    }
    $pyexe = Get-Command python.exe -All -ErrorAction SilentlyContinue | Where-Object { $_.Source -notmatch 'WindowsApps' }
    foreach ($c in $pyexe) { $cands += $c.Source }
    $cands += Get-ChildItem 'C:\Program Files\Python3*\python.exe' -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | ForEach-Object { $_.FullName }
    foreach ($c in $cands) { if ($c -and (Test-Path $c)) { return $c } }
    return $null
}

# Unidad mapeada (Z:) -> ruta UNC. El servicio no ve unidades mapeadas.
function Convert-ToUnc([string]$p) {
    if ($p -notmatch '^([A-Za-z]):\\(.*)$') { return $p }
    $letter = $Matches[1].ToUpper()
    $rest = $Matches[2]
    $root = $null
    try { $root = (Get-ItemProperty "HKCU:\Network\$letter" -ErrorAction Stop).RemotePath } catch { }
    if (-not $root) {
        $m = Get-CimInstance Win32_MappedLogicalDisk -ErrorAction SilentlyContinue | Where-Object { $_.DeviceID -eq "${letter}:" } | Select-Object -First 1
        if ($m) { $root = $m.ProviderName }
    }
    if (-not $root) { return $p }
    return (Join-Path $root $rest)
}

# ---------------------------------------------------------------- 1. Requisitos
Write-Step 'Verificando requisitos'
$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) { throw 'No se encontro Node.js. Instale Node.js LTS (x64) y vuelva a ejecutar.' }
$nodeExe = $node.Source
$nodeVer = (& $nodeExe -v).TrimStart('v')
if ([version]$nodeVer -lt [version]'18.17.0') { throw "Node.js $nodeVer es muy antiguo; se requiere 18.17 o superior (recomendado 22 LTS)." }
Write-Ok "Node.js $nodeVer ($nodeExe)"
$npm = Join-Path (Split-Path $nodeExe) 'npm.cmd'

$python = Find-Python
if (-not $python) { throw 'No se encontro Python. Instale Python 3.12 (x64) "para todos los usuarios" y vuelva a ejecutar.' }
Write-Ok "Python: $python ($(& $python --version 2>&1))"

$mysql = Get-MySqlInfo
if (-not $mysql.ServiceName) { throw 'No se encontro el servicio de MySQL. Instale MySQL Server 8.' }
$mysqlSvc = Get-Service $mysql.ServiceName
if ($mysqlSvc.Status -ne 'Running') { Start-Service $mysql.ServiceName }
Write-Ok "MySQL: servicio $($mysql.ServiceName), bin $($mysql.Bin)"

# Si el servicio ya existe (actualizacion), detenerlo mientras se instala.
$existing = Get-Service $ServiceName -ErrorAction SilentlyContinue
if ($existing -and $existing.Status -ne 'Stopped') {
    Write-Step "Deteniendo servicio $ServiceName para actualizar"
    Stop-Service $ServiceName -Force
}

# ---------------------------------------------------------------- 2. Dependencias
Write-Step 'Verificando dependencias de Node.js'
# "npm ci" borra node_modules antes de descargar: solo se usa si faltan paquetes.
$lsCode = Invoke-Native $npm @('ls', '--omit=dev', '--depth=0') -AllowFail
if ($lsCode -eq 0) {
    Write-Ok 'node_modules completo'
} else {
    Invoke-Native $npm @('ci', '--omit=dev', '--no-audit', '--no-fund')
    Write-Ok 'Dependencias instaladas con npm ci'
}
Write-Step 'Instalando dependencias de Python (pip)'
$pipCode = Invoke-Native $python @('-m', 'pip', 'install', '--disable-pip-version-check', '-r', (Join-Path $AppRoot 'requirements.txt')) -AllowFail
if ($pipCode -ne 0) {
    $wheels = Join-Path $AppRoot 'tools\wheels'
    if (Test-Path $wheels) {
        Invoke-Native $python @('-m', 'pip', 'install', '--no-index', '--find-links', $wheels, '-r', (Join-Path $AppRoot 'requirements.txt'))
    } else {
        throw 'pip fallo. Sin Internet, copie los paquetes a tools\wheels (ver DEPLOY.md).'
    }
}
Invoke-Native $python @('-c', 'import openpyxl, msoffcrypto, pymysql')
Write-Ok 'Modulos Python instalados (openpyxl, msoffcrypto, pymysql)'

# ---------------------------------------------------------------- 3. .env
Write-Step 'Configurando .env'
if (-not (Test-Path $EnvFile)) {
    Copy-Item (Join-Path $AppRoot '.env.example') $EnvFile
    Write-Ok '.env creado desde .env.example'
}
$cfg = Read-DotEnv
$set = @{}
if ($Port -gt 0) { $set['PORT'] = "$Port" }
if (-not $cfg['DB_PASSWORD']) { $set['DB_PASSWORD'] = New-RandomPassword; Write-Ok 'Contrasena de MySQL para el usuario de la app generada' }
if (-not $cfg['TERMINAL_API_KEY']) { $set['TERMINAL_API_KEY'] = New-RandomPassword 32; Write-Ok 'Clave para la terminal de produccion (TERMINAL_API_KEY) generada' }
if (-not $cfg['KOIDE_PASSWORD']) { $set['KOIDE_PASSWORD'] = Read-Secret 'Contrasena de la API koide (departamento Mantenimiento)' }
if (-not $cfg['GASTOS_EXCEL_PASSWORD']) { $set['GASTOS_EXCEL_PASSWORD'] = Read-Secret 'Contrasena del Excel de requisiciones (MANTENIMIENTO_2026.xlsx)' }
$pyCfg = Get-EnvValue $cfg 'PYTHON_PATH' ''
if (-not $pyCfg -or -not (Test-Path $pyCfg)) { $set['PYTHON_PATH'] = $python }

foreach ($key in @('GASTOS_EXCEL_PATH', 'ENTREGAS_EXCEL_PATH')) {
    $cur = Get-EnvValue $cfg $key ''
    if ($cur -match '\\\\SERVIDOR\\RECURSO\\') {
        $default = $cur -replace '^\\\\SERVIDOR\\RECURSO', 'Z:'
        $unc = Convert-ToUnc $default
        Write-Host "    $key"
        Write-Host "      Valor sugerido: $unc"
        $resp = Read-Host '      Enter para aceptar o escriba la ruta completa (UNC \\servidor\recurso\...)'
        if ($resp) { $unc = Convert-ToUnc $resp }
        $set[$key] = $unc
    }
}
if ($set.Count) { Set-DotEnvValues $set }
$cfg = Read-DotEnv
$Port = [int](Get-EnvValue $cfg 'PORT' '4173')

foreach ($key in @('GASTOS_EXCEL_PATH', 'ENTREGAS_EXCEL_PATH')) {
    $p = $cfg[$key]
    if ($p -match '^[A-Za-z]:\\' -and $p -notmatch '^[Cc]:\\') {
        Write-Warn2 "$key usa una unidad de red mapeada ($p). El servicio NO la vera: use la ruta UNC."
    }
    if (-not (Test-Path -LiteralPath $p)) {
        Write-Warn2 "$key no es accesible desde esta sesion: $p"
    } else {
        Write-Ok "$key accesible"
    }
}

# .env solo legible por Administradores, SYSTEM y la cuenta del servicio.
$acl = @('/inheritance:r', '/grant:r', '*S-1-5-32-544:F', '/grant:r', '*S-1-5-18:F')
if ($ServiceUser) { $acl += @('/grant:r', "${ServiceUser}:R") }
Invoke-Native icacls.exe (@($EnvFile) + $acl)

# ---------------------------------------------------------------- 4. MySQL
Write-Step 'Creando base de datos, usuario y tablas'
$env:DB_ADMIN_USER = 'root'
$env:DB_ADMIN_PASSWORD = Read-Secret 'Contrasena de root de MySQL'
try {
    Invoke-Native $nodeExe @((Join-Path $AppRoot 'scripts\db-setup.js'), '--admin')
} finally {
    Remove-Item Env:DB_ADMIN_PASSWORD -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------- 5. Migracion
if (-not $SkipMigration) {
    Write-Step 'Migrando JSON de data\ a MySQL'
    # No destructiva e idempotente: solo inserta lo que falte y verifica.
    $code = Invoke-Native $nodeExe @((Join-Path $AppRoot 'scripts\migrate-json-to-mysql.js')) -AllowFail
    if ($code -ne 0) {
        throw 'La migracion o su verificacion fallo. Revise el reporte en logs\migracion-*.json. El servicio NO se instalo.'
    }
    Write-Ok 'Migracion verificada: sin perdida de datos.'
}

# ---------------------------------------------------------------- 5b. Usuario administrador
Write-Step 'Usuarios de la aplicacion'
Invoke-Native $nodeExe @((Join-Path $AppRoot 'scripts\usuarios.js'), 'listar') -AllowFail | Out-Null
if ((Read-Host '    Crear un usuario mantenimiento_admin ahora? (s/N)') -match '^[sS]') {
    $adminUser = Read-Host '    Usuario (p.ej. admin.mtto)'
    $adminName = Read-Host '    Nombre completo'
    $env:USUARIO_PASSWORD = Read-Secret '    Contrasena (min. 8 caracteres)'
    try {
        Invoke-Native $nodeExe @((Join-Path $AppRoot 'scripts\usuarios.js'), 'crear', $adminUser, 'mantenimiento_admin', $adminName)
    } finally {
        Remove-Item Env:USUARIO_PASSWORD -ErrorAction SilentlyContinue
    }
}

# ---------------------------------------------------------------- 6. Servicio (NSSM)
Write-Step "Registrando servicio de Windows '$ServiceName'"
$nssm = Get-Nssm
if (-not $nssm) {
    Write-Host '    nssm.exe no encontrado; intentando descargar nssm 2.24...'
    $tools = Join-Path $AppRoot 'tools'
    New-Item -ItemType Directory -Force $tools | Out-Null
    $zip = Join-Path $env:TEMP 'nssm-2.24.zip'
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -UseBasicParsing 'https://nssm.cc/release/nssm-2.24.zip' -OutFile $zip
        Expand-Archive $zip -DestinationPath $env:TEMP -Force
        Copy-Item (Join-Path $env:TEMP 'nssm-2.24\win64\nssm.exe') (Join-Path $tools 'nssm.exe')
        $nssm = Join-Path $tools 'nssm.exe'
    } catch {
        throw 'No se pudo descargar NSSM. Descargue nssm 2.24 (https://nssm.cc) y copie win64\nssm.exe a tools\nssm.exe'
    }
}
Write-Ok "NSSM: $nssm"

$logDir = Resolve-AppPath (Get-EnvValue $cfg 'LOG_DIR' 'logs')
New-Item -ItemType Directory -Force $logDir | Out-Null

if (-not (Get-Service $ServiceName -ErrorAction SilentlyContinue)) {
    Invoke-Native $nssm @('install', $ServiceName, $nodeExe, 'server.js')
}
$settings = @(
    @('Application', $nodeExe),
    @('AppParameters', 'server.js'),
    @('AppDirectory', $AppRoot),
    @('DisplayName', 'Metricos de Mantenimiento'),
    @('Description', 'Metricos de Mantenimiento (Node.js + MySQL). Carpeta: ' + $AppRoot),
    @('Start', 'SERVICE_AUTO_START'),
    @('AppStdout', (Join-Path $logDir 'servicio.log')),
    @('AppStderr', (Join-Path $logDir 'servicio-error.log')),
    @('AppRotateFiles', '1'),
    @('AppRotateOnline', '1'),
    @('AppRotateBytes', '10485760'),
    @('AppExit', 'Default', 'Restart'),
    @('AppRestartDelay', '5000'),
    @('AppStopMethodConsole', '5000'),
    @('AppEnvironmentExtra', 'NODE_ENV=production'),
    @('DependOnService', $mysql.ServiceName)
)
foreach ($s in $settings) { Invoke-Native $nssm (@('set', $ServiceName) + $s) }

if ($ServiceUser) {
    $svcPass = Read-Secret "Contrasena de la cuenta de servicio $ServiceUser"
    Invoke-Native $nssm @('set', $ServiceName, 'ObjectName', $ServiceUser, $svcPass)
    Invoke-Native icacls.exe @($AppRoot, '/grant', "${ServiceUser}:(OI)(CI)M", '/T', '/Q')
    Write-Ok "El servicio corre como $ServiceUser (con permiso de modificacion en $AppRoot)"
} else {
    Write-Ok 'El servicio corre como LocalSystem (acceso a red como cuenta de equipo)'
}

# ---------------------------------------------------------------- 7. Firewall
Write-Step "Abriendo puerto TCP $Port en el Firewall (entrada)"
$ruleName = "Metricos de Mantenimiento (TCP $Port)"
Get-NetFirewallRule -DisplayName 'Metricos de Mantenimiento (TCP *' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP -LocalPort $Port `
    -Action Allow -Profile Any -RemoteAddress $AllowedNetworks | Out-Null
Write-Ok "Regla '$ruleName' (origen: $AllowedNetworks)"

# ---------------------------------------------------------------- 8. Respaldo diario
Write-Step "Programando respaldo diario a las $BackupTime"
$taskName = 'Metricos - Respaldo diario'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$PSScriptRoot\backup.ps1`""
$trigger = New-ScheduledTaskTrigger -Daily -At $BackupTime
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$taskSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 2)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal `
    -Settings $taskSettings -Description 'Respaldo de MySQL y archivos de Metricos' -Force | Out-Null
Write-Ok "Tarea '$taskName' registrada"

# ---------------------------------------------------------------- 9. Inicio
Write-Step "Iniciando servicio $ServiceName"
Start-Service $ServiceName
$health = Test-Health -Port $Port -Seconds 90
if (-not $health) {
    throw "El servicio no respondio en http://localhost:$Port/api/health. Revise $logDir\servicio-error.log"
}
Write-Ok "Responde: $health"

Write-Step 'Ejecutando un primer respaldo de prueba'
Invoke-Native powershell.exe @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "$PSScriptRoot\backup.ps1") -AllowFail | Out-Null

Write-Host ''
Write-Host 'Instalacion terminada. Los usuarios de la red interna pueden abrir:' -ForegroundColor Green
foreach ($u in (Get-LanUrls $Port)) { Write-Host "   $u" -ForegroundColor Green }
