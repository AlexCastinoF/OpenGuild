# Sobe o gateway Zapo (Baileys) para o hub WhatsApp da Comunidade.
# Sessões Baileys ficam em steamfarm_prod_ref; metadados de slot no steamfarm_react (API Nest).

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$WhatsAppDir = Join-Path $Root "whatsapp"
$LegacyWhatsAppDir = "H:\cs2teste\archi-steam-farm-py\whatsapp"
if (-not (Test-Path $WhatsAppDir) -and (Test-Path $LegacyWhatsAppDir)) {
  $WhatsAppDir = $LegacyWhatsAppDir
}
$EnvFile = Join-Path $Root ".env"

function Read-DotEnvValue([string]$path, [string]$key) {
  if (-not (Test-Path $path)) { return $null }
  foreach ($line in Get-Content $path) {
    if ($line -match "^\s*#" -or $line -notmatch "=") { continue }
    $parts = $line -split "=", 2
    if ($parts[0].Trim() -eq $key) {
      return $parts[1].Trim().Trim('"').Trim("'")
    }
  }
  return $null
}

$Port = Read-DotEnvValue $EnvFile "ZAPO_PORT"
if (-not $Port) { $Port = "8788" }

$Secret = Read-DotEnvValue $EnvFile "ZAPO_GATEWAY_SECRET"
if (-not $Secret) { $Secret = "dev-zapo-secret" }

$DbUrl = Read-DotEnvValue $EnvFile "ZAPO_DATABASE_URL"
if (-not $DbUrl) {
  $DbUrl = "postgresql://postgres@127.0.0.1:5432/steamfarm_prod_ref"
}

if (-not (Test-Path $WhatsAppDir)) {
  Write-Error "Pasta do gateway não encontrada: $WhatsAppDir"
}

$NodeModules = Join-Path $WhatsAppDir "node_modules\zapo-js"
if (-not (Test-Path $NodeModules)) {
  Write-Host "Instalando dependências do gateway…"
  Push-Location $WhatsAppDir
  try { npm install } finally { Pop-Location }
}

$env:ZAPO_PORT = "$Port"
$env:ZAPO_GATEWAY_SECRET = $Secret
$env:ZAPO_DATABASE_URL = $DbUrl
# gateway.mjs também aceita DATABASE_URL
$env:DATABASE_URL = $DbUrl

Write-Host "Zapo gateway → http://127.0.0.1:$Port"
Write-Host "DB: $DbUrl"
Set-Location $WhatsAppDir
node gateway.mjs
