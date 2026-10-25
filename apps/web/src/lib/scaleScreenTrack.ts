/** Downscale a display-capture track to a fixed WxH (Electron ignores many getDisplayMedia constraints). */

export type ScaledScreenTrack = {
  track: MediaStreamTrack;
  stop: () => void;
};

export async function scaleScreenTrack(
  source: MediaStreamTrack,
  width: number,
  height: number,
  fps: number,
): Promise<ScaledScreenTrack> {
  const video = document.createElement('video');
  video.playsInline = true;
  video.muted = true;
  video.autoplay = true;
  video.srcObject = new MediaStream([source]);
  await video.play().catch(() => undefined);
  await new Promise<void>((resolve) => {
    if (video.videoWidth > 0) {
      resolve();
      return;
    }
    const done = () => resolve();
    video.addEventListener('loadedmetadata', done, { once: true });
    window.setTimeout(done, 800);
  });

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(2, Math.round(width));
  canvas.height = Math.max(2, Math.round(height));
  const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
  if (!ctx) {
    return {
      track: source,
      stop: () => {
        try {
          source.stop();
        } catch {
          /* ignore */
        }
      },
    };
  }

  let raf = 0;
  let stopped = false;
  let lastDraw = 0;
  const minDelta = 1000 / Math.max(1, Math.min(60, fps || 30));

  const draw = (t: number) => {
    if (stopped) return;
    raf = requestAnimationFrame(draw);
    if (t - lastDraw < minDelta) return;
    lastDraw = t;
    const vw = video.videoWidth || canvas.width;
    const vh = video.videoHeight || canvas.height;
    if (vw < 2 || vh < 2) return;
    const scale = Math.min(canvas.width / vw, canvas.height / vh);
    const dw = vw * scale;
    const dh = vh * scale;
    const dx = (canvas.width - dw) / 2;
    const dy = (canvas.height - dh) / 2;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(video, dx, dy, dw, dh);
  };
  raf = requestAnimationFrame(draw);

  const outStream = canvas.captureStream(Math.max(1, Math.min(60, fps || 30)));
  const out = outStream.getVideoTracks()[0];
  if (!out) {
    stopped = true;
    cancelAnimationFrame(raf);
    video.srcObject = null;
    throw new Error('Falha ao criar track reescalada');
  }
  try {
    out.contentHint = 'detail';
  } catch {
    /* ignore */
  }

  return {
    track: out,
    stop: () => {
      if (stopped) return;
      stopped = true;
      cancelAnimationFrame(raf);
      try {
        out.stop();
      } catch {
        /* ignore */
      }
      try {
        source.stop();
      } catch {
        /* ignore */
      }
      video.srcObject = null;
    },
  };
}
