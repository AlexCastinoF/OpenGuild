# Script de Deploy e Atualizacao de Atalhos do RallyDesk
param(
    [string]$SourceExe = "apps\desktop\src-tauri\target\release\RallyDesk.exe"
)

$ErrorActionPreference = "Continue"

Write-Host "==> Verificando executavel de origem: $SourceExe"
if (-not (Test-Path $SourceExe)) {
    Write-Error "Arquivo de origem nao encontrado: $SourceExe"
    exit 1
}

$fileInfo = Get-Item $SourceExe
Write-Host "Tamanho: $([math]::Round($fileInfo.Length / 1MB, 2)) MB | Criado em: $($fileInfo.LastWriteTime)"
Write-Host "Product: $($fileInfo.VersionInfo.ProductName) | Description: $($fileInfo.VersionInfo.FileDescription)"

# Destinos
$destDir1 = "C:\Users\Vini\AppData\Local\RallyDesk"
$destDir2 = "C:\Users\Vini\AppData\Local\SteamFarm Comunidade"
$destDir3 = "C:\Users\Vini\AppData\Local\Programs\SteamFarm Comunidade"

New-Item -ItemType Directory -Force -Path $destDir1 | Out-Null
New-Item -ItemType Directory -Force -Path $destDir2 | Out-Null
New-Item -ItemType Directory -Force -Path $destDir3 | Out-Null

# Fechar instancias antigas se houver
Stop-Process -Name "app", "RallyDesk", "SteamFarm*" -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500

# 1. Copiar para AppData\Local\RallyDesk\RallyDesk.exe
$targetRallyDesk = Join-Path $destDir1 "RallyDesk.exe"
Copy-Item -Path $SourceExe -Destination $targetRallyDesk -Force
Write-Host "[OK] Copiado para: $targetRallyDesk"

# 2. Copiar para retrocompatibilidade
Copy-Item -Path $SourceExe -Destination (Join-Path $destDir2 "app.exe") -Force
Copy-Item -Path $SourceExe -Destination (Join-Path $destDir2 "RallyDesk.exe") -Force
Copy-Item -Path $SourceExe -Destination (Join-Path $destDir3 "SteamFarm Comunidade.exe") -Force
Copy-Item -Path $SourceExe -Destination (Join-Path $destDir3 "RallyDesk.exe") -Force
Write-Host "[OK] Copias de retrocompatibilidade realizadas com sucesso"

# 3. Atualizar atalhos no Desktop e Start Menu
$iconPath = (Resolve-Path "apps\desktop\src-tauri\icons\icon.ico").Path
$wsh = New-Object -ComObject WScript.Shell

$desktopShortcutPath = [System.IO.Path]::Combine([System.Environment]::GetFolderPath("Desktop"), "RallyDesk.lnk")
$sc = $wsh.CreateShortcut($desktopShortcutPath)
$sc.TargetPath = $targetRallyDesk
$sc.WorkingDirectory = $destDir1
$sc.IconLocation = "$targetRallyDesk,0"
$sc.Description = "RallyDesk - Voice & Chat Comunidade"
$sc.Save()
Write-Host "[OK] Atalho no Desktop atualizado: $desktopShortcutPath"

# Remover atalhos antigos com nomes legados se existirem
$legacyDesktopLnk = [System.IO.Path]::Combine([System.Environment]::GetFolderPath("Desktop"), "SteamFarm Comunidade.lnk")
if (Test-Path $legacyDesktopLnk) {
    Remove-Item $legacyDesktopLnk -Force -ErrorAction SilentlyContinue
    Write-Host "[OK] Atalho legado removido: $legacyDesktopLnk"
}

# 4. Notificar o Shell do Windows para atualizar o cache de icones
$code = @'
using System;
using System.Runtime.InteropServices;
public class ShellNotifier {
    [DllImport("shell32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    public static extern void SHChangeNotify(int wEventId, uint uFlags, IntPtr dwItem1, IntPtr dwItem2);
}
'@
Add-Type -TypeDefinition $code -ErrorAction SilentlyContinue
[ShellNotifier]::SHChangeNotify(0x08000000, 0x0000, [IntPtr]::Zero, [IntPtr]::Zero) # SHCNE_ASSOCCHANGED
Write-Host "[OK] Notificacao de mudanca de shell enviada (SHChangeNotify)"
Write-Host "==> Deploy concluido com sucesso!"
