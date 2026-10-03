param(
    [Parameter(Mandatory = $true)]
    [string]$Token,
    [string]$PrinterName = "",
    [int]$Port = 17891,
    [string]$BindAddress = "0.0.0.0"
)

$ErrorActionPreference = "Stop"
$supportRoot = Join-Path $env:LOCALAPPDATA "TalkAndTaste"
$bridgeLog = Join-Path $supportRoot "hardware-bridge.log"
New-Item -ItemType Directory -Force -Path $supportRoot | Out-Null

function Write-BridgeLog {
    param([string]$Message)
    $line = "{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
    Add-Content -Path $bridgeLog -Value $line -Encoding UTF8
}

function Resolve-ReceiptPrinter {
    $printers = @(Get-CimInstance Win32_Printer -ErrorAction Stop)
    if ($PrinterName) {
        $configured = $printers | Where-Object { $_.Name -eq $PrinterName } | Select-Object -First 1
        if (-not $configured) {
            throw "The configured receipt printer '$PrinterName' is not installed."
        }
        return $configured
    }

    $xprinter = $printers |
        Where-Object { $_.Name -match "Q808K|X[ -]?Printer" -or $_.DriverName -match "Q808K|X[ -]?Printer" } |
        Sort-Object @{ Expression = { if ($_.Default) { 0 } else { 1 } } }, Name |
        Select-Object -First 1
    if ($xprinter) { return $xprinter }
    throw "XP-Q808K receipt printer was not found in Windows."
}

function Send-JsonResponse {
    param(
        [System.Net.Sockets.NetworkStream]$Stream,
        [int]$StatusCode,
        [string]$StatusText,
        [object]$Body
    )
    $json = $Body | ConvertTo-Json -Compress -Depth 5
    $payload = [System.Text.Encoding]::UTF8.GetBytes($json)
    $header = "HTTP/1.1 $StatusCode $StatusText`r`nContent-Type: application/json; charset=utf-8`r`nContent-Length: $($payload.Length)`r`nConnection: close`r`nCache-Control: no-store`r`n`r`n"
    $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($header)
    $Stream.Write($headerBytes, 0, $headerBytes.Length)
    $Stream.Write($payload, 0, $payload.Length)
    $Stream.Flush()
}

Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class TalkAndTasteRawPrinter
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private class DOC_INFO_1
    {
        [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
        [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
        [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
    }

    [DllImport("winspool.drv", EntryPoint = "OpenPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool OpenPrinter(string printerName, out IntPtr printer, IntPtr defaults);

    [DllImport("winspool.drv", EntryPoint = "ClosePrinter", SetLastError = true)]
    private static extern bool ClosePrinter(IntPtr printer);

    [DllImport("winspool.drv", EntryPoint = "StartDocPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern int StartDocPrinter(IntPtr printer, int level, [In] DOC_INFO_1 docInfo);

    [DllImport("winspool.drv", EntryPoint = "EndDocPrinter", SetLastError = true)]
    private static extern bool EndDocPrinter(IntPtr printer);

    [DllImport("winspool.drv", EntryPoint = "StartPagePrinter", SetLastError = true)]
    private static extern bool StartPagePrinter(IntPtr printer);

    [DllImport("winspool.drv", EntryPoint = "EndPagePrinter", SetLastError = true)]
    private static extern bool EndPagePrinter(IntPtr printer);

    [DllImport("winspool.drv", EntryPoint = "WritePrinter", SetLastError = true)]
    private static extern bool WritePrinter(IntPtr printer, byte[] bytes, int count, out int written);

    public static void OpenCashDrawer(string printerName)
    {
        IntPtr printer;
        if (!OpenPrinter(printerName, out printer, IntPtr.Zero))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not open the Windows receipt-printer queue");

        bool documentStarted = false;
        bool pageStarted = false;
        try
        {
            DOC_INFO_1 doc = new DOC_INFO_1 {
                pDocName = "Talk & TASTE - Open cash drawer",
                pOutputFile = null,
                pDataType = "RAW"
            };
            if (StartDocPrinter(printer, 1, doc) == 0)
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not start the cash-drawer command");
            documentStarted = true;
            if (!StartPagePrinter(printer))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not start the raw printer page");
            pageStarted = true;

            // ESC p m t1 t2: pulse drawer pin 2. No text, line feed, or cut command is sent.
            byte[] pulse = new byte[] { 0x1B, 0x70, 0x00, 0x19, 0xFA };
            int written;
            if (!WritePrinter(printer, pulse, pulse.Length, out written) || written != pulse.Length)
                throw new Win32Exception(Marshal.GetLastWin32Error(), "The cash-drawer pulse was not written completely");
        }
        finally
        {
            if (pageStarted) EndPagePrinter(printer);
            if (documentStarted) EndDocPrinter(printer);
            ClosePrinter(printer);
        }
    }
}
"@

$mutex = [System.Threading.Mutex]::new($false, "Local\TalkAndTasteHardwareBridge")
$ownsMutex = $false
$listener = $null

try {
    $ownsMutex = $mutex.WaitOne(0, $false)
    if (-not $ownsMutex) { exit 0 }

    $listenerAddress = [System.Net.IPAddress]::Parse($BindAddress)
    $listener = [System.Net.Sockets.TcpListener]::new($listenerAddress, $Port)
    $listener.Start()
    Write-BridgeLog "Hardware bridge listening on $BindAddress`:$Port."

    while ($true) {
        $client = $listener.AcceptTcpClient()
        $stream = $null
        $reader = $null
        try {
            $client.ReceiveTimeout = 5000
            $client.SendTimeout = 5000
            $stream = $client.GetStream()
            $reader = [System.IO.StreamReader]::new($stream, [System.Text.Encoding]::UTF8, $false, 4096, $true)
            $requestLine = $reader.ReadLine()
            if (-not $requestLine) { continue }

            $headers = @{}
            while ($true) {
                $line = $reader.ReadLine()
                if ($null -eq $line -or $line.Length -eq 0) { break }
                $separator = $line.IndexOf(":")
                if ($separator -gt 0) {
                    $name = $line.Substring(0, $separator).Trim().ToLowerInvariant()
                    $headers[$name] = $line.Substring($separator + 1).Trim()
                }
            }

            $requestParts = $requestLine.Split(" ")
            $method = $requestParts[0]
            $path = $requestParts[1].Split("?")[0]

            if ($method -eq "GET" -and $path -eq "/health") {
                try {
                    $printer = Resolve-ReceiptPrinter
                    Send-JsonResponse $stream 200 "OK" @{
                        status = "ok"
                        printer = [string]$printer.Name
                        printerStatus = [string]$printer.PrinterStatus
                    }
                } catch {
                    Send-JsonResponse $stream 503 "Service Unavailable" @{
                        status = "printer-unavailable"
                        error = $_.Exception.Message
                    }
                }
                continue
            }

            if ($method -ne "POST" -or $path -ne "/command") {
                Send-JsonResponse $stream 404 "Not Found" @{ error = "Not found" }
                continue
            }

            if ($headers["authorization"] -ne "Bearer $Token") {
                Send-JsonResponse $stream 401 "Unauthorized" @{ error = "Invalid hardware bridge token" }
                continue
            }

            $contentLength = 0
            if ($headers.ContainsKey("content-length")) {
                $contentLength = [int]$headers["content-length"]
            }
            if ($contentLength -lt 1 -or $contentLength -gt 65536) {
                Send-JsonResponse $stream 400 "Bad Request" @{ error = "Invalid request body" }
                continue
            }

            $buffer = New-Object char[] $contentLength
            $offset = 0
            while ($offset -lt $contentLength) {
                $read = $reader.Read($buffer, $offset, $contentLength - $offset)
                if ($read -le 0) { break }
                $offset += $read
            }
            $body = (-join $buffer[0..($offset - 1)]) | ConvertFrom-Json
            if ($body.command -ne "open-drawer") {
                Send-JsonResponse $stream 400 "Bad Request" @{ error = "Unsupported hardware command" }
                continue
            }

            $printer = Resolve-ReceiptPrinter
            [TalkAndTasteRawPrinter]::OpenCashDrawer([string]$printer.Name)
            Write-BridgeLog "Cash drawer pulse sent through '$($printer.Name)' for branch '$($body.branchId)'."
            Send-JsonResponse $stream 200 "OK" @{
                ok = $true
                command = "open-drawer"
                printer = [string]$printer.Name
            }
        } catch {
            Write-BridgeLog "ERROR: $($_.Exception.Message)"
            try {
                if ($stream) {
                    Send-JsonResponse $stream 500 "Internal Server Error" @{ error = $_.Exception.Message }
                }
            } catch {}
        } finally {
            if ($reader) { $reader.Dispose() }
            if ($stream) { $stream.Dispose() }
            $client.Close()
        }
    }
} catch {
    Write-BridgeLog "FATAL: $($_.Exception.Message)"
    exit 1
} finally {
    if ($listener) { $listener.Stop() }
    if ($ownsMutex) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
