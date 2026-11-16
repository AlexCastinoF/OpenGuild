/** Efeitos sonoros sintetizados para voz (mute/unmute, entrada/saída de canal) via Web Audio API. */

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
  try {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    const attack = Math.min(0.015, dur * 0.25);
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(gainVal, start + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start(start);
    osc.stop(start + dur + 0.02);
  } catch {
    /* ignore audio node lifecycle errors */
  }
}

let lastJoinChimeTime = 0;

/** Efeito sonoro suave ao entrar na chamada ou quando alguém entra na call (volume moderado/baixo). */
export async function playVoiceJoinChime() {
  const now = Date.now();
  if (now - lastJoinChimeTime < 350) return;
  lastJoinChimeTime = now;

  const ctx = await unlockSfxContext();
  if (!ctx) return;
  const t0 = ctx.currentTime + 0.01;

  // Tríade maior suave ascendente (C5 -> E5 -> G5) em onda senoidal pura e ganho baixo (não estridente)
  tone(ctx, 523.25, t0, 0.14, 0.026, 'sine');
  tone(ctx, 659.25, t0 + 0.065, 0.16, 0.028, 'sine');
  tone(ctx, 783.99, t0 + 0.13, 0.22, 0.025, 'sine');
}

let lastMuteTime = 0;

/** Efeito sonoro suave ao mutar o microfone (dois tons descendentes discretos e baixos). */
export async function playMicMuteSound() {
  const now = Date.now();
  if (now - lastMuteTime < 150) return;
  lastMuteTime = now;

  const ctx = await unlockSfxContext();
  if (!ctx) return;
  const t0 = ctx.currentTime + 0.005;

  // Tom descendente discreto (430Hz -> 310Hz), volume baixo e suave
  tone(ctx, 430.0, t0, 0.07, 0.024, 'sine');
  tone(ctx, 310.0, t0 + 0.065, 0.09, 0.020, 'sine');
}

/** Efeito sonoro suave ao desmutar o microfone (dois tons ascendentes discretos e baixos). */
export async function playMicUnmuteSound() {
  const now = Date.now();
  if (now - lastMuteTime < 150) return;
  lastMuteTime = now;

  const ctx = await unlockSfxContext();
  if (!ctx) return;
  const t0 = ctx.currentTime + 0.005;

  // Tom ascendente discreto (310Hz -> 430Hz), volume baixo e suave
  tone(ctx, 310.0, t0, 0.07, 0.020, 'sine');
  tone(ctx, 430.0, t0 + 0.065, 0.09, 0.024, 'sine');
}

/** Efeito sonoro suave ao desconectar da call. */
export async function playVoiceLeaveChime() {
  const now = Date.now();
  if (now - lastJoinChimeTime < 350) return;
  lastJoinChimeTime = now;

  const ctx = await unlockSfxContext();
  if (!ctx) return;
  const t0 = ctx.currentTime + 0.01;

  tone(ctx, 659.25, t0, 0.12, 0.024, 'sine');
  tone(ctx, 523.25, t0 + 0.07, 0.16, 0.022, 'sine');
}
