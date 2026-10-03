$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$composeFile = Join-Path $projectRoot "compose.yml"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$desktop = [Environment]::GetFolderPath("Desktop")
$bundleDirectory = Join-Path $desktop "TalkAndTaste-Support-$stamp"
$bundleZip = "$bundleDirectory.zip"
$launcherLog = Join-Path $env:LOCALAPPDATA "TalkAndTaste\launcher.log"
$hardwareLog = Join-Path $env:LOCALAPPDATA "TalkAndTaste\hardware-bridge.log"
New-Item -ItemType Directory -Force -Path $bundleDirectory | Out-Null

function Save-Diagnostic {
    param(
        [string]$Name,
        [scriptblock]$Command
    )
    try {
        (& $Command 2>&1 | Out-String) | Set-Content -Path (Join-Path $bundleDirectory "$Name.txt") -Encoding UTF8
    } catch {
        $_ | Out-String | Set-Content -Path (Join-Path $bundleDirectory "$Name.txt") -Encoding UTF8
    }
}

Save-Diagnostic "00-summary" {
    "Created: $(Get-Date -Format o)"
    "Computer: $env:COMPUTERNAME"
    "User: $env:USERNAME"
    "Project: $projectRoot"
    "This bundle contains diagnostics only. It does not contain the POS database or passwords."
}
Save-Diagnostic "01-windows" {
    Get-CimInstance Win32_OperatingSystem |
        Select-Object Caption, Version, OSArchitecture, LastBootUpTime, LocalDateTime |
        Format-List
}
Save-Diagnostic "02-disk" {
    Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" |
        Select-Object DeviceID, VolumeName, Size, FreeSpace |
        Format-Table -AutoSize
}

$docker = Get-Command docker.exe -ErrorAction SilentlyContinue
if ($docker) {
    Save-Diagnostic "03-docker-version" { & $docker.Source version }
    Save-Diagnostic "04-compose-status" { & $docker.Source compose -f $composeFile ps }
    Save-Diagnostic "05-container-status" {
        & $docker.Source ps -a --filter "name=talk-and-taste-branch" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
    }
    Save-Diagnostic "06-container-logs" {
        & $docker.Source logs --timestamps --tail 1000 talk-and-taste-branch
    }
    Save-Diagnostic "07-volume-status" {
        & $docker.Source volume ls --filter "name=token_taste_data"
    }
} else {
    "docker.exe was not found in PATH." | Set-Content -Path (Join-Path $bundleDirectory "03-docker-version.txt")
}

Save-Diagnostic "08-local-health" {
    Invoke-RestMethod -Uri "http://localhost:8080/api/health" -TimeoutSec 5 |
        ConvertTo-Json -Depth 5
}
Save-Diagnostic "09-cloud-reachability" {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "https://admin.talkandtaste.app/api/setup/status" -TimeoutSec 10
    "HTTP status: $($response.StatusCode)"
}

Save-Diagnostic "10-printers" {
    Get-CimInstance Win32_Printer |
        Select-Object Name, DriverName, PortName, Default, PrinterStatus, WorkOffline |
        Format-Table -AutoSize
}
Save-Diagnostic "11-hardware-bridge" {
    try {
        Invoke-RestMethod -Uri "http://127.0.0.1:17891/health" -TimeoutSec 5 |
            ConvertTo-Json -Depth 5
    } catch {
        "Hardware bridge unavailable: $($_.Exception.Message)"
    }
}

if (Test-Path $launcherLog) {
    Copy-Item $launcherLog (Join-Path $bundleDirectory "12-launcher.log")
}
if (Test-Path $hardwareLog) {
    Copy-Item $hardwareLog (Join-Path $bundleDirectory "13-hardware-bridge.log")
}

Compress-Archive -Path "$bundleDirectory\*" -DestinationPath $bundleZip -Force
Add-Type -AssemblyName PresentationFramework
[System.Windows.MessageBox]::Show(
    "Support bundle created:`n$bundleZip`n`nSend this ZIP to support. It does not contain the POS database or passwords.",
    "Talk & TASTE Support",
    "OK",
    "Information"
) | Out-Null
