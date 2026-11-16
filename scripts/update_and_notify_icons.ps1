$W = New-Object -ComObject WScript.Shell
$ico = "C:\Users\Vini\AppData\Roaming\@steamfarm\desktop\brand\bundled-fallback.ico"

$shortcuts = @(
    "C:\Users\Vini\Desktop\RallyDesk.lnk",
    "C:\Users\Vini\Desktop\SteamFarm Comunidade.lnk",
    "C:\Users\Vini\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\RallyDesk.lnk",
    "C:\Users\Vini\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\SteamFarm Comunidade.lnk"
)

foreach ($scPath in $shortcuts) {
    if (Test-Path $scPath) {
        $sc = $W.CreateShortcut($scPath)
        $sc.IconLocation = "$ico,0"
        $sc.Description = "RallyDesk"
        $sc.Save()
        Write-Host "Updated shortcut: $scPath with icon $ico"
    }
}

$csharp = @"
using System;
using System.Runtime.InteropServices;
public class WinShellNotify {
    [DllImport("shell32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    public static extern void SHChangeNotify(uint wEventId, uint uFlags, IntPtr dwItem1, IntPtr dwItem2);
}
"@

Add-Type -TypeDefinition $csharp
[WinShellNotify]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)
Write-Host "Windows Shell notified of icon changes!"
