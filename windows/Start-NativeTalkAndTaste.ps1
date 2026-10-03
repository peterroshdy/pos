param(
    [switch]$NoBrowser,
    [switch]$AutoStart
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$environmentFile = Join-Path $projectRoot ".env"
$supportRoot = Join-Path $env:LOCALAPPDATA "TalkAndTaste"
$launcherLog = Join-Path $supportRoot "native-launcher.log"
$apiOutputLog = Join-Path $supportRoot "native-api-output.log"
$apiErrorLog = Join-Path $supportRoot "native-api-error.log"
$hardwareBridgeScript = Join-Path $PSScriptRoot "TalkAndTaste-HardwareBridge.ps1"
$watchdogScript = Join-Path $PSScriptRoot "Watch-NativeTalkAndTaste.ps1"
New-Item -ItemType Directory -Force -Path $supportRoot | Out-Null
Set-Location $projectRoot

function Write-LauncherLog {
    param([string]$Message)
    $line = "{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
    Add-Content -Path $launcherLog -Value $line -Encoding UTF8
    if (-not $NoBrowser -and -not $AutoStart) { Write-Host $line }
}

function Show-LauncherError {
    param([string]$Message)
    Write-LauncherLog "ERROR: $Message"
    if (-not $AutoStart) {
        Add-Type -AssemblyName PresentationFramework
        [System.Windows.MessageBox]::Show(
            "$Message`n`nSupport log: $launcherLog",
            "Talk & TASTE",
            "OK",
            "Error"
        ) | Out-Null
    }
}

function Import-LocalEnvironment {
    if (-not (Test-Path $environmentFile)) {
        throw "The native POS is not installed yet. Double-click 'Install Talk & TASTE Native.cmd' first."
    }
    foreach ($line in Get-Content $environmentFile) {
        $trimmed = $line.Trim()
        if (-not $trimmed -or $trimmed.StartsWith("#") -or -not $trimmed.Contains("=")) { continue }
        $parts = $trimmed.Split("=", 2)
        [Environment]::SetEnvironmentVariable($parts[0].Trim(), $parts[1].Trim().Trim('"').Trim("'"), "Process")
    }
}

function Find-NodeCommand {
    $command = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $candidate = Join-Path $env:ProgramFiles "nodejs\node.exe"
    if (Test-Path $candidate) { return $candidate }
    return $null
}

function Start-HardwareBridge {
    if (-not (Test-Path $hardwareBridgeScript)) {
        throw "The Talk & TASTE hardware bridge file is missing."
    }
    if (-not $env:CASH_DRAWER_COMMAND_TOKEN) {
        throw "The hardware bridge token is missing from the local configuration."
    }
    $pidFile = Join-Path $supportRoot "hardware-bridge.pid"
    if (Test-Path $pidFile) {
        $existingPid = Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($existingPid) {
            $existingProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$existingPid" -ErrorAction SilentlyContinue
            if ($existingProcess -and $existingProcess.CommandLine -match "TalkAndTaste-HardwareBridge\.ps1") {
                return
            }
        }
    }
    $arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$hardwareBridgeScript`" -Token `"$env:CASH_DRAWER_COMMAND_TOKEN`" -BindAddress 127.0.0.1"
    if ($env:RECEIPT_PRINTER_NAME) {
        $arguments += " -PrinterName `"$env:RECEIPT_PRINTER_NAME`""
    }
    $bridgeProcess = Start-Process -FilePath (Join-Path $PSHOME "powershell.exe") -ArgumentList $arguments -WindowStyle Hidden -PassThru
    Set-Content -Path $pidFile -Value $bridgeProcess.Id -Encoding ASCII
}

function Start-NativeWatchdog {
    if (-not (Test-Path $watchdogScript)) {
        throw "The native API watchdog file is missing."
    }
    $pidFile = Join-Path $supportRoot "native-watchdog.pid"
    if (Test-Path $pidFile) {
        $existingPid = Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($existingPid) {
            $existingProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$existingPid" -ErrorAction SilentlyContinue
            if ($existingProcess -and $existingProcess.CommandLine -match "Watch-NativeTalkAndTaste\.ps1") {
                return
            }
        }
    }
    $arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$watchdogScript`""
    $watchdogProcess = Start-Process -FilePath (Join-Path $PSHOME "powershell.exe") -ArgumentList $arguments -WindowStyle Hidden -PassThru
    Set-Content -Path $pidFile -Value $watchdogProcess.Id -Encoding ASCII
    Write-LauncherLog "Native API watchdog started with process ID $($watchdogProcess.Id)."
}

function Find-EdgeCommand {
    $candidates = @(
        (Join-Path ${env:ProgramFiles(x86)} "Microsoft\Edge\Application\msedge.exe"),
        (Join-Path $env:ProgramFiles "Microsoft\Edge\Application\msedge.exe"),
        (Join-Path $env:LOCALAPPDATA "Microsoft\Edge\Application\msedge.exe")
    )
    return $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
}

function Open-PosBrowser {
    $edge = Find-EdgeCommand
    if (-not $edge) {
        Write-LauncherLog "WARNING: Microsoft Edge was not found; opening the default browser without silent printing."
        Start-Process "http://127.0.0.1:8080"
        return
    }
    $edgeProfile = Join-Path $supportRoot "EdgeProfile"
    $arguments = @(
        "--app=http://127.0.0.1:8080",
        "--kiosk-printing",
        "--no-first-run",
        "--disable-features=msEdgeFirstRunExperience",
        "--user-data-dir=$edgeProfile"
    )
    Start-Process -FilePath $edge -ArgumentList $arguments | Out-Null
    Write-LauncherLog "POS opened in Microsoft Edge app mode."
}

function Register-NativeStartup {
    $startupDirectory = [Environment]::GetFolderPath("Startup")
    $shortcutPath = Join-Path $startupDirectory "TalkAndTaste POS.lnk"
    $powershellPath = Join-Path $PSHOME "powershell.exe"
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $powershellPath
    $shortcut.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSCommandPath`" -AutoStart"
    $shortcut.WorkingDirectory = $projectRoot
    $shortcut.Description = "Start the native Talk & TASTE POS after Windows login"
    $shortcut.Save()
}

function Test-PosHealth {
    try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:8080/api/health" -TimeoutSec 2
        return $health.status -eq "ok"
    } catch {
        return $false
    }
}

function Backup-LocalDatabase {
    if (-not $env:DATABASE_PATH -or -not (Test-Path $env:DATABASE_PATH)) { return }
    $backupRoot = Join-Path $supportRoot "backups"
    New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
    $todayPrefix = Get-Date -Format "yyyyMMdd"
    if (Get-ChildItem $backupRoot -Directory -Filter "$todayPrefix-*" -ErrorAction SilentlyContinue) { return }
    $backupDirectory = Join-Path $backupRoot (Get-Date -Format "yyyyMMdd-HHmmss")
    New-Item -ItemType Directory -Force -Path $backupDirectory | Out-Null
    foreach ($source in @($env:DATABASE_PATH, "$($env:DATABASE_PATH)-wal", "$($env:DATABASE_PATH)-shm")) {
        if (Test-Path $source) { Copy-Item $source $backupDirectory -Force }
    }
    Get-ChildItem $backupRoot -Directory |
        Sort-Object Name -Descending |
        Select-Object -Skip 14 |
        Remove-Item -Recurse -Force
    Write-LauncherLog "Created local database backup at $backupDirectory."
}

try {
    Write-LauncherLog "Starting native Talk & TASTE POS."
    Import-LocalEnvironment
    $nodeCommand = Find-NodeCommand
    if (-not $nodeCommand) {
        throw "Node.js 24 is not installed. Run the native installer again."
    }
    if (-not (Test-Path (Join-Path $projectRoot "apps\api\dist\server.js"))) {
        throw "The application build is missing. Run the native installer again."
    }

    Start-HardwareBridge
    if (-not (Test-PosHealth)) {
        Backup-LocalDatabase
        Start-NativeWatchdog
    } else {
        Start-NativeWatchdog
    }

    $ready = $false
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        if (Test-PosHealth) {
            $ready = $true
            break
        }
        Start-Sleep -Seconds 1
    }
    if (-not $ready) {
        throw "The native POS did not become healthy. Create a support bundle and send it to support."
    }

    Register-NativeStartup
    Write-LauncherLog "Native POS is healthy at http://127.0.0.1:8080."
    if (-not $NoBrowser) { Open-PosBrowser }
} catch {
    Show-LauncherError $_.Exception.Message
    exit 1
}
