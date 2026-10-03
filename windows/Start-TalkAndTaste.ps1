param(
    [switch]$NoBrowser,
    [switch]$AutoStart
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$composeFile = Join-Path $projectRoot "compose.yml"
$supportRoot = Join-Path $env:LOCALAPPDATA "TalkAndTaste"
$launcherLog = Join-Path $supportRoot "launcher.log"
$environmentFile = Join-Path $projectRoot ".env"
$hardwareBridgeScript = Join-Path $PSScriptRoot "TalkAndTaste-HardwareBridge.ps1"
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
    if (-not $NoBrowser -and -not $AutoStart) {
        Add-Type -AssemblyName PresentationFramework
        [System.Windows.MessageBox]::Show(
            "$Message`n`nSupport log: $launcherLog",
            "Talk & TASTE",
            "OK",
            "Error"
        ) | Out-Null
    }
}

function Find-DockerCommand {
    $command = Get-Command docker.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }

    $candidate = Join-Path $env:ProgramFiles "Docker\Docker\resources\bin\docker.exe"
    if (Test-Path $candidate) { return $candidate }
    return $null
}

function Test-DockerReady {
    param([string]$DockerCommand)
    try {
        & $DockerCommand info *> $null
        return $LASTEXITCODE -eq 0
    } catch {
        return $false
    }
}

function Start-DockerDesktop {
    $candidates = @(
        (Join-Path $env:ProgramFiles "Docker\Docker\Docker Desktop.exe"),
        (Join-Path $env:LOCALAPPDATA "Docker\Docker Desktop.exe")
    )
    $desktop = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $desktop) { return $false }
    Write-LauncherLog "Starting Docker Desktop."
    Start-Process -FilePath $desktop | Out-Null
    return $true
}

function Get-EnvironmentValue {
    param([string]$Name)
    if (-not (Test-Path $environmentFile)) { return "" }
    $match = Get-Content $environmentFile |
        Where-Object { $_ -match "^\s*$([regex]::Escape($Name))\s*=" } |
        Select-Object -Last 1
    if (-not $match) { return "" }
    return (($match -split "=", 2)[1]).Trim().Trim('"').Trim("'")
}

function Set-EnvironmentValue {
    param([string]$Name, [string]$Value)
    $lines = @()
    if (Test-Path $environmentFile) { $lines = @(Get-Content $environmentFile) }
    $updated = $false
    for ($index = 0; $index -lt $lines.Count; $index++) {
        if ($lines[$index] -match "^\s*$([regex]::Escape($Name))\s*=") {
            $lines[$index] = "$Name=$Value"
            $updated = $true
        }
    }
    if (-not $updated) { $lines += "$Name=$Value" }
    $utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllLines($environmentFile, $lines, $utf8WithoutBom)
}

function New-HardwareToken {
    $bytes = New-Object byte[] 32
    $random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $random.GetBytes($bytes) } finally { $random.Dispose() }
    return ([Convert]::ToBase64String($bytes)).TrimEnd("=").Replace("+", "-").Replace("/", "_")
}

function Initialize-HardwareBridge {
    if (-not (Test-Path $hardwareBridgeScript)) {
        throw "The Talk & TASTE hardware bridge file is missing."
    }
    $hardwareToken = Get-EnvironmentValue "CASH_DRAWER_COMMAND_TOKEN"
    if (-not $hardwareToken) {
        $hardwareToken = New-HardwareToken
        Set-EnvironmentValue "CASH_DRAWER_COMMAND_TOKEN" $hardwareToken
    }
    $hardwareUrl = Get-EnvironmentValue "CASH_DRAWER_COMMAND_URL"
    if (-not $hardwareUrl) {
        Set-EnvironmentValue "CASH_DRAWER_COMMAND_URL" "http://host.docker.internal:17891/command"
    }
    $printerName = Get-EnvironmentValue "RECEIPT_PRINTER_NAME"
    $arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$hardwareBridgeScript`" -Token `"$hardwareToken`""
    if ($printerName) { $arguments += " -PrinterName `"$printerName`"" }
    Start-Process -FilePath (Join-Path $PSHOME "powershell.exe") -ArgumentList $arguments -WindowStyle Hidden | Out-Null

    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:17891/health" -TimeoutSec 1
            if ($health.status -eq "ok") {
                Write-LauncherLog "Hardware bridge is ready with printer '$($health.printer)'."
                try {
                    (New-Object -ComObject WScript.Network).SetDefaultPrinter([string]$health.printer)
                    Write-LauncherLog "Receipt printer '$($health.printer)' is the Windows default printer."
                } catch {
                    Write-LauncherLog "WARNING: Could not set the receipt printer as Windows default: $($_.Exception.Message)"
                }
                return
            }
        } catch {
            Start-Sleep -Milliseconds 250
        }
    }
    Write-LauncherLog "WARNING: Hardware bridge started, but the XP-Q808K is not currently available."
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
        Write-LauncherLog "WARNING: Microsoft Edge was not found; silent receipt printing is unavailable."
        Start-Process "http://localhost:8080"
        return
    }
    $edgeProfile = Join-Path $supportRoot "EdgeProfile"
    $arguments = @(
        "--app=http://localhost:8080",
        "--kiosk-printing",
        "--no-first-run",
        "--disable-features=msEdgeFirstRunExperience",
        "--user-data-dir=`"$edgeProfile`""
    )
    Start-Process -FilePath $edge -ArgumentList $arguments | Out-Null
    Write-LauncherLog "POS opened in silent-printing mode."
}

function Register-TalkAndTasteStartup {
    $startupDirectory = [Environment]::GetFolderPath("Startup")
    $shortcutPath = Join-Path $startupDirectory "TalkAndTaste POS.lnk"
    $powershellPath = Join-Path $PSHOME "powershell.exe"
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $powershellPath
    $shortcut.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSCommandPath`" -AutoStart"
    $shortcut.WorkingDirectory = $projectRoot
    $shortcut.Description = "Start the Talk & TASTE offline POS after Windows login"
    $shortcut.Save()
    Write-LauncherLog "Windows startup entry is installed at $shortcutPath"
}

try {
    Write-LauncherLog "Starting Talk & TASTE POS."
    Initialize-HardwareBridge
    $dockerCommand = Find-DockerCommand
    if (-not $dockerCommand) {
        throw "Docker Desktop is not installed. Install Docker Desktop once, then run this launcher again."
    }

    if (-not (Test-DockerReady $dockerCommand)) {
        if (-not (Start-DockerDesktop)) {
            throw "Docker Desktop is installed but could not be started automatically."
        }
        $dockerReady = $false
        for ($attempt = 0; $attempt -lt 90; $attempt++) {
            Start-Sleep -Seconds 2
            if (Test-DockerReady $dockerCommand) {
                $dockerReady = $true
                break
            }
        }
        if (-not $dockerReady) {
            throw "Docker Desktop did not become ready within three minutes."
        }
    }

    $composeArguments = @("compose", "-f", $composeFile, "up", "-d")
    if (-not $AutoStart) { $composeArguments += "--build" }
    $ErrorActionPreference = "Continue"
    $composeOutput = & $dockerCommand @composeArguments 2>&1
    $composeExitCode = $LASTEXITCODE
    $ErrorActionPreference = "Stop"
    $composeOutput | ForEach-Object { Write-LauncherLog ([string]$_) }
    if ($composeExitCode -ne 0) {
        throw "The local POS container could not be started."
    }

    $ready = $false
    for ($attempt = 0; $attempt -lt 90; $attempt++) {
        try {
            $health = Invoke-RestMethod -Uri "http://localhost:8080/api/health" -TimeoutSec 2
            if ($health.status -eq "ok") {
                $ready = $true
                break
            }
        } catch {
            Start-Sleep -Seconds 2
        }
    }
    if (-not $ready) {
        throw "The POS container started but its health check did not become ready."
    }

    $bridgeProbe = "fetch('http://host.docker.internal:17891/health').then(()=>process.exit(0)).catch(()=>process.exit(1))"
    $ErrorActionPreference = "Continue"
    & $dockerCommand exec talk-and-taste-branch node -e $bridgeProbe *> $null
    $bridgeReachable = $LASTEXITCODE -eq 0
    $ErrorActionPreference = "Stop"
    if ($bridgeReachable) {
        Write-LauncherLog "The POS container can reach the Windows hardware bridge."
    } else {
        Write-LauncherLog "WARNING: The POS container cannot reach the Windows hardware bridge. Check that the XP-Q808K is installed and allow the bridge through Windows Firewall if prompted."
    }

    Register-TalkAndTasteStartup
    Write-LauncherLog "Talk & TASTE POS is healthy at http://localhost:8080."
    if (-not $NoBrowser) { Open-PosBrowser }
} catch {
    Show-LauncherError $_.Exception.Message
    exit 1
}
