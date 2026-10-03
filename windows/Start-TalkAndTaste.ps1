param(
    [switch]$NoBrowser,
    [switch]$AutoStart
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$composeFile = Join-Path $projectRoot "compose.yml"
$supportRoot = Join-Path $env:LOCALAPPDATA "TalkAndTaste"
$launcherLog = Join-Path $supportRoot "launcher.log"
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

    Register-TalkAndTasteStartup
    Write-LauncherLog "Talk & TASTE POS is healthy at http://localhost:8080."
    if (-not $NoBrowser) { Start-Process "http://localhost:8080" }
} catch {
    Show-LauncherError $_.Exception.Message
    exit 1
}
