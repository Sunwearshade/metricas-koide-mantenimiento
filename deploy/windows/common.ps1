# Funciones compartidas por los scripts de despliegue (Windows PowerShell 5.1+).
# Se carga con:  . "$PSScriptRoot\common.ps1"

$ErrorActionPreference = 'Stop'
$AppRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$EnvFile = Join-Path $AppRoot '.env'
$DefaultServiceName = 'Metricos'

function Write-Step([string]$msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok([string]$msg) { Write-Host "    OK  $msg" -ForegroundColor Green }
function Write-Warn2([string]$msg) { Write-Host "    AVISO  $msg" -ForegroundColor Yellow }

function Assert-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $p = New-Object Security.Principal.WindowsPrincipal($id)
    if (-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Ejecute PowerShell como Administrador.'
    }
}

# Ejecuta un programa externo y falla si el codigo de salida no es 0.
function Invoke-Native {
    param([string]$File, [string[]]$Arguments, [switch]$AllowFail)
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $File @Arguments | Out-Host
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prev
    }
    if (-not $AllowFail -and $code -ne 0) {
        throw "Fallo: $File $($Arguments -join ' ') (codigo $code)"
    }
    return $code
}

function Read-DotEnv([string]$Path = $EnvFile) {
    $vars = @{}
    if (-not (Test-Path $Path)) { return $vars }
    foreach ($raw in [IO.File]::ReadAllLines($Path)) {
        $line = $raw.Trim().TrimStart([char]0xFEFF)
        if ($line -eq '' -or $line.StartsWith('#')) { continue }
        $eq = $line.IndexOf('=')
        if ($eq -lt 1) { continue }
        $k = $line.Substring(0, $eq).Trim()
        $v = $line.Substring($eq + 1).Trim()
        if ($v.Length -ge 2 -and (($v.StartsWith('"') -and $v.EndsWith('"')) -or ($v.StartsWith("'") -and $v.EndsWith("'")))) {
            $v = $v.Substring(1, $v.Length - 2)
        }
        $vars[$k] = $v
    }
    return $vars
}

# Actualiza/agrega claves en .env conservando comentarios y el resto del archivo.
function Set-DotEnvValues([hashtable]$Values, [string]$Path = $EnvFile) {
    $lines = New-Object System.Collections.Generic.List[string]
    if (Test-Path $Path) { $lines.AddRange([IO.File]::ReadAllLines($Path)) }
    $pending = @{} + $Values
    for ($i = 0; $i -lt $lines.Count; $i++) {
        $t = $lines[$i].Trim()
        if ($t.StartsWith('#')) { continue }
        $eq = $t.IndexOf('=')
        if ($eq -lt 1) { continue }
        $k = $t.Substring(0, $eq).Trim()
        if ($pending.ContainsKey($k)) {
            $lines[$i] = "$k=$($pending[$k])"
            $pending.Remove($k)
        }
    }
    foreach ($k in $pending.Keys) { $lines.Add("$k=$($pending[$k])") }
    $utf8 = New-Object Text.UTF8Encoding($false)
    [IO.File]::WriteAllLines($Path, $lines.ToArray(), $utf8)
}

function Get-EnvValue([hashtable]$Vars, [string]$Name, [string]$Default) {
    if ($Vars.ContainsKey($Name) -and $Vars[$Name] -ne '') { return $Vars[$Name] }
    return $Default
}

function Resolve-AppPath([string]$p) {
    if ([IO.Path]::IsPathRooted($p)) { return $p }
    return (Join-Path $AppRoot $p)
}

# Localiza el servicio de MySQL y la carpeta bin (mysql.exe / mysqldump.exe).
function Get-MySqlInfo {
    $svc = Get-CimInstance Win32_Service | Where-Object { $_.PathName -match 'mysqld' } | Select-Object -First 1
    $bin = $null
    if ($svc) {
        $exe = $svc.PathName
        if ($exe.StartsWith('"')) { $exe = $exe.Substring(1, $exe.IndexOf('"', 1) - 1) } else { $exe = $exe.Split(' ')[0] }
        $bin = Split-Path $exe -Parent
    }
    if (-not $bin -or -not (Test-Path (Join-Path $bin 'mysqldump.exe'))) {
        $cand = Get-ChildItem 'C:\Program Files\MySQL' -Directory -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending |
            ForEach-Object { Join-Path $_.FullName 'bin' } |
            Where-Object { Test-Path (Join-Path $_ 'mysqldump.exe') } |
            Select-Object -First 1
        if ($cand) { $bin = $cand }
    }
    $name = $null
    if ($svc) { $name = $svc.Name }
    return [pscustomobject]@{ ServiceName = $name; Bin = $bin }
}

function Get-Nssm {
    $local = Join-Path $AppRoot 'tools\nssm.exe'
    if (Test-Path $local) { return $local }
    $cmd = Get-Command nssm.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $null
}

function Test-Health([int]$Port, [int]$Seconds = 60) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 "http://localhost:$Port/api/health"
            if ($r.StatusCode -eq 200) { return $r.Content }
        } catch { }
        Start-Sleep -Seconds 2
    }
    return $null
}

function Get-LanUrls([int]$Port) {
    $urls = @("http://$($env:COMPUTERNAME):$Port/")
    $ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' }
    foreach ($ip in $ips) { $urls += "http://$($ip.IPAddress):$Port/" }
    return $urls
}
