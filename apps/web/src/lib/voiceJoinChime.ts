/** Chime sintético ao entrar na voz (igual Flask — sem arquivo de áudio). */

let sfxCtx: AudioContext | null = null;

async function unlockSfxContext(): Promise<AudioContext | null> {
  try {
    const AC =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    if (!sfxCtx) sfxCtx = new AC();
    if (sfxCtx.state === 'suspended') await sfxCtx.resume();
    return sfxCtx;
  } catch {
    return null;
  }
}

function tone(
  ctx: AudioContext,
  freq: number,
  start: number,
  dur: number,
  gainVal: number,
  type: OscillatorType = 'sine',
) {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(gainVal, start + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  osc.connect(g);
  g.connect(ctx.destination);
  osc.start(start);
  osc.stop(start + dur + 0.02);
}

/** Efeito mágico ao entrar na voz — toca para quem já está e para quem entra. */
export async function playVoiceJoinChime() {
  const ctx = await unlockSfxContext();
  if (!ctx) return;
  const t0 = ctx.currentTime + 0.01;
  const notes = [523.25, 659.25, 783.99, 1046.5, 1318.5];
  notes.forEach((f, i) => {
    const start = t0 + i * 0.07;
    tone(ctx, f, start, 0.38, 0.045, 'sine');
    tone(ctx, f * 2, start + 0.01, 0.22, 0.018, 'triangle');
  });
  tone(ctx, 1568, t0 + 0.42, 0.55, 0.028, 'sine');
  tone(ctx, 2093, t0 + 0.48, 0.4, 0.012, 'triangle');
}
