# pipaya Windows client installer.
#
#   irm https://raw.githubusercontent.com/pipaya/main/install.ps1 | iex
#
# Downloads the latest Windows x64 installer, verifies it against SHA256SUMS.txt and starts it.
# The installer is not Authenticode-signed, so SmartScreen may show a warning.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$base = if ($env:HARNESS_RELEASE_URL) { $env:HARNESS_RELEASE_URL } else { 'https://github.com/dohwi/pipaya/releases/download/latest' }
$name = 'harness-windows-x64-setup.exe'
$dir = Join-Path ([IO.Path]::GetTempPath()) ('pipaya-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $dir | Out-Null

try {
    Invoke-WebRequest -UseBasicParsing "$base/SHA256SUMS.txt" -OutFile (Join-Path $dir 'SHA256SUMS.txt')
    Invoke-WebRequest -UseBasicParsing "$base/$name" -OutFile (Join-Path $dir $name)

    $line = Get-Content (Join-Path $dir 'SHA256SUMS.txt') | Where-Object { ($_ -split '\s+')[-1].TrimStart('*') -eq $name } | Select-Object -First 1
    if (-not $line) { throw "No checksum for $name in SHA256SUMS.txt" }
    $expected = ($line -split '\s+')[0].ToLowerInvariant()
    $actual = (Get-FileHash -Algorithm SHA256 (Join-Path $dir $name)).Hash.ToLowerInvariant()
    if ($expected -ne $actual) { throw "Checksum mismatch for $name (expected $expected, got $actual)" }

    Write-Host "Verified $name. Starting the installer..."
    Start-Process -FilePath (Join-Path $dir $name) -Wait
    Write-Host 'Done. Open pipaya, then enter your server URL and token.'
}
finally {
    Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue
}
