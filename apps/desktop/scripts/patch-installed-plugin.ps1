# Atualiza o plugin CS2 (1.3.3) dentro do SteamFarm Comunidade instalado.
# Clique direito → Executar como administrador.
$ErrorActionPreference = 'Stop'
$srcDll = 'H:\cs2teste\SteamFarmReact\apps\desktop\resources\cs2-plugin\SfAssignTeams.dll'
$srcMods = 'H:\cs2teste\SteamFarmReact\apps\desktop\match-server-mods.js'
$asar = 'C:\Program Files\SteamFarmComunidade\resources\app.asar'
if (-not (Test-Path $srcDll)) { throw "DLL em falta: $srcDll" }
if (-not (Test-Path $asar)) { throw "app.asar em falta: $asar" }

# Fecha o Desktop se estiver aberto (senão o asar fica locked)
Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq 'SteamFarm Comunidade.exe' -or ($_.CommandLine -match 'SteamFarmComunidade')
} | ForEach-Object {
  Write-Host "A fechar PID $($_.ProcessId)..."
  Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 2

$tmp = Join-Path $env:TEMP "sf-asar-fix-$(Get-Random)"
New-Item -ItemType Directory -Path $tmp | Out-Null
Write-Host "A extrair asar..."
npx --yes asar extract $asar (Join-Path $tmp 'app')
Copy-Item -Force $srcDll (Join-Path $tmp 'app\resources\cs2-plugin\SfAssignTeams.dll')
Copy-Item -Force $srcMods (Join-Path $tmp 'app\match-server-mods.js')

$bak = Join-Path $env:TEMP ("app.asar.bak-" + (Get-Date -Format yyyyMMddHHmmss))
Copy-Item -Force $asar $bak
Write-Host "Backup: $bak"
Write-Host "A reempacotar asar..."
npx --yes asar pack (Join-Path $tmp 'app') $asar

$ov = Join-Path $env:APPDATA '@steamfarm\desktop\cs2-overlay\game\csgo\addons\counterstrikesharp\plugins\SfAssignTeams'
New-Item -ItemType Directory -Force -Path $ov | Out-Null
Copy-Item -Force $srcDll (Join-Path $ov 'SfAssignTeams.dll')
$ovr = Join-Path $env:APPDATA '@steamfarm\desktop\cs2-plugin-override'
New-Item -ItemType Directory -Force -Path $ovr | Out-Null
Copy-Item -Force $srcDll (Join-Path $ovr 'SfAssignTeams.dll')

Write-Host ""
Write-Host "OK. DLL instalado:" (Get-Item (Join-Path $ov 'SfAssignTeams.dll')).Length "bytes"
Write-Host "Abre o SteamFarm Comunidade e sobe a partida outra vez."
Write-Host "No log deve aparecer: [SfAssignTeams] loaded v1.3.3"
Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
pause
