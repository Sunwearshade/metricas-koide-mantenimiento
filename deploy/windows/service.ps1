<#
.SYNOPSIS
  Operacion del servicio: start | stop | restart | status | uninstall

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File deploy\windows\service.ps1 status
#>
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet('start', 'stop', 'restart', 'status', 'uninstall')]
    [string]$Action,
    [string]$ServiceName = 'Metricos'
)

. "$PSScriptRoot\common.ps1"

$cfg = Read-DotEnv
$port = [int](Get-EnvValue $cfg 'PORT' '4173')
$svc = Get-Service $ServiceName -ErrorAction SilentlyContinue
if (-not $svc) { throw "El servicio $ServiceName no esta instalado. Ejecute install.ps1" }

switch ($Action) {
    'start' {
        Assert-Admin
        Start-Service $ServiceName
        if (Test-Health -Port $port) { Write-Ok "En linea: http://$($env:COMPUTERNAME):$port/" } else { Write-Warn2 'No responde; revise logs\servicio-error.log' }
    }
    'stop' {
        Assert-Admin
        Stop-Service $ServiceName -Force
        Write-Ok 'Servicio detenido'
    }
    'restart' {
        Assert-Admin
        Restart-Service $ServiceName -Force
        if (Test-Health -Port $port) { Write-Ok "En linea: http://$($env:COMPUTERNAME):$port/" } else { Write-Warn2 'No responde; revise logs\servicio-error.log' }
    }
    'status' {
        Write-Host "Servicio : $($svc.Name) - $($svc.Status) (inicio $($svc.StartType))"
        $h = Test-Health -Port $port -Seconds 3
        if ($h) { Write-Host "Salud    : $h" } else { Write-Host 'Salud    : sin respuesta' }
        Write-Host 'URLs     :'
        foreach ($u in (Get-LanUrls $port)) { Write-Host "   $u" }
        $task = Get-ScheduledTask -TaskName 'Metricos - Respaldo diario' -ErrorAction SilentlyContinue
        if ($task) {
            $info = $task | Get-ScheduledTaskInfo
            Write-Host "Respaldo : ultimo $($info.LastRunTime) (resultado $($info.LastTaskResult)), proximo $($info.NextRunTime)"
        }
    }
    'uninstall' {
        Assert-Admin
        $nssm = Get-Nssm
        if ($svc.Status -ne 'Stopped') { Stop-Service $ServiceName -Force }
        if ($nssm) { Invoke-Native $nssm @('remove', $ServiceName, 'confirm') } else { Invoke-Native sc.exe @('delete', $ServiceName) }
        Get-NetFirewallRule -DisplayName 'Metricos de Mantenimiento (TCP *' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
        Unregister-ScheduledTask -TaskName 'Metricos - Respaldo diario' -Confirm:$false -ErrorAction SilentlyContinue
        Write-Ok 'Servicio, regla de Firewall y tarea de respaldo eliminados. La base de datos, data\ y backups\ NO se borraron.'
    }
}
