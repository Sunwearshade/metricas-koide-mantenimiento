<#
.SYNOPSIS
  Restaura un respaldo generado por backup.ps1 (REEMPLAZA la base y la carpeta de datos).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File deploy\windows\restore.ps1 -BackupZip D:\Respaldos\metricos-20261001-020000.zip
#>
param(
    [Parameter(Mandatory = $true)][string]$BackupZip,
    [string]$ServiceName = 'Metricos'
)

. "$PSScriptRoot\common.ps1"
Assert-Admin

if (-not (Test-Path $BackupZip)) { throw "No existe $BackupZip" }
$cfg = Read-DotEnv
$dbName = Get-EnvValue $cfg 'DB_NAME' 'metricos'
$dataDir = Resolve-AppPath (Get-EnvValue $cfg 'DATA_DIR' 'data')
$port = [int](Get-EnvValue $cfg 'PORT' '4173')

Write-Host ''
Write-Host "Se REEMPLAZARA la base '$dbName' y la carpeta $dataDir con el contenido de:" -ForegroundColor Yellow
Write-Host "   $BackupZip" -ForegroundColor Yellow
Write-Host 'La carpeta de datos actual se conserva renombrada como data.antes-restauracion-<fecha>.' -ForegroundColor Yellow
if ((Read-Host 'Escriba RESTAURAR para continuar') -ne 'RESTAURAR') { Write-Host 'Cancelado.'; exit 1 }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$tmp = Join-Path $env:TEMP "metricos-restore-$stamp"
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::ExtractToDirectory($BackupZip, $tmp)
$sqlFile = Join-Path $tmp 'metricos.sql'
if (-not (Test-Path $sqlFile)) { throw 'El respaldo no contiene metricos.sql' }

$svc = Get-Service $ServiceName -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -ne 'Stopped') { Write-Step "Deteniendo $ServiceName"; Stop-Service $ServiceName -Force }

$cnf = Join-Path $tmp 'cliente.cnf'
try {
    Write-Step "Restaurando base de datos $dbName"
    $sec = Read-Host 'Contrasena de root de MySQL' -AsSecureString
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
    $rootPass = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
    $rootPass = $rootPass.Replace('\', '\\').Replace('"', '\"')
    $utf8 = New-Object Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($cnf, "[client]`nuser=root`npassword=`"$rootPass`"`nhost=$(Get-EnvValue $cfg 'DB_HOST' '127.0.0.1')`nport=$(Get-EnvValue $cfg 'DB_PORT' '3306')`n", $utf8)
    $mysqlExe = Join-Path (Get-MySqlInfo).Bin 'mysql.exe'
    Invoke-Native $mysqlExe @("--defaults-extra-file=$cnf", '--default-character-set=utf8mb4', '-e',
        "CREATE DATABASE IF NOT EXISTS ``$dbName`` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci")
    Invoke-Native $mysqlExe @("--defaults-extra-file=$cnf", '--default-character-set=utf8mb4', $dbName,
        '-e', "source $($sqlFile.Replace('\', '/'))")
    Write-Ok 'Base restaurada'
} finally {
    if (Test-Path $cnf) { Remove-Item $cnf -Force }
}

$backupData = Join-Path $tmp 'data'
if (Test-Path $backupData) {
    Write-Step 'Restaurando carpeta de datos'
    if (Test-Path $dataDir) {
        $old = "$dataDir.antes-restauracion-$stamp"
        Move-Item $dataDir $old
        Write-Ok "Datos anteriores movidos a $old"
    }
    Copy-Item $backupData $dataDir -Recurse
    Write-Ok "Datos restaurados en $dataDir"
}
Remove-Item $tmp -Recurse -Force

Write-Step 'Verificando'
$node = (Get-Command node.exe).Source
$counts = & $node (Join-Path $AppRoot 'scripts\db-counts.js')
Write-Host "    Filas por tabla: $counts"
if ($svc) {
    Start-Service $ServiceName
    if (Test-Health -Port $port -Seconds 60) { Write-Ok "Servicio $ServiceName en linea" } else { Write-Warn2 'El servicio no respondio; revise logs\servicio-error.log' }
}
