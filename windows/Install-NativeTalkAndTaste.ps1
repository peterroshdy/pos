param([switch]$NoBrowser)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$projectRoot = Split-Path -Parent $PSScriptRoot
$environmentFile = Join-Path $projectRoot ".env"
$supportRoot = Join-Path $env:LOCALAPPDATA "TalkAndTaste"
$dataDirectory = Join-Path $supportRoot "data"
$installLog = Join-Path $supportRoot "native-install.log"
$nativeStartScript = Join-Path $PSScriptRoot "Start-NativeTalkAndTaste.ps1"
New-Item -ItemType Directory -Force -Path $supportRoot, $dataDirectory | Out-Null
Set-Location $projectRoot

function Write-InstallLog {
    param([string]$Message)
    $line = "{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
    Add-Content -Path $installLog -Value $line -Encoding UTF8
    Write-Host $line
}

function Show-InstallMessage {
    param([string]$Message, [string]$Icon = "Information")
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show($Message, "Talk & TASTE Native Installer", "OK", $Icon) | Out-Null
}

function Refresh-Path {
    $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = "$machinePath;$userPath"
}

function Find-NodeCommand {
    $command = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $candidate = Join-Path $env:ProgramFiles "nodejs\node.exe"
    if (Test-Path $candidate) { return $candidate }
    return $null
}

function Install-Node24 {
    Write-InstallLog "Downloading the current Node.js 24 x64 installer."
    $checksumsUrl = "https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt"
    $checksums = (Invoke-WebRequest -UseBasicParsing -Uri $checksumsUrl).Content -split "`n"
    $entry = $checksums | Where-Object { $_ -match "\s(node-v24[^\s]+-x64\.msi)\s*$" } | Select-Object -First 1
    if (-not $entry) { throw "Could not identify the Node.js 24 Windows installer." }
    $parts = $entry.Trim() -split "\s+"
    $expectedHash = $parts[0].ToUpperInvariant()
    $fileName = $parts[-1]
    $download = Join-Path $env:TEMP $fileName
    Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/latest-v24.x/$fileName" -OutFile $download
    $actualHash = (Get-FileHash -Algorithm SHA256 -Path $download).Hash.ToUpperInvariant()
    if ($actualHash -ne $expectedHash) {
        throw "The downloaded Node.js installer failed its SHA-256 verification."
    }
    Write-InstallLog "Node.js installer verified. Approve the Windows administrator prompt if shown."
    $installer = Start-Process msiexec.exe -ArgumentList "/i `"$download`" /passive /norestart" -Wait -PassThru
    if ($installer.ExitCode -notin @(0, 3010)) {
        throw "Node.js installation failed with exit code $($installer.ExitCode)."
    }
    Refresh-Path
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

function New-SecureToken {
    $bytes = New-Object byte[] 32
    $random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $random.GetBytes($bytes) } finally { $random.Dispose() }
    return ([Convert]::ToBase64String($bytes)).TrimEnd("=").Replace("+", "-").Replace("/", "_")
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

function Register-DesktopShortcut {
    $desktop = [Environment]::GetFolderPath("Desktop")
    $shortcutPath = Join-Path $desktop "Talk & TASTE POS.lnk"
    $powershellPath = Join-Path $PSHOME "powershell.exe"
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $powershellPath
    $shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$nativeStartScript`""
    $shortcut.WorkingDirectory = $projectRoot
    $shortcut.Description = "Open the native Talk & TASTE POS"
    $shortcut.Save()
}

function Stop-NativeProcessesForUpdate {
    $managedProcesses = @{
        "native-api.pid" = "apps[/\\]api[/\\]dist[/\\]server\.js"
        "hardware-bridge.pid" = "TalkAndTaste-HardwareBridge\.ps1"
    }
    foreach ($pidName in $managedProcesses.Keys) {
        $pidFile = Join-Path $supportRoot $pidName
        if (-not (Test-Path $pidFile)) { continue }
        $processId = Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($processId) {
            $processDetails = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction SilentlyContinue
            if ($processDetails -and $processDetails.CommandLine -match $managedProcesses[$pidName]) {
                $process = Get-Process -Id ([int]$processId) -ErrorAction SilentlyContinue
                if ($process) {
                    Write-InstallLog "Stopping the previous native process $processId for the update."
                    Stop-Process -Id $process.Id -Force
                    $process.WaitForExit()
                }
            }
        }
        Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    }
}

try {
    $os = Get-CimInstance Win32_OperatingSystem
    $version = [Version]$os.Version
    if ($version.Major -lt 10) {
        throw "This native build requires 64-bit Windows 10 or Windows 11."
    }
    if (-not [Environment]::Is64BitOperatingSystem) {
        throw "This native build requires 64-bit Windows."
    }
    $memoryBytes = (Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory
    if ($memoryBytes -lt 3.5GB) {
        throw "At least 4 GB of system RAM is required."
    }

    Refresh-Path
    $nodeCommand = Find-NodeCommand
    $nodeVersion = $null
    if ($nodeCommand) {
        try { $nodeVersion = [Version](& $nodeCommand -p "process.versions.node") } catch {}
    }
    if (-not $nodeVersion -or $nodeVersion.Major -lt 24) {
        Install-Node24
        $nodeCommand = Find-NodeCommand
    }
    if (-not $nodeCommand) { throw "Node.js 24 could not be found after installation." }
    Write-InstallLog "Using Node.js $(& $nodeCommand -p 'process.versions.node')."

    Stop-NativeProcessesForUpdate
    $npmCommand = Join-Path (Split-Path -Parent $nodeCommand) "npm.cmd"
    if (-not (Test-Path $npmCommand)) { throw "npm was not installed with Node.js." }
    Write-InstallLog "Installing application packages. This can take several minutes on a 4 GB machine."
    & $npmCommand ci
    if ($LASTEXITCODE -ne 0) { throw "npm package installation failed." }
    Write-InstallLog "Building the production application."
    & $npmCommand run build
    if ($LASTEXITCODE -ne 0) { throw "The production build failed." }
    & $npmCommand prune --omit=dev
    if ($LASTEXITCODE -ne 0) { throw "Production package cleanup failed." }

    $databasePath = (Join-Path $dataDirectory "token-taste.db").Replace("\", "/")
    Set-EnvironmentValue "NODE_ENV" "production"
    Set-EnvironmentValue "HOST" "127.0.0.1"
    Set-EnvironmentValue "PORT" "8080"
    Set-EnvironmentValue "DATABASE_PATH" $databasePath
    Set-EnvironmentValue "BUSINESS_TIMEZONE" "Africa/Cairo"
    Set-EnvironmentValue "CLOUD_ENROLLMENT_URL" "https://admin.talkandtaste.app"
    Set-EnvironmentValue "CASH_DRAWER_COMMAND_URL" "http://127.0.0.1:17891/command"
    if (-not (Get-EnvironmentValue "CASH_DRAWER_COMMAND_TOKEN")) {
        Set-EnvironmentValue "CASH_DRAWER_COMMAND_TOKEN" (New-SecureToken)
    }

    Register-DesktopShortcut
    Write-InstallLog "Installation complete. Starting the local POS."
    & $nativeStartScript -NoBrowser:$NoBrowser
    if ($LASTEXITCODE -ne 0) { throw "The POS was installed but did not start successfully." }
    Show-InstallMessage "Talk & TASTE is installed.`n`nA desktop shortcut was created and the POS will start automatically after Windows login.`n`nOn first launch, create the local admin and Barista passwords."
} catch {
    Write-InstallLog "ERROR: $($_.Exception.Message)"
    Show-InstallMessage "$($_.Exception.Message)`n`nInstallation log: $installLog" "Error"
    exit 1
}
