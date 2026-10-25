import { LocalAudioTrack, createLocalAudioTrack } from 'livekit-client';
import type { AudioDevicePrefs } from '../components/AudioSettingsDialog';
import {
  createWetDryWorkletProcessor,
  createRnnoiseNode,
  createDtlnNode,
} from './voiceNoiseProcessors';
import { setNoiseLevelOnTrack } from './voiceNoiseLevel';

export type NoiseEngine = 'off' | 'browser' | 'deepfilter' | 'rnnoise' | 'dtln' | 'krisp';
export type AecEngine = 'off' | 'webrtc';

export type VoiceMicHandle = {
  track: LocalAudioTrack;
  dispose: () => Promise<void>;
  /** true se algum motor IA (não só browser NS) está activo */
  deepFilter: boolean;
  engine: NoiseEngine;
  setNoiseLevel: (level: number) => void;
};

/** Capacidade real do runtime (Electron ou Chrome) — não depende de sfDesktop. */
export function canUseAiNoiseEngines() {
  if (typeof WebAssembly === 'undefined') return false;
  if (typeof AudioWorkletNode === 'undefined') return false;
  return true;
}

/** @deprecated use canUseAiNoiseEngines */
export function canUseDeepFilter() {
  return canUseAiNoiseEngines();
}

function clampLevel(n: unknown) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return 85;
  return Math.max(0, Math.min(100, v));
}

export function normalizeNoiseEngine(v: unknown): NoiseEngine {
  const s = String(v || '').toLowerCase();
  if (s === 'browser' || s === 'webrtc' || s === 'ns') return 'browser';
  if (s === 'deepfilter' || s === 'df' || s === 'dfn' || s === 'deepfilternet') return 'deepfilter';
  if (s === 'rnnoise' || s === 'rn') return 'rnnoise';
  if (s === 'dtln') return 'dtln';
  if (s === 'krisp') return 'krisp';
  if (s === 'off' || s === 'none' || s === 'disabled') return 'off';
  return 'krisp';
}

export function normalizeAecEngine(v: unknown): AecEngine {
  if (v === true || v === 'true' || v === 1) return 'webrtc';
  if (v === false || v === 'false' || v === 0) return 'off';
  const s = String(v || '').toLowerCase();
  if (s === 'webrtc' || s === 'browser' || s === 'on' || s === 'aec') return 'webrtc';
  if (s === 'off' || s === 'none' || s === 'disabled') return 'off';
  return 'webrtc';
}

export function noiseEngineLabel(engine: NoiseEngine): string {
  switch (engine) {
    case 'off':
      return 'Desligado';
    case 'browser':
      return 'Browser (WebRTC NS)';
    case 'deepfilter':
      return 'DeepFilterNet';
    case 'rnnoise':
      return 'RNNoise';
    case 'dtln':
      return 'DTLN';
    case 'krisp':
      return 'Krisp';
    default:
      return String(engine);
  }
}

/** Resolve motor pedindo fallbacks (sem WASM → browser; Krisp→DF se falhar na criação). */
export function resolveNoiseEngine(prefs?: AudioDevicePrefs | null): NoiseEngine {
  const eng = normalizeNoiseEngine(
    prefs?.noiseEngine ?? (prefs?.noiseFilter === false ? 'off' : 'krisp'),
  );
  if (eng === 'off' || eng === 'browser') return eng;
  if (!canUseAiNoiseEngines()) return 'browser';
  return eng;
}

export function resolveAec(prefs?: AudioDevicePrefs | null): boolean {
  return normalizeAecEngine(prefs?.echoCancellation !== false) === 'webrtc';
}

async function createDeepFilterProcessor(level: number) {
  const mod = await import('deepfilternet3-noise-filter');
  const processor = mod.DeepFilterNoiseFilter({
    sampleRate: 48000,
    noiseReductionLevel: level,
    enabled: true,
  });
  return processor;
}

async function tryKrispProcessor(level: number) {
  try {
    const mod = await import('@livekit/krisp-noise-filter');
    if (!mod.isKrispNoiseFilterSupported()) return null;
    // useBVC: cancela voz/áudio de fundo + retorno de colunas (estilo Discord).
    // O AEC WebRTC sozinho falha no Electron porque a reprodução vai pelo AudioContext,
    // não pelo <audio> que o Chromium usa como referência de eco.
    const proc = mod.KrispNoiseFilter({
      useBVC: true,
      quality: 'medium',
    });
    const wrapped = proc as typeof proc & {
      setSuppressionLevel?: (n: number) => void;
    };
    wrapped.setSuppressionLevel = (n: number) => {
      void proc.setEnabled(clampLevel(n) > 5);
    };
    if (level <= 5) void proc.setEnabled(false);
    return wrapped;
  } catch (e) {
    console.warn('[voice] Krisp indisponível:', e);
    return null;
  }
}

/**
 * Cria LocalAudioTrack + motor de ruído/AEC.
 * Tudo client-side — sem VPS.
 */
export async function createVoiceMicTrack(
  prefs?: AudioDevicePrefs | null,
): Promise<VoiceMicHandle> {
  const engine = resolveNoiseEngine(prefs);
  const level = clampLevel(prefs?.noiseLevel ?? 85);
  const aecOn = resolveAec(prefs);
  const deviceId = prefs?.micId || undefined;
  const useBrowserNs = engine === 'browser';

  const track = await createLocalAudioTrack({
    deviceId,
    echoCancellation: aecOn,
    noiseSuppression: useBrowserNs,
    autoGainControl: true,
    voiceIsolation: useBrowserNs ? true : undefined,
    channelCount: 1,
  });

  let activeEngine: NoiseEngine = engine;
  let setLevel: (n: number) => void = () => undefined;

  const dispose = async () => {
    try {
      await track.stopProcessor();
    } catch {
      /* ignore */
    }
    try {
      track.stop();
    } catch {
      /* ignore */
    }
  };

  if (engine === 'off' || engine === 'browser') {
    return {
      track,
      dispose,
      deepFilter: false,
      engine,
      setNoiseLevel: setLevel,
    };
  }

  try {
    if (engine === 'deepfilter') {
      const processor = await createDeepFilterProcessor(level);
      await track.setProcessor(processor);
      setLevel = (n) => processor.setSuppressionLevel(clampLevel(n));
      return { track, dispose, deepFilter: true, engine: 'deepfilter', setNoiseLevel: setLevel };
    }

    if (engine === 'rnnoise') {
      const processor = createWetDryWorkletProcessor('rnnoise', createRnnoiseNode, level);
      await track.setProcessor(processor);
      setLevel = (n) => processor.setSuppressionLevel(clampLevel(n));
      return { track, dispose, deepFilter: true, engine: 'rnnoise', setNoiseLevel: setLevel };
    }

    if (engine === 'dtln') {
      const processor = createWetDryWorkletProcessor('dtln', createDtlnNode, level, {
        sampleRate: 16000,
        forceOwnContext: true,
      });
      await track.setProcessor(processor);
      setLevel = (n) => processor.setSuppressionLevel(clampLevel(n));
      return { track, dispose, deepFilter: true, engine: 'dtln', setNoiseLevel: setLevel };
    }

    if (engine === 'krisp') {
      const processor = await tryKrispProcessor(level);
      if (processor) {
        await track.setProcessor(processor);
        setLevel = (n) => processor.setSuppressionLevel?.(clampLevel(n));
        return { track, dispose, deepFilter: true, engine: 'krisp', setNoiseLevel: setLevel };
      }
      console.warn('[voice] Krisp falhou — fallback DeepFilterNet');
      activeEngine = 'deepfilter';
      const fallback = await createDeepFilterProcessor(level);
      await track.setProcessor(fallback);
      setLevel = (n) => fallback.setSuppressionLevel(clampLevel(n));
      return { track, dispose, deepFilter: true, engine: activeEngine, setNoiseLevel: setLevel };
    }
  } catch (e) {
    console.warn(`[voice] motor ${engine} falhou — mic sem IA:`, e);
  }

  return {
    track,
    dispose,
    deepFilter: false,
    engine: 'browser',
    setNoiseLevel: setLevel,
  };
}

/** @deprecated */
export async function createDeepFilterMicTrack(prefs?: AudioDevicePrefs | null) {
  return createVoiceMicTrack(prefs);
}

export { setNoiseLevelOnTrack };
