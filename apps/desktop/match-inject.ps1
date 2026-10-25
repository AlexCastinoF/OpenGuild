# SteamFarm — cola exec sf_pm_connect na consola do CS2 CLIENTE (nunca dedicated).
# Args: [0]=consoleVk (0=auto), [1]=texto opcional extra
param(
  [int]$ConsoleVk = 0,
  [string]$ExtraCmd = ""
)

$ErrorActionPreference = "Continue"
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class SfPmInj {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr e);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  public struct RECT { public int L,T,R,B; }
  public const uint KEYUP = 0x0002;
  public const uint MDOWN = 0x0002;
  public const uint MUP = 0x0004;
  public static void TapVk(byte vk) {
    keybd_event(vk, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(45);
    keybd_event(vk, 0, KEYUP, UIntPtr.Zero);
  }
  public static void Chord(byte mod, byte vk) {
    keybd_event(mod, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(30);
    TapVk(vk);
    keybd_event(mod, 0, KEYUP, UIntPtr.Zero);
  }
  public static void ClickCenter(IntPtr h) {
    RECT r;
    if (!GetWindowRect(h, out r)) return;
    SetCursorPos((r.L + r.R) / 2, (r.T + r.B) / 2);
    System.Threading.Thread.Sleep(40);
    mouse_event(MDOWN, 0, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(30);
    mouse_event(MUP, 0, 0, 0, UIntPtr.Zero);
  }
}
"@

function Find-Cs2ClientWindow {
  $clients = @(Get-CimInstance Win32_Process -Filter "Name='cs2.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and ($_.CommandLine -notmatch '(?i)-dedicated') })
  if ($clients.Count -eq 0) { return [IntPtr]::Zero }

  foreach ($c in $clients) {
    $proc = Get-Process -Id $c.ProcessId -ErrorAction SilentlyContinue
    if ($proc -and $proc.MainWindowHandle -ne [IntPtr]::Zero -and $proc.MainWindowHandle -ne 0) {
      return [IntPtr]$proc.MainWindowHandle
    }
  }
  return [IntPtr]::Zero
}

function Do-Paste([IntPtr]$w, [byte]$cvk, [string]$text) {
  if ([string]::IsNullOrWhiteSpace($text)) { return }
  [void][SfPmInj]::SetForegroundWindow($w)
  Start-Sleep -Milliseconds 150
  [SfPmInj]::TapVk($cvk)
  Start-Sleep -Milliseconds 320
  [System.Windows.Forms.Clipboard]::SetText($text)
  Start-Sleep -Milliseconds 70
  [SfPmInj]::Chord(0x11, 0x41)
  Start-Sleep -Milliseconds 40
  [SfPmInj]::Chord(0x11, 0x56)
  Start-Sleep -Milliseconds 90
  [SfPmInj]::TapVk(0x0D)
  Start-Sleep -Milliseconds 450
  [SfPmInj]::TapVk($cvk)
  Start-Sleep -Milliseconds 120
}

$w = Find-Cs2ClientWindow
if ($w -eq [IntPtr]::Zero) {
  Write-Output "no_client_window"
  exit 2
}

$pidOut = 0
$fore = [SfPmInj]::GetWindowThreadProcessId($w, [ref]$pidOut)
$cur = [SfPmInj]::GetCurrentThreadId()
[void][SfPmInj]::AttachThreadInput($cur, $fore, $true)
[void][SfPmInj]::ShowWindow($w, 9)
[void][SfPmInj]::BringWindowToTop($w)
[void][SfPmInj]::SetForegroundWindow($w)
Start-Sleep -Milliseconds 250
[SfPmInj]::ClickCenter($w)
Start-Sleep -Milliseconds 200

$vkList = New-Object System.Collections.Generic.List[byte]
if ($ConsoleVk -gt 0) { [void]$vkList.Add([byte]$ConsoleVk) }
foreach ($v in 0xDE, 0xC0, 0xDC, 0x78, 0x2D, 0xBA) {
  if (-not $vkList.Contains([byte]$v)) { [void]$vkList.Add([byte]$v) }
}

$primary = "exec sf_pm_connect"
foreach ($cvk in $vkList) {
  Do-Paste $w ([byte]$cvk) $primary
}

if (-not [string]::IsNullOrWhiteSpace($ExtraCmd)) {
  Do-Paste $w ([byte]$vkList[0]) $ExtraCmd.Trim()
}

[void][SfPmInj]::AttachThreadInput($cur, $fore, $false)
Write-Output "ok client_pid=$pidOut"
exit 0
