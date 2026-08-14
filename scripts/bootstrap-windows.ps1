param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectDir
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# Corporate networks route downloads through an authenticated proxy. Browsers
# authenticate with the logged-in user's session; make PowerShell downloads use the
# same system proxy with those default credentials, otherwise Invoke-RestMethod /
# Invoke-WebRequest fail with "407 Proxy Authentication Required".
try {
  $defaultProxy = [System.Net.WebRequest]::GetSystemWebProxy()
  $defaultProxy.Credentials = [System.Net.CredentialCache]::DefaultCredentials
  [System.Net.WebRequest]::DefaultWebProxy = $defaultProxy
} catch {
  # Ignore: no proxy in use makes this a no-op.
}

$runtimeRoot = Join-Path $ProjectDir ".arbor-runtime"
$nodeRoot = Join-Path $runtimeRoot "node"
$nodeExecutable = Join-Path $nodeRoot "node.exe"

if (Test-Path $nodeExecutable) {
  Write-Host "The runtime environment already exists."
  exit 0
}

$architecture = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "win-arm64" } else { "win-x64" }
$fileTag = "$architecture-zip"
$downloadPath = Join-Path $runtimeRoot "node.zip"
$extractRoot = Join-Path $runtimeRoot "extract"

try {
  New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
  if (Test-Path $extractRoot) {
    Remove-Item -Recurse -Force $extractRoot
  }
  if (Test-Path $nodeRoot) {
    Remove-Item -Recurse -Force $nodeRoot
  }

  Write-Host "Downloading the portable runtime environment - no administrator privileges required..."
  $releases = Invoke-RestMethod -Uri "https://nodejs.org/dist/index.json"
  $release = $releases |
    Where-Object {
      $_.lts -and
      [int]($_.version.Substring(1).Split(".")[0]) -ge 22 -and
      $_.files -contains $fileTag
    } |
    Select-Object -First 1

  if ($null -eq $release) {
    throw "No Node.js LTS version suitable for the current Windows system was found."
  }

  $archiveName = "node-$($release.version)-$architecture.zip"
  $downloadUrl = "https://nodejs.org/dist/$($release.version)/$archiveName"
  Invoke-WebRequest -UseBasicParsing -Uri $downloadUrl -OutFile $downloadPath

  New-Item -ItemType Directory -Force -Path $extractRoot | Out-Null
  Expand-Archive -Path $downloadPath -DestinationPath $extractRoot -Force
  $expandedFolder = Get-ChildItem -Path $extractRoot -Directory | Select-Object -First 1
  if ($null -eq $expandedFolder) {
    throw "The downloaded runtime could not be extracted."
  }

  Move-Item -Path $expandedFolder.FullName -Destination $nodeRoot
  Remove-Item -Force $downloadPath
  Remove-Item -Recurse -Force $extractRoot

  if (-not (Test-Path $nodeExecutable)) {
    throw "The runtime environment is incomplete."
  }

  Write-Host "Portable runtime environment ready."
  exit 0
}
catch {
  Write-Host ""
  Write-Host "Unable to prepare the runtime environment automatically: $($_.Exception.Message)" -ForegroundColor Red
  if (Test-Path $downloadPath) {
    Remove-Item -Force $downloadPath -ErrorAction SilentlyContinue
  }
  if (Test-Path $extractRoot) {
    Remove-Item -Recurse -Force $extractRoot -ErrorAction SilentlyContinue
  }
  exit 1
}
