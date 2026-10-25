const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");
const { app } = require("electron");

/** @type {import("application-loopback") | null} */
let exeLoopback = null;
/** @type {import("loopback-capture").default.LoopbackCapture | null} */
let nativeCapture = null;
/** @type {"native" | "exe" | null} */
let activeBackend = null;
/** @type {string | null} */
let activeProcessId = null;
/** @type {import("electron").WebContents | null} */
let activeWebContents = null;

const PCM_SAMPLE_RATE = 48000;
const PCM_CHANNELS = 2;
const PCM_BYTES_PER_SAMPLE = 2;

const GAME_EXE_HINTS = [
  ["counter-strike", "cs2", "csgo"],
  ["valorant", "valorant-win64-shipping"],
  ["minecraft", "javaw", "minecraft"],
  ["fortnite", "fortniteclient-win64-shipping"],
  ["league of legends", "league of legends", "leagueclient"],
  ["dota 2", "dota2"],
  ["overwatch", "overwatch"],
  ["apex", "r5apex"],
  ["pubg", "tslgame"],
  ["gta", "gta5", "gtav"],
  ["elden ring", "eldenring"],
];

const LOW_PRIORITY_EXE = new Set([
  "steam",
  "steamservice",
  "steamwebhelper",
  "gameoverlayui",
  "gameoverlayui64",
  "discord",
  "electron",
  "steamfarm comunidade",
  "rallydesk",
  "rally desk",
]);

function resolveLoopbackBinRoot() {
  const candidates = [];
  if (app?.isPackaged && process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, "application-loopback", "bin"));
  }
  // monorepo: apps/desktop → ../../node_modules/...
  candidates.push(path.join(__dirname, "..", "..", "node_modules", "application-loopback", "bin"));
  candidates.push(path.join(__dirname, "node_modules", "application-loopback", "bin"));
  try {
    const pkgRoot = path.dirname(require.resolve("application-loopback/package.json"));
    candidates.push(path.join(pkgRoot, "bin"));
  } catch {
    /* ignore */
  }
  for (const root of candidates) {
    const exe = path.join(root, "win32-x64", "ProcessList.exe");
    if (fs.existsSync(exe)) return root;
  }
  return null;
}

function loadExeLoopback() {
  if (exeLoopback) return exeLoopback;
  const binRoot = resolveLoopbackBinRoot();
  if (!binRoot) {
    throw new Error("application-loopback binaries missing (ProcessList.exe)");
  }
  exeLoopback = require("application-loopback");
  exeLoopback.setExecutablesRoot(binRoot);
  return exeLoopback;
}

function tryLoadExeLoopback() {
  try {
    return loadExeLoopback();
  } catch (err) {
    console.warn("application-loopback indisponível:", err?.message || err);
    return null;
  }
}

function loadNativeLoopback() {
  try {
    const mod = require("loopback-capture");
    const LoopbackCapture = mod?.LoopbackCapture || mod?.default?.LoopbackCapture;
    if (!LoopbackCapture) return null;
    return LoopbackCapture;
  } catch (err) {
    console.warn("loopback-capture indisponível:", err?.message || err);
    return null;
  }
}

function hwndFromSourceId(sourceId) {
  const m = String(sourceId || "").match(/^window:(\d+)/);
  return m ? m[1] : null;
}

function runPowerShell(script, timeoutMs = 8000) {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          resolve("");
          return;
        }
        resolve(String(stdout || ""));
      }
    );
  });
}

async function pidFromHwndFast(hwnd) {
  const id = String(hwnd || "").trim();
  if (!/^\d+$/.test(id)) return null;
  const out = await runPowerShell(
    `(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle.ToInt64() -eq ${id} } | Select-Object -First 1 -ExpandProperty Id)`,
    3500
  );
  const pid = parseInt(String(out).trim(), 10);
  if (Number.isFinite(pid) && pid > 0) return String(pid);
  try {
    const al = tryLoadExeLoopback();
    const windows = (await al?.getActiveWindowProcessIds?.()) || [];
    const hit = windows.find((w) => String(w.hwnd) === id);
    if (hit?.processId) return String(hit.processId);
  } catch {
    /* ignore */
  }
  return null;
}

async function pidFromHwndWin32(hwnd) {
  const out = await runPowerShell(
    `$code = @'
using System;
using System.Runtime.InteropServices;
public class SfWin32 {
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
}
'@
Add-Type -TypeDefinition $code
$p = [uint32]0
[void][SfWin32]::GetWindowThreadProcessId([IntPtr]${hwnd}, [ref]$p)
Write-Output $p`
  );
  const pid = parseInt(String(out).trim(), 10);
  return Number.isFinite(pid) && pid > 0 ? String(pid) : null;
}

async function processNameForPid(pid) {
  const out = await runPowerShell(
    `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty ProcessName)`
  );
  return String(out || "").trim().toLowerCase();
}

async function childProcessIds(pid) {
  const out = await runPowerShell(
    `Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | Select-Object -ExpandProperty ProcessId`
  );
  return String(out || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => /^\d+$/.test(s));
}

async function parentProcessId(pid) {
  const out = await runPowerShell(
    `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object -ExpandProperty ParentProcessId)`
  );
  const p = parseInt(String(out).trim(), 10);
  return Number.isFinite(p) && p > 0 ? String(p) : null;
}

async function collectProcessTree(rootPid, maxDepth = 4) {
  const seen = new Set();
  const out = [];
  const walk = async (pid, depth) => {
    const p = String(pid || "").trim();
    if (!p || seen.has(p) || depth > maxDepth) return;
    seen.add(p);
    out.push(p);
    const kids = await childProcessIds(p);
    for (const kid of kids) {
      await walk(kid, depth + 1);
    }
  };
  await walk(rootPid, 0);
  let parent = await parentProcessId(rootPid);
  let guard = 0;
  while (parent && guard < 3) {
    await walk(parent, 0);
    parent = await parentProcessId(parent);
    guard += 1;
  }
  return out;
}

async function pidsByExePatterns(patterns) {
  if (!patterns.length) return [];
  const ps = `
$patterns = @(${patterns.map((p) => `'${String(p).replace(/'/g, "''")}'`).join(",")})
Get-Process -ErrorAction SilentlyContinue | ForEach-Object {
  $n = $_.ProcessName.ToLower()
  foreach ($p in $patterns) {
    if ($n -like ($p.ToLower())) { $_.Id; break }
  }
}`;
  const out = await runPowerShell(ps);
  return String(out || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => /^\d+$/.test(s));
}

async function pidsByWindowTitle(title) {
  const safe = String(title || "").replace(/'/g, "''").slice(0, 120);
  if (!safe) return [];
  const out = await runPowerShell(
    `Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -and ($_.MainWindowTitle -eq '${safe}' -or $_.MainWindowTitle -like '*${safe}*') } | Select-Object -ExpandProperty Id`
  );
  return String(out || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => /^\d+$/.test(s));
}

function exeHintsForTitle(title) {
  const t = String(title || "").toLowerCase();
  const hints = [];
  for (const [needle, ...exes] of GAME_EXE_HINTS) {
    if (t.includes(needle)) hints.push(...exes);
  }
  if (/\bcs\s*2\b|counter-strike/i.test(title || "")) {
    hints.push("cs2", "csgo");
  }
  return [...new Set(hints)];
}

async function rankCandidate(pid) {
  const name = await processNameForPid(pid);
  let score = 50;
  if (!name) score += 20;
  const low = new Set(LOW_PRIORITY_EXE);
  try {
    const self = String(app?.getName?.() || "")
      .toLowerCase()
      .trim();
    if (self) {
      low.add(self);
      low.add(self.replace(/\s+/g, ""));
      low.add(self.replace(/\s+/g, "-"));
    }
  } catch {
    /* ignore */
  }
  if (low.has(name)) score += 100;
  if (name === "cs2" || name === "csgo") score -= 40;
  if (name.includes("shipping") || name.includes("win64")) score -= 10;
  return score;
}

/**
 * @param {{ id?: string, name?: string } | null} source
 */
async function resolveProcessCandidates(source) {
  const seen = new Set();
  const out = [];
  const push = (pid) => {
    const p = String(pid || "").trim();
    if (p && !seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  };

  const hwnd = hwndFromSourceId(source?.id);
  const title = String(source?.name || "").trim();
  const titleLower = title.toLowerCase();

  let rootPid = null;
  if (hwnd) {
    rootPid = await pidFromHwndWin32(hwnd);
    if (rootPid) push(rootPid);
  }

  let windows = [];
  try {
    const al = tryLoadExeLoopback();
    if (al?.getActiveWindowProcessIds) {
      windows = await al.getActiveWindowProcessIds();
    }
  } catch (err) {
    console.warn("getActiveWindowProcessIds failed:", err?.message || err);
  }

  if (hwnd) {
    const byHwnd = windows.find((w) => String(w.hwnd) === String(hwnd));
    if (byHwnd?.processId) {
      rootPid = rootPid || byHwnd.processId;
      push(byHwnd.processId);
    }
  }
  if (titleLower) {
    for (const w of windows) {
      const wt = String(w.title || "").trim().toLowerCase();
      if (!wt) continue;
      if (wt === titleLower || wt.includes(titleLower) || titleLower.includes(wt)) {
        push(w.processId);
      }
    }
    for (const pid of await pidsByWindowTitle(title)) {
      push(pid);
    }
  }

  const treeRoots = rootPid ? [rootPid, ...out] : [...out];
  for (const pid of treeRoots) {
    for (const treePid of await collectProcessTree(pid, 4)) {
      push(treePid);
    }
  }

  const exeHints = exeHintsForTitle(title);
  for (const pid of await pidsByExePatterns(exeHints)) {
    push(pid);
  }

  const ranked = await Promise.all(
    out.map(async (pid) => ({ pid, score: await rankCandidate(pid) }))
  );
  ranked.sort((a, b) => a.score - b.score);
  return ranked.map((r) => r.pid);
}

/**
 * @param {{ id?: string, name?: string } | null} source
 */
async function resolveProcessIdForSource(source) {
  const candidates = await resolveProcessCandidates(source);
  if (!candidates.length) {
    if (!source?.id || !String(source.id).startsWith("window:")) {
      return {
        ok: false,
        reason: "not_window",
        message: "Selecione uma janela (não a tela inteira) para capturar o áudio do jogo.",
      };
    }
    return {
      ok: false,
      reason: "pid_not_found",
      message: "Janela não encontrada para captura de áudio. Tente compartilhar novamente.",
    };
  }
  const hwnd = hwndFromSourceId(source?.id);
  const hwndPid = hwnd ? await pidFromHwndWin32(hwnd) : null;
  const primaryPid = hwndPid && candidates.includes(hwndPid) ? hwndPid : candidates[0];
  return {
    ok: true,
    processId: primaryPid,
    candidates,
    title: String(source?.name || ""),
  };
}

function sendPcmChunk(webContents, chunk) {
  if (!chunk?.length || !webContents || webContents.isDestroyed()) return;
  try {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    webContents.send("sf:game-audio-chunk", buf);
  } catch {
    /* ignore */
  }
}

function captureFormat() {
  return {
    sampleRate: PCM_SAMPLE_RATE,
    channels: PCM_CHANNELS,
    bitsPerSample: PCM_BYTES_PER_SAMPLE * 8,
    encoding: "pcm-s16le",
  };
}

function stopGameAudioCapture() {
  const had = !!activeProcessId || !!nativeCapture;
  const pid = activeProcessId;
  activeProcessId = null;
  activeWebContents = null;

  if (activeBackend === "native" && nativeCapture) {
    try {
      nativeCapture.stop();
    } catch {
      /* ignore */
    }
    nativeCapture = null;
  } else if (activeBackend === "exe" && pid) {
    try {
      const al = tryLoadExeLoopback();
      al?.stopAudioCapture?.(pid);
    } catch {
      /* ignore */
    }
  }

  activeBackend = null;
  return { ok: true, stopped: had, processId: pid || undefined };
}

function startNativeCapture(webContents, processId, meta) {
  const LoopbackCapture = loadNativeLoopback();
  if (!LoopbackCapture) return null;

  stopGameAudioCapture();
  const capture = new LoopbackCapture();
  const pidNum = parseInt(String(processId), 10);
  if (!Number.isFinite(pidNum) || pidNum <= 0) {
    return { ok: false, reason: "bad_pid", message: "PID inválido para captura de áudio." };
  }

  // Marca ativo ANTES do callback — chunks síncronos no start não eram descartados
  activeBackend = "native";
  activeProcessId = String(processId);
  activeWebContents = webContents;
  nativeCapture = capture;

  try {
    capture.start(pidNum, true, (chunk) => {
      if (activeProcessId === String(processId)) {
        sendPcmChunk(activeWebContents, chunk);
      }
    });
  } catch (err) {
    try {
      capture.stop();
    } catch {
      /* ignore */
    }
    nativeCapture = null;
    activeBackend = null;
    activeProcessId = null;
    activeWebContents = null;
    return { ok: false, reason: "start_failed", message: err?.message || String(err) };
  }

  return {
    ok: true,
    backend: "native",
    processId: String(processId),
    title: meta?.title || "",
    includeProcessTree: true,
    format: captureFormat(),
  };
}

function startExeCapture(webContents, processId) {
  let al;
  try {
    al = loadExeLoopback();
  } catch (err) {
    return { ok: false, reason: "exe_missing", message: err?.message || String(err) };
  }
  stopGameAudioCapture();

  activeBackend = "exe";
  activeProcessId = String(processId);
  activeWebContents = webContents;

  try {
    al.startAudioCapture(String(processId), {
      onData: (chunk) => {
        if (activeProcessId === String(processId)) {
          sendPcmChunk(activeWebContents, chunk);
        }
      },
      onError: (err) => {
        console.warn("application-loopback capture error:", err?.message || err);
      },
    });
  } catch (err) {
    activeBackend = null;
    activeProcessId = null;
    activeWebContents = null;
    return { ok: false, reason: "start_failed", message: err?.message || String(err) };
  }

  return {
    ok: true,
    backend: "exe",
    processId: String(processId),
    format: captureFormat(),
  };
}

/**
 * @param {import("electron").WebContents} webContents
 * @param {{ id?: string, name?: string } | null} source
 */
async function startGameAudioCapture(webContents, source) {
  if (process.platform !== "win32") {
    return { ok: false, reason: "platform", message: "Captura por janela só está disponível no Windows." };
  }

  const t0 = Date.now();
  const hwnd = hwndFromSourceId(source?.id);
  const fastPid = hwnd ? await pidFromHwndFast(hwnd) : null;
  if (fastPid) {
    const native = startNativeCapture(webContents, fastPid, {
      title: source?.name || "",
      fast: true,
    });
    if (native?.ok) {
      console.log("[SF-VOICE] wasapi:fast-pid", { pid: fastPid, hwnd, ms: Date.now() - t0 });
      return { ...native, fast: true };
    }
  }

  const resolved = await resolveProcessIdForSource(source);
  console.log("[SF-VOICE] wasapi:slow-pid", {
    ok: resolved.ok,
    pid: resolved.processId,
    ms: Date.now() - t0,
    reason: resolved.reason,
  });
  if (!resolved.ok) return resolved;

  const primary = resolved.processId;
  const candidates = resolved.candidates || [primary];

  const native = startNativeCapture(webContents, primary, resolved);
  if (native?.ok) return native;

  let lastError = native || { ok: false, reason: "native_unavailable" };
  for (const pid of candidates) {
    if (pid === primary) continue;
    stopGameAudioCapture();
    const tried = startExeCapture(webContents, pid);
    if (tried.ok) {
      return { ...tried, title: resolved.title, fallback: true };
    }
    lastError = tried;
  }

  if (!lastError?.ok) {
    stopGameAudioCapture();
    const triedPrimaryExe = startExeCapture(webContents, primary);
    if (triedPrimaryExe.ok) {
      return { ...triedPrimaryExe, title: resolved.title, fallback: true };
    }
    lastError = triedPrimaryExe;
  }

  stopGameAudioCapture();
  return {
    ok: false,
    reason: lastError?.reason || "no_audio",
    message:
      lastError?.message ||
      "Não foi possível capturar o áudio desta janela. Use modo janela no jogo (não tela cheia exclusiva) e confira se o som está ativo.",
    debug: {
      primary,
      candidates: candidates.slice(0, 8),
      native: lastError?.reason,
    },
  };
}

function startSystemAudioCapture(webContents) {
  if (process.platform !== "win32") {
    return {
      ok: false,
      reason: "platform",
      message: "Captura de áudio do sistema só está disponível no Windows.",
    };
  }
  const LoopbackCapture = loadNativeLoopback();
  if (!LoopbackCapture) {
    return {
      ok: false,
      reason: "native_unavailable",
      message: "loopback-capture indisponível para áudio do sistema.",
    };
  }

  stopGameAudioCapture();
  const capture = new LoopbackCapture();
  const selfPid = process.pid;

  // Discord/GoofCord: EXCLUDE da nossa árvore — som do PC sem a call do Electron (evita loop).
  try {
    activeBackend = "native";
    activeProcessId = "system-exclude";
    activeWebContents = webContents;
    nativeCapture = capture;
    capture.start(selfPid, false, (chunk) => {
      if (activeProcessId === "system-exclude") {
        sendPcmChunk(activeWebContents, chunk);
      }
    });
    return {
      ok: true,
      backend: "native-exclude-self",
      processId: String(selfPid),
      format: captureFormat(),
    };
  } catch (excludeErr) {
    console.warn("WASAPI exclude-self failed, fallback system loopback:", excludeErr?.message || excludeErr);
    try {
      capture.stop();
    } catch {
      /* ignore */
    }
    nativeCapture = null;
  }

  const fallback = new LoopbackCapture();
  activeBackend = "native";
  activeProcessId = "system";
  activeWebContents = webContents;
  nativeCapture = fallback;

  try {
    if (typeof fallback.startSystemAudio !== "function") {
      throw new Error("startSystemAudio não suportado neste build de loopback-capture");
    }
    fallback.startSystemAudio((chunk) => {
      if (activeProcessId === "system") {
        sendPcmChunk(activeWebContents, chunk);
      }
    });
  } catch (err) {
    try {
      fallback.stop();
    } catch {
      /* ignore */
    }
    nativeCapture = null;
    activeBackend = null;
    activeProcessId = null;
    activeWebContents = null;
    return { ok: false, reason: "start_failed", message: err?.message || String(err) };
  }

  return {
    ok: true,
    backend: "native-system",
    processId: "system",
    format: captureFormat(),
  };
}

module.exports = {
  startGameAudioCapture,
  startSystemAudioCapture,
  stopGameAudioCapture,
  resolveProcessIdForSource,
  PCM_SAMPLE_RATE,
  PCM_CHANNELS,
};
