/**
 * Captura local (gdigrab) → RTMP Twitch/YouTube via FFmpeg.
 * Multi-destino: vários `-f flv` (NÃO usar tee — `:` da URL RTMP quebra o muxer tee).
 */
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

let procs = [];

const QUALITY_SCALE = {
  source: { w: 1280, h: 720 },
  480: { w: 854, h: 480 },
  720: { w: 1280, h: 720 },
  1080: { w: 1920, h: 1080 },
};

function resolveFfmpeg() {
  const packaged = path.join(process.resourcesPath || "", "ffmpeg", "ffmpeg.exe");
  if (process.resourcesPath && fs.existsSync(packaged)) return packaged;
  const local = path.join(__dirname, "resources", "ffmpeg", "ffmpeg.exe");
  if (fs.existsSync(local)) return local;
  try {
    const staticBin = require("ffmpeg-static");
    if (staticBin && fs.existsSync(staticBin)) return staticBin;
  } catch {
    /* ignore */
  }
  return "";
}

function listDshowAudioDevices(ffmpegBin) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegBin, ["-list_devices", "true", "-f", "dshow", "-i", "dummy"], {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let err = "";
    p.stderr?.on("data", (c) => {
      err += String(c);
    });
    p.on("close", () => {
      const names = [];
      const re = /\"([^\"]+)\"\s+\(audio\)/gi;
      let m;
      while ((m = re.exec(err))) names.push(m[1]);
      resolve(names);
    });
    p.on("error", reject);
  });
}

function pickLoopbackDevice(devices) {
  const prefer = [/cable output/i, /vb-audio/i, /stereo mix/i, /what u hear/i, /loopback/i, /mixagem estéreo/i];
  for (const re of prefer) {
    const hit = devices.find((d) => re.test(d));
    if (hit) return hit;
  }
  return null;
}

function pickMicDevice(devices) {
  const skip = [/cable output/i, /vb-audio/i, /stereo mix/i, /loopback/i, /mixagem estéreo/i, /mapper/i];
  const mics = devices.filter((d) => !skip.some((re) => re.test(d)));
  return mics[0] || null;
}

function videoBitrateKbps(quality, fps) {
  const q = String(quality || "720");
  const f = Number(fps) || 30;
  const table = {
    source: { 15: 2500, 30: 3500, 60: 6000 },
    480: { 15: 1200, 30: 2000, 60: 3500 },
    720: { 15: 2000, 30: 2800, 60: 4500 },
    1080: { 15: 3500, 30: 4500, 60: 8000 },
  };
  const row = table[q] || table["720"];
  return row[f] || row[30] || 2800;
}

function pushVideoEncode(args, fps, quality) {
  const gop = Math.max(30, Math.min(120, (Number(fps) || 30) * 2));
  const kbps = videoBitrateKbps(quality, fps);
  const maxKbps = Math.round(kbps * 1.25);
  const bufKbps = Math.round(kbps * 2);
  args.push(
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-tune",
    "zerolatency",
    "-pix_fmt",
    "yuv420p",
    "-b:v",
    `${kbps}k`,
    "-maxrate",
    `${maxKbps}k`,
    "-bufsize",
    `${bufKbps}k`,
    "-g",
    String(gop)
  );
}

function pushAudioEncode(args) {
  args.push("-c:a", "aac", "-b:a", "160k", "-ar", "44100", "-ac", "2");
}

function resolveScale(quality) {
  const key = String(quality || "720");
  return QUALITY_SCALE[key] || QUALITY_SCALE["720"];
}

/**
 * @param {string[]} rtmpUrls
 * @param {{ audioDevices?: string[], capture?: object, quality?: string, fps?: number }} opts
 */
function buildArgs(rtmpUrls, { audioDevices = [], capture = null, quality = "720", fps = 30 } = {}) {
  const urls = (rtmpUrls || []).map((u) => String(u || "").trim()).filter(Boolean);
  const frameRate = Math.max(15, Math.min(60, Number(fps) || 30));
  const scale = resolveScale(quality);
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "gdigrab",
    "-framerate",
    String(frameRate),
    "-draw_mouse",
    "1",
  ];

  const useWindow = !!(capture?.windowTitle && String(capture.windowTitle).trim());
  const ox = Number(capture?.offsetX);
  const oy = Number(capture?.offsetY);
  const w = Number(capture?.width);
  const h = Number(capture?.height);
  const useCrop =
    !useWindow &&
    Number.isFinite(ox) &&
    Number.isFinite(oy) &&
    Number.isFinite(w) &&
    Number.isFinite(h) &&
    w >= 160 &&
    h >= 120;

  if (useCrop) {
    args.push("-offset_x", String(Math.max(0, Math.floor(ox))));
    args.push("-offset_y", String(Math.max(0, Math.floor(oy))));
    const evenW = Math.floor(w / 2) * 2;
    const evenH = Math.floor(h / 2) * 2;
    args.push("-video_size", `${evenW}x${evenH}`);
    args.push("-i", "desktop");
  } else if (useWindow) {
    args.push("-i", `title=${String(capture.windowTitle).trim()}`);
  } else {
    args.push("-i", "desktop");
  }

  const audios = (audioDevices || []).map((d) => String(d || "").trim()).filter(Boolean);
  for (const dev of audios) {
    args.push("-f", "dshow", "-i", `audio=${dev}`);
  }

  args.push(
    "-vf",
    `scale=${scale.w}:${scale.h}:force_original_aspect_ratio=decrease,pad=${scale.w}:${scale.h}:(ow-iw)/2:(oh-ih)/2`
  );

  for (const url of urls) {
    if (audios.length === 1) {
      args.push("-map", "0:v", "-map", "1:a");
      pushVideoEncode(args, frameRate, quality);
      pushAudioEncode(args);
    } else {
      args.push("-map", "0:v");
      pushVideoEncode(args, frameRate, quality);
      args.push("-an");
    }
    args.push("-f", "flv", url);
  }
  return args;
}

function stopLocalStream() {
  const running = [...procs];
  procs = [];
  for (const p of running) {
    try {
      if (!p.killed) {
        p.kill("SIGTERM");
        setTimeout(() => {
          try {
            if (!p.killed) p.kill("SIGKILL");
          } catch {
            /* ignore */
          }
        }, 1500);
      }
    } catch {
      /* ignore */
    }
  }
  return { ok: true, stopped: running.length };
}

function pickAudioDevices(devices, audioMode) {
  const mode = String(audioMode || "off");
  if (mode === "off") return [];
  const loop = pickLoopbackDevice(devices);
  return loop ? [loop] : [];
}

/**
 * @param {{ rtmpUrls?: string[], withAudio?: boolean, audioMode?: string, quality?: string, fps?: number, capture?: object }} opts
 */
async function startLocalStream(opts = {}) {
  stopLocalStream();
  const urls = (opts.rtmpUrls || []).map((u) => String(u || "").trim()).filter(Boolean);
  if (!urls.length) return { ok: false, error: "Nenhuma URL RTMP" };
  const ffmpegBin = resolveFfmpeg();
  if (!ffmpegBin) {
    return {
      ok: false,
      error: "FFmpeg não encontrado no app. Reinstale ou atualize o aplicativo.",
    };
  }

  const audioMode =
    opts.audioMode != null
      ? String(opts.audioMode)
      : opts.withAudio === false
        ? "off"
        : "game";
  const audioDevices = [];
  if (audioMode !== "off") {
    try {
      const devices = await listDshowAudioDevices(ffmpegBin);
      audioDevices.push(...pickAudioDevices(devices, audioMode));
    } catch {
      /* ignore */
    }
  }

  const capture = opts.capture && typeof opts.capture === "object" ? opts.capture : null;
  const quality = String(opts.quality || "720");
  const fps = Number(opts.fps) || 30;
  const args = buildArgs(urls, { audioDevices, capture, quality, fps });
  try {
    const p = spawn(ffmpegBin, args, {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let errBuf = "";
    p.stderr?.on("data", (chunk) => {
      errBuf += String(chunk);
      if (errBuf.length > 2000) errBuf = errBuf.slice(-1500);
    });
    p.on("exit", (code) => {
      procs = procs.filter((x) => x !== p);
      if (code && code !== 0 && code !== 255) {
        console.warn("ffmpeg exited", code, errBuf.slice(-400));
      }
    });
    p.on("error", (err) => {
      console.warn("ffmpeg error", err?.message || err);
      procs = procs.filter((x) => x !== p);
    });
    procs.push(p);
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }

  await new Promise((r) => setTimeout(r, 1500));
  const still = procs.filter((p) => p.exitCode == null && !p.killed);
  if (!still.length) {
    return {
      ok: false,
      error: "FFmpeg encerrou ao conectar no RTMP. Confira a stream key / conta vinculada.",
    };
  }

  return {
    ok: true,
    processes: still.length,
    destinations: urls.length,
    audio: audioDevices.length > 0,
    audioDevices,
    audioMode,
    quality,
    fps,
    captureLabel: capture?.label || (capture ? "monitor" : "desktop"),
    rtmpCount: urls.length,
  };
}

module.exports = {
  startLocalStream,
  stopLocalStream,
  resolveFfmpeg,
  buildArgs,
};
