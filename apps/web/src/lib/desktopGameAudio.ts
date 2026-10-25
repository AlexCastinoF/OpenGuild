import { LocalAudioTrack, Track, type LocalParticipant } from 'livekit-client';

const GAME_AUDIO_GAIN = 2.6;
const SAMPLE_RATE = 48000;
const CHANNELS = 2;

const GAME_AUDIO_PUBLISH_OPTS = {
  source: Track.Source.ScreenShareAudio,
  dtx: false,
  red: false,
  forceStereo: true,
  audioPreset: { maxBitrate: 160_000 },
} as const;

type GameAudioBridge = {
  pushPcm: (bytes: Uint8Array) => void;
  resume: () => Promise<void>;
  hasData: () => boolean;
  hasAudibleData: () => boolean;
  getLevel: () => number;
  getMediaStreamTrack: () => MediaStreamTrack | null;
  dispose: () => void;
};

let bridge: GameAudioBridge | null = null;
let unsubChunk: (() => void) | null = null;
let localTrack: LocalAudioTrack | null = null;
let resumeTimer: number | null = null;
let peakLevel = 0;

function copyBytes(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  return out;
}

function pcmHasSignal(bytes: Uint8Array, threshold = 80) {
  const n = Math.floor(bytes.byteLength / 2);
  if (n < 16) return false;
  const samples = new Int16Array(bytes.buffer, bytes.byteOffset, n);
  for (let i = 0; i < samples.length; i += 8) {
    if (Math.abs(samples[i]!) >= threshold) return true;
  }
  return false;
}

/**
 * Caminho moderno (GoofCord/Discord-like): MediaStreamTrackGenerator + AudioData.
 * Evita ScriptProcessor, que no Electron frequentemente gera track muda.
 */
type TrackGeneratorCtor = new (init: { kind: 'audio' | 'video' }) => MediaStreamTrack & {
  writable: WritableStream;
};
type AudioDataCtor = new (init: {
  format: string;
  sampleRate: number;
  numberOfFrames: number;
  numberOfChannels: number;
  timestamp: number;
  data: BufferSource;
}) => { close: () => void };

function createGeneratorBridge(): GameAudioBridge | null {
  const TrackGen = (window as unknown as { MediaStreamTrackGenerator?: TrackGeneratorCtor })
    .MediaStreamTrackGenerator;
  const AudioDataCtor = (window as unknown as { AudioData?: AudioDataCtor }).AudioData;
  if (!TrackGen || !AudioDataCtor) return null;

  const generator = new TrackGen({ kind: 'audio' });
  const writer = generator.writable.getWriter();
  let chunksReceived = 0;
  let audibleChunks = 0;
  let lastRms = 0;
  let timestampUs = 0;
  let closed = false;
  const pending: Uint8Array[] = [];
  let pumping = false;

  const pump = async () => {
    if (pumping || closed) return;
    pumping = true;
    try {
      while (pending.length && !closed) {
        const chunk = pending.shift()!;
        const frames = Math.floor(chunk.byteLength / (2 * CHANNELS));
        if (frames < 1) continue;
        const byteLen = frames * 2 * CHANNELS;
        const data = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + byteLen);
        const pcm: ArrayBuffer =
          data instanceof ArrayBuffer ? data : new Uint8Array(data as ArrayBufferLike).slice().buffer;
        const audioData = new AudioDataCtor({
          format: 's16',
          sampleRate: SAMPLE_RATE,
          numberOfFrames: frames,
          numberOfChannels: CHANNELS,
          timestamp: timestampUs,
          data: pcm,
        });
        timestampUs += Math.round((frames / SAMPLE_RATE) * 1_000_000);
        try {
          await writer.write(audioData);
        } finally {
          audioData.close();
        }
      }
    } catch (err) {
      console.warn('game audio generator write failed', err);
    } finally {
      pumping = false;
      if (pending.length && !closed) void pump();
    }
  };

  return {
    pushPcm(bytes) {
      if (!bytes?.byteLength || closed) return;
      const safe = copyBytes(bytes);
      chunksReceived += 1;
      if (pcmHasSignal(safe)) audibleChunks += 1;
      const samples = new Int16Array(safe.buffer, safe.byteOffset, Math.floor(safe.byteLength / 2));
      let sumSq = 0;
      const step = Math.max(1, Math.floor(samples.length / 64));
      for (let i = 0; i < samples.length; i += step) {
        const s = samples[i]! / 32768;
        sumSq += s * s;
      }
      lastRms = Math.min(1, Math.sqrt(sumSq / Math.max(1, Math.floor(samples.length / step))) * 4);
      peakLevel = Math.max(peakLevel * 0.85, lastRms);

      // Gain leve no PCM (s16)
      if (Number(GAME_AUDIO_GAIN) !== 1) {
        for (let i = 0; i < samples.length; i++) {
          const v = Math.max(-32768, Math.min(32767, Math.round(samples[i]! * GAME_AUDIO_GAIN)));
          samples[i] = v;
        }
      }
      pending.push(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength));
      if (pending.length > 32) pending.splice(0, pending.length - 24);
      void pump();
    },
    resume: async () => undefined,
    hasData: () => chunksReceived > 0,
    hasAudibleData: () => audibleChunks > 0,
    getLevel: () => {
      const v = peakLevel;
      peakLevel *= 0.9;
      return Math.max(v, lastRms * 0.5);
    },
    getMediaStreamTrack: () => generator,
    dispose() {
      closed = true;
      pending.length = 0;
      void writer.close().catch(() => undefined);
      try {
        generator.stop();
      } catch {
        /* ignore */
      }
    },
  };
}

/** Fallback: AudioContext + ScriptProcessor com driver de input (Chromium precisa input>0). */
function createScriptProcessorBridge(): GameAudioBridge {
  const maxSamples = SAMPLE_RATE * CHANNELS * 6;
  const ring = new Int16Array(maxSamples);
  let writeIdx = 0;
  let readIdx = 0;
  let ringSize = 0;
  let chunksReceived = 0;
  let audibleChunks = 0;
  let lastRms = 0;

  const audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
  const processor = audioCtx.createScriptProcessor(2048, 1, CHANNELS);
  const dest = audioCtx.createMediaStreamDestination();
  const keepAlive = audioCtx.createGain();
  keepAlive.gain.value = 0;
  const silentIn = audioCtx.createGain();
  silentIn.gain.value = 0;
  const constant = audioCtx.createConstantSource();
  constant.offset.value = 0;
  constant.connect(silentIn);
  silentIn.connect(processor);
  processor.connect(keepAlive);
  keepAlive.connect(audioCtx.destination);
  processor.connect(dest);
  try {
    constant.start();
  } catch {
    /* ignore */
  }

  processor.onaudioprocess = (ev) => {
    const outL = ev.outputBuffer.getChannelData(0);
    const outR = CHANNELS > 1 ? ev.outputBuffer.getChannelData(1) : outL;
    const frames = outL.length;
    for (let i = 0; i < frames; i++) {
      if (ringSize >= CHANNELS) {
        const l = ring[readIdx]!;
        readIdx = (readIdx + 1) % maxSamples;
        const r = CHANNELS > 1 ? ring[readIdx]! : l;
        if (CHANNELS > 1) readIdx = (readIdx + 1) % maxSamples;
        ringSize -= CHANNELS;
        const gain = GAME_AUDIO_GAIN / 32768;
        outL[i] = Math.tanh(l * gain);
        outR[i] = Math.tanh(r * gain);
      } else {
        outL[i] = 0;
        outR[i] = 0;
      }
    }
  };

  return {
    pushPcm(bytes) {
      if (!bytes?.byteLength) return;
      const safe = copyBytes(bytes);
      chunksReceived += 1;
      if (pcmHasSignal(safe)) audibleChunks += 1;
      const incoming = new Int16Array(safe.buffer, safe.byteOffset, Math.floor(safe.byteLength / 2));
      let sumSq = 0;
      const step = Math.max(1, Math.floor(incoming.length / 64));
      for (let i = 0; i < incoming.length; i++) {
        ring[writeIdx] = incoming[i]!;
        writeIdx = (writeIdx + 1) % maxSamples;
        if (ringSize < maxSamples) ringSize += 1;
        else readIdx = (readIdx + 1) % maxSamples;
        if (i % step === 0) {
          const s = incoming[i]! / 32768;
          sumSq += s * s;
        }
      }
      lastRms = Math.min(1, Math.sqrt(sumSq / Math.max(1, Math.floor(incoming.length / step))) * 4);
      peakLevel = Math.max(peakLevel * 0.85, lastRms);
    },
    async resume() {
      if (audioCtx.state === 'suspended') await audioCtx.resume().catch(() => undefined);
    },
    hasData: () => chunksReceived > 0,
    hasAudibleData: () => audibleChunks > 0,
    getLevel: () => {
      const v = peakLevel;
      peakLevel *= 0.9;
      return Math.max(v, lastRms * 0.5);
    },
    getMediaStreamTrack() {
      void this.resume();
      const t = dest.stream.getAudioTracks()[0] || null;
      if (t) t.enabled = true;
      return t;
    },
    dispose() {
      try {
        constant.stop();
      } catch {
        /* ignore */
      }
      try {
        processor.disconnect();
      } catch {
        /* ignore */
      }
      try {
        keepAlive.disconnect();
      } catch {
        /* ignore */
      }
      try {
        silentIn.disconnect();
      } catch {
        /* ignore */
      }
      try {
        dest.disconnect();
      } catch {
        /* ignore */
      }
      void audioCtx.close().catch(() => undefined);
    },
  };
}

function createGameAudioBridge(): GameAudioBridge {
  return createGeneratorBridge() || createScriptProcessorBridge();
}

function clearResumeTimer() {
  if (resumeTimer != null) {
    window.clearInterval(resumeTimer);
    resumeTimer = null;
  }
}

export function getDesktopGameAudioLevel(): number {
  return bridge?.getLevel() ?? 0;
}

export function hasDesktopGameAudioBridge(): boolean {
  return !!bridge;
}

export function desktopGameAudioHasSignal(): boolean {
  return !!bridge?.hasAudibleData();
}

export async function stopDesktopGameAudio(lp?: LocalParticipant | null) {
  clearResumeTimer();
  peakLevel = 0;
  try {
    await window.sfDesktop?.stopGameAudioCapture?.();
  } catch {
    /* ignore */
  }
  try {
    unsubChunk?.();
  } catch {
    /* ignore */
  }
  unsubChunk = null;
  const b = bridge;
  bridge = null;
  if (b) {
    try {
      b.dispose();
    } catch {
      /* ignore */
    }
  }
  if (localTrack && lp) {
    try {
      await lp.unpublishTrack(localTrack, true);
    } catch {
      /* ignore */
    }
  }
  if (localTrack) {
    try {
      localTrack.stop();
    } catch {
      /* ignore */
    }
    localTrack = null;
  }
}

/**
 * Captura WASAPI process-loopback (como Discord) e publica ScreenShareAudio.
 * Publica a faixa já (pode ir silenciosa) e mantém a captura — o PCM entra quando o Chrome/jogo tiver som.
 */
export async function startDesktopGameAudio(
  lp: LocalParticipant,
  opts?: { publish?: boolean; waitForSignalMs?: number; mode?: 'app' | 'system' },
): Promise<{
  ok: boolean;
  audible: boolean;
  reason?: string;
  message?: string;
  backend?: string;
}> {
  const desktop = window.sfDesktop;
  const mode = opts?.mode === 'system' ? 'system' : 'app';
  const startCapture =
    mode === 'system' ? desktop?.startSystemAudioCapture : desktop?.startGameAudioCapture;
  if (!startCapture || !desktop?.onGameAudioChunk) {
    return { ok: false, audible: false, reason: 'unavailable' };
  }
  const publish = opts?.publish !== false;
  const waitMs = Math.max(0, opts?.waitForSignalMs ?? 0);

  await stopDesktopGameAudio(lp);

  const next = createGameAudioBridge();
  bridge = next;
  unsubChunk = desktop.onGameAudioChunk((chunk) => {
    next.pushPcm(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as ArrayBuffer));
  });

  try {
    const started = (await startCapture()) as {
      ok?: boolean;
      reason?: string;
      message?: string;
      backend?: string;
    } | null;
    if (!started?.ok) {
      await stopDesktopGameAudio(lp);
      return {
        ok: false,
        audible: false,
        reason: started?.reason || 'start_failed',
        message: started?.message,
      };
    }

    await next.resume();
    resumeTimer = window.setInterval(() => {
      void next.resume();
    }, 1500);

    if (waitMs > 0) {
      const deadline = Date.now() + waitMs;
      while (Date.now() < deadline && bridge === next && !next.hasAudibleData()) {
        await new Promise((r) => setTimeout(r, 150));
        await next.resume();
      }
    }

    if (publish) {
      const published = await publishDesktopGameAudio(lp);
      if (!published) {
        await stopDesktopGameAudio(lp);
        return { ok: false, audible: false, reason: 'no_track', backend: started.backend };
      }
    }

    const audible = next.hasAudibleData();
    return {
      ok: true,
      audible,
      reason: audible ? 'audible' : 'published_waiting_signal',
      message: audible
        ? undefined
        : 'Áudio da janela publicado; à espera de som (YouTube/jogo). A call de voz continua.',
      backend: started.backend,
    };
  } catch (err) {
    await stopDesktopGameAudio(lp);
    throw err;
  }
}

/** Publica o bridge já ativo (mesmo ainda sem PCM audível). */
export async function publishDesktopGameAudio(lp: LocalParticipant): Promise<boolean> {
  const next = bridge;
  if (!next) return false;
  const mediaTrack = next.getMediaStreamTrack();
  if (!mediaTrack) return false;
  if (localTrack) {
    try {
      await lp.unpublishTrack(localTrack, true);
    } catch {
      /* ignore */
    }
    try {
      localTrack.stop();
    } catch {
      /* ignore */
    }
    localTrack = null;
  }
  localTrack = new LocalAudioTrack(mediaTrack, undefined, true);
  try {
    await lp.publishTrack(localTrack, { ...GAME_AUDIO_PUBLISH_OPTS });
  } catch {
    await lp.publishTrack(localTrack, {
      source: Track.Source.ScreenShareAudio,
      dtx: false,
    });
  }
  try {
    (localTrack as LocalAudioTrack & { setVolume?: (v: number) => void }).setVolume?.(1);
  } catch {
    /* ignore */
  }
  return true;
}

export function isAppAudioMode(mode: string | undefined) {
  return mode === 'app' || mode === 'game';
}
