$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$environmentFile = Join-Path $projectRoot ".env"
$supportRoot = Join-Path $env:LOCALAPPDATA "TalkAndTaste"
$watchdogLog = Join-Path $supportRoot "native-watchdog.log"
$apiOutputLog = Join-Path $supportRoot "native-api-output.log"
$apiErrorLog = Join-Path $supportRoot "native-api-error.log"
$apiPidFile = Join-Path $supportRoot "native-api.pid"
New-Item -ItemType Directory -Force -Path $supportRoot | Out-Null
Set-Location $projectRoot

function Write-WatchdogLog {
    param([string]$Message)
    $line = "{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
    Add-Content -Path $watchdogLog -Value $line -Encoding UTF8
}

function Import-LocalEnvironment {
    if (-not (Test-Path $environmentFile)) { throw "The local environment file is missing." }
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

$mutex = New-Object System.Threading.Mutex($false, "Local\TalkAndTasteNativeWatchdog")
$ownsMutex = $false
try {
    $ownsMutex = $mutex.WaitOne(0, $false)
    if (-not $ownsMutex) { exit 0 }
    Import-LocalEnvironment
    $nodeCommand = Find-NodeCommand
    if (-not $nodeCommand) { throw "Node.js 24 is not installed." }
    $serverFile = Join-Path $projectRoot "apps\api\dist\server.js"
    if (-not (Test-Path $serverFile)) { throw "The production API build is missing." }

    Write-WatchdogLog "Native API watchdog started."
    while ($true) {
        try {
            if (Test-Path $apiOutputLog) {
                Move-Item $apiOutputLog "$apiOutputLog.previous" -Force
            }
            if (Test-Path $apiErrorLog) {
                Move-Item $apiErrorLog "$apiErrorLog.previous" -Force
            }
            $processArguments = @{
                FilePath = $nodeCommand
                ArgumentList = @("apps/api/dist/server.js")
                WorkingDirectory = $projectRoot
                WindowStyle = "Hidden"
                RedirectStandardOutput = $apiOutputLog
                RedirectStandardError = $apiErrorLog
                PassThru = $true
            }
            $apiProcess = Start-Process @processArguments
            Set-Content -Path $apiPidFile -Value $apiProcess.Id -Encoding ASCII
            Write-WatchdogLog "Native API started with process ID $($apiProcess.Id)."
            $apiProcess.WaitForExit()
            Write-WatchdogLog "Native API exited with code $($apiProcess.ExitCode); restarting in five seconds."
        } catch {
            Write-WatchdogLog "API start failure: $($_.Exception.Message); retrying in five seconds."
        } finally {
            Remove-Item $apiPidFile -Force -ErrorAction SilentlyContinue
        }
        Start-Sleep -Seconds 5
    }
} catch {
    Write-WatchdogLog "FATAL: $($_.Exception.Message)"
    exit 1
} finally {
    if ($ownsMutex) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
