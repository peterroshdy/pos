$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show(
        "Install and start Docker Desktop, then double-click Start Talk & TASTE again.",
        "Talk & TASTE",
        "OK",
        "Information"
    ) | Out-Null
    exit 1
}

docker info *> $null
if ($LASTEXITCODE -ne 0) {
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show(
        "Docker Desktop is installed but is not running. Start it, then try again.",
        "Talk & TASTE",
        "OK",
        "Information"
    ) | Out-Null
    exit 1
}

docker compose -f compose.yml up -d --build
if ($LASTEXITCODE -ne 0) {
    throw "Talk & TASTE could not be started."
}

$ready = $false
for ($attempt = 0; $attempt -lt 60; $attempt++) {
    try {
        $health = Invoke-RestMethod -Uri "http://localhost:8080/api/health" -TimeoutSec 2
        if ($health.status -eq "ok") {
            $ready = $true
            break
        }
    } catch {
        Start-Sleep -Seconds 1
    }
}

if (-not $ready) {
    throw "Talk & TASTE started but did not become ready in time."
}

Start-Process "http://localhost:8080"
