<#
.SYNOPSIS
  Respaldo de Metricos: volcado de MySQL + carpeta de datos (fotos, Excel, documentos).

.DESCRIPTION
  Genera BACKUP_DIR\metricos-AAAAMMDD-HHMMSS.zip con:
    metricos.sql     volcado completo de la base (mysqldump --single-transaction)
    data\            copia de DATA_DIR (fotos, calendarios, plantilla, documentos)
    config.json
    manifiesto.json  fecha, servidor y numero de filas por tabla
  Borra respaldos y logs rotados con mas de BACKUP_RETENTION_DAYS dias.
  La tarea programada "Metricos - Respaldo diario" ejecuta este script.
  El archivo .env (contrasenas) NO se incluye.
#>
param(
    [string]$BackupDir = '',
    [int]$RetentionDays = 0
)

. "$PSScriptRoot\common.ps1"

$cfg = Read-DotEnv
if (-not $BackupDir) { $BackupDir = Resolve-AppPath (Get-EnvValue $cfg 'BACKUP_DIR' 'backups') }
if ($RetentionDays -le 0) { $RetentionDays = [int](Get-EnvValue $cfg 'BACKUP_RETENTION_DAYS' '30') }
$dataDir = Resolve-AppPath (Get-EnvValue $cfg 'DATA_DIR' 'data')
$logDir = Resolve-AppPath (Get-EnvValue $cfg 'LOG_DIR' 'logs')
$dbName = Get-EnvValue $cfg 'DB_NAME' 'metricos'
New-Item -ItemType Directory -Force $BackupDir, $logDir | Out-Null
$logFile = Join-Path $logDir 'respaldos.log'

function Log([string]$msg) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
    Write-Host $line
    Add-Content -Path $logFile -Value $line -Encoding UTF8
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$staging = Join-Path $BackupDir "tmp-$stamp"
$zipPath = Join-Path $BackupDir "metricos-$stamp.zip"
$cnf = Join-Path $staging 'cliente.cnf'

try {
    New-Item -ItemType Directory -Force $staging | Out-Null

    $mysqldump = Get-EnvValue $cfg 'MYSQLDUMP_PATH' ''
    if (-not $mysqldump) { $mysqldump = Join-Path (Get-MySqlInfo).Bin 'mysqldump.exe' }
    if (-not (Test-Path $mysqldump)) { throw "No se encontro mysqldump ($mysqldump). Defina MYSQLDUMP_PATH en .env" }

    # Credenciales en archivo temporal (no en la linea de comandos).
    $dbPass = (Get-EnvValue $cfg 'DB_PASSWORD' '').Replace('\', '\\').Replace('"', '\"')
    $utf8 = New-Object Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($cnf, "[client]`nuser=`"$(Get-EnvValue $cfg 'DB_USER' 'metricos')`"`npassword=`"$dbPass`"`nhost=$(Get-EnvValue $cfg 'DB_HOST' '127.0.0.1')`nport=$(Get-EnvValue $cfg 'DB_PORT' '3306')`n", $utf8)

    $sqlFile = Join-Path $staging 'metricos.sql'
    Invoke-Native $mysqldump @("--defaults-extra-file=$cnf", '--single-transaction', '--quick', '--no-tablespaces',
        '--triggers', '--hex-blob', '--default-character-set=utf8mb4', '--set-gtid-purged=OFF',
        "--result-file=$sqlFile", $dbName)
    Remove-Item $cnf -Force
    Log "mysqldump OK ($([math]::Round((Get-Item $sqlFile).Length / 1MB, 2)) MB)"

    if (Test-Path $dataDir) {
        Copy-Item -Path $dataDir -Destination (Join-Path $staging 'data') -Recurse -Force
    }
    $configFile = Join-Path $AppRoot 'config.json'
    if (Test-Path $configFile) { Copy-Item $configFile $staging }

    $counts = $null
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if ($nodeCmd) {
        $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
        $counts = & $nodeCmd.Source (Join-Path $AppRoot 'scripts/db-counts.js') 2>$null
        $ErrorActionPreference = $prev
    }
    $manifest = [ordered]@{
        fecha    = (Get-Date).ToString('o')
        servidor = [Environment]::MachineName
        base     = $dbName
        dataDir  = $dataDir
        filas    = $(if ($counts) { $counts | ConvertFrom-Json } else { $null })
    }
    [IO.File]::WriteAllText((Join-Path $staging 'manifiesto.json'), ($manifest | ConvertTo-Json -Depth 5), $utf8)

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::CreateFromDirectory($staging, $zipPath)
    Log "Respaldo creado: $zipPath ($([math]::Round((Get-Item $zipPath).Length / 1MB, 2)) MB)"
} catch {
    Log "ERROR en respaldo: $($_.Exception.Message)"
    if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
    exit 1
} finally {
    if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
}

# Retencion
$limit = (Get-Date).AddDays(-$RetentionDays)
Get-ChildItem $BackupDir -Filter 'metricos-*.zip' | Where-Object { $_.LastWriteTime -lt $limit } | ForEach-Object {
    Remove-Item $_.FullName -Force
    Log "Respaldo antiguo eliminado: $($_.Name)"
}
# Logs rotados por NSSM (servicio-AAAAMMDDThhmmss.mmm.log); los actuales no se tocan.
Get-ChildItem $logDir -Filter 'servicio*-*.log' -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -notin @('servicio.log', 'servicio-error.log') -and $_.LastWriteTime -lt $limit } |
    Remove-Item -Force -ErrorAction SilentlyContinue
exit 0
