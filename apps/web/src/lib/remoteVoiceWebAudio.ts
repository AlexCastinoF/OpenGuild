/** Playback de voz remota via Web Audio — bypassa HTMLAudioElement quando o Chromium silencia output no share. */

type MixNode = {
  key: string;
  source: MediaStreamAudioSourceNode;
  gain: GainNode;
  track: MediaStreamTrack;
};

let ctx: AudioContext | null = null;
const nodes = new Map<string, MixNode>();
let pendingSinkId: string | null = null;

type AudioContextWithSink = AudioContext & {
  setSinkId?: (id: string) => Promise<void>;
  sinkId?: string;
};

function ensureCtx(): AudioContext | null {
  try {
    if (!ctx || ctx.state === 'closed') {
      const AC =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      if (pendingSinkId != null) {
        void setVoiceWebAudioSink(pendingSinkId);
      }
    }
    return ctx;
  } catch {
    return null;
  }
}

/** No Electron a voz sai pelo AudioContext — setSinkId nos <audio> mudos não faz nada. */
export async function setVoiceWebAudioSink(deviceId: string): Promise<boolean> {
  pendingSinkId = deviceId || '';
  const c = ensureCtx() as AudioContextWithSink | null;
  if (!c || typeof c.setSinkId !== 'function') return false;
  try {
    const want = deviceId || '';
    if ((c.sinkId || '') === want) return true;
    await c.setSinkId(want);
    return true;
  } catch (err) {
    console.warn('[voice] AudioContext.setSinkId falhou', deviceId || '(default)', err);
    return false;
  }
}

export async function resumeVoiceWebAudio(): Promise<{ state: string; nodes: number }> {
  const c = ensureCtx();
  if (!c) return { state: 'none', nodes: nodes.size };
  try {
    if (c.state === 'suspended') await c.resume();
  } catch {
    /* ignore */
  }
  return { state: c.state, nodes: nodes.size };
}

export function clearVoiceWebAudio() {
  for (const n of nodes.values()) {
    try {
      n.source.disconnect();
    } catch {
      /* ignore */
    }
    try {
      n.gain.disconnect();
    } catch {
      /* ignore */
    }
    try {
      n.track.stop();
    } catch {
      /* ignore */
    }
  }
  nodes.clear();
}

export function setVoiceWebAudioGain(key: string, volume: number, enabled: boolean) {
  const n = nodes.get(key);
  if (!n) return;
  const v = enabled ? Math.max(0, Math.min(1, volume)) : 0;
  try {
    n.gain.gain.setTargetAtTime(v, n.gain.context.currentTime, 0.02);
  } catch {
    n.gain.gain.value = v;
  }
}

/**
 * Liga um MediaStreamTrack remoto ao destination do AudioContext.
 * Clona o track para não brigar com LiveKit attach()/analyser.
 */
export function upsertVoiceWebAudio(
  key: string,
  mediaTrack: MediaStreamTrack | undefined | null,
  volume: number,
  enabled: boolean,
): boolean {
  if (!mediaTrack || mediaTrack.readyState === 'ended') {
    removeVoiceWebAudio(key);
    return false;
  }
  const c = ensureCtx();
  if (!c) return false;

  const existing = nodes.get(key);
  if (existing && existing.track.id === mediaTrack.id && existing.track.readyState === 'live') {
    setVoiceWebAudioGain(key, volume, enabled);
    return true;
  }
  if (existing) removeVoiceWebAudio(key);

  try {
    const cloned = mediaTrack.clone();
    const stream = new MediaStream([cloned]);
    const source = c.createMediaStreamSource(stream);
    const gain = c.createGain();
    gain.gain.value = enabled ? Math.max(0, Math.min(1, volume)) : 0;
    source.connect(gain);
    gain.connect(c.destination);
    nodes.set(key, { key, source, gain, track: cloned });
    void c.resume().catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

export function removeVoiceWebAudio(key: string) {
  const n = nodes.get(key);
  if (!n) return;
  nodes.delete(key);
  try {
    n.source.disconnect();
  } catch {
    /* ignore */
  }
  try {
    n.gain.disconnect();
  } catch {
    /* ignore */
  }
  try {
    n.track.stop();
  } catch {
    /* ignore */
  }
}

export function voiceWebAudioStats() {
  const c = ctx as AudioContextWithSink | null;
  return {
    ctxState: ctx?.state || 'none',
    nodes: nodes.size,
    keys: [...nodes.keys()],
    sinkId: c?.sinkId ?? pendingSinkId ?? '',
  };
}
