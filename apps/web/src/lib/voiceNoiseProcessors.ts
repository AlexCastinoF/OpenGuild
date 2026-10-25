import type {
  AudioProcessorOptions,
  TrackProcessor,
} from 'livekit-client';
import { Track } from 'livekit-client';

type NodeHandle = {
  node: AudioNode;
  destroy?: () => void | Promise<void>;
};

type MixHandles = {
  wetGain: GainNode;
  dryGain: GainNode;
  setLevel: (level: number) => void;
  destroy: () => Promise<void>;
};

function clampLevel(n: unknown) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return 85;
  return Math.max(0, Math.min(100, v));
}

function applyWetDry(wet: GainNode, dry: GainNode, level: number) {
  const t = clampLevel(level) / 100;
  // curva suave: 0 = só dry, 100 = só wet
  wet.gain.value = t;
  dry.gain.value = 1 - t * 0.92;
}

/**
 * TrackProcessor LiveKit genérico: mic → (dry + wet/worklet) → track processada.
 * `noiseLevel` controla o mix dry/wet (estilo Discord).
 */
export function createWetDryWorkletProcessor(
  name: string,
  createNode: (ctx: AudioContext) => Promise<NodeHandle>,
  initialLevel = 85,
  opts?: { sampleRate?: number; forceOwnContext?: boolean },
): TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> & {
  setSuppressionLevel: (n: number) => void;
} {
  let audioContext: AudioContext | null = null;
  let ownsContext = false;
  let source: MediaStreamAudioSourceNode | null = null;
  let destination: MediaStreamAudioDestinationNode | null = null;
  let mix: MixHandles | null = null;
  let level = clampLevel(initialLevel);
  const preferredRate = opts?.sampleRate ?? 48000;
  const forceOwn = opts?.forceOwnContext === true;

  const processor: TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> & {
    setSuppressionLevel: (n: number) => void;
    processedTrack?: MediaStreamTrack;
  } = {
    name,
    processedTrack: undefined,
    setSuppressionLevel(n: number) {
      level = clampLevel(n);
      if (mix) applyWetDry(mix.wetGain, mix.dryGain, level);
    },
    async init(initOpts) {
      await processor.restart(initOpts);
    },
    async restart(initOpts) {
      await processor.destroy();
      const track = initOpts.track;
      if (!track) throw new Error(`${name}: track em falta`);

      let ctx = forceOwn ? null : initOpts.audioContext;
      if (!ctx || ctx.state === 'closed' || (forceOwn && ctx.sampleRate !== preferredRate)) {
        ctx = new AudioContext({ sampleRate: preferredRate });
        ownsContext = true;
      } else {
        ownsContext = false;
      }
      audioContext = ctx;
      if (ctx.state === 'suspended') await ctx.resume().catch(() => undefined);

      const handle = await createNode(ctx);
      source = ctx.createMediaStreamSource(new MediaStream([track]));
      destination = ctx.createMediaStreamDestination();
      const wetGain = ctx.createGain();
      const dryGain = ctx.createGain();
      applyWetDry(wetGain, dryGain, level);

      source.connect(handle.node);
      handle.node.connect(wetGain);
      source.connect(dryGain);
      wetGain.connect(destination);
      dryGain.connect(destination);

      mix = {
        wetGain,
        dryGain,
        setLevel: (n) => applyWetDry(wetGain, dryGain, n),
        destroy: async () => {
          try {
            source?.disconnect();
          } catch {
            /* ignore */
          }
          try {
            handle.node.disconnect();
          } catch {
            /* ignore */
          }
          try {
            wetGain.disconnect();
            dryGain.disconnect();
          } catch {
            /* ignore */
          }
          try {
            await handle.destroy?.();
          } catch {
            /* ignore */
          }
        },
      };

      processor.processedTrack = destination.stream.getAudioTracks()[0];
    },
    async destroy() {
      try {
        await mix?.destroy();
      } catch {
        /* ignore */
      }
      mix = null;
      source = null;
      destination = null;
      processor.processedTrack = undefined;
      if (ownsContext && audioContext) {
        try {
          await audioContext.close();
        } catch {
          /* ignore */
        }
      }
      audioContext = null;
      ownsContext = false;
    },
  };

  return processor;
}

export async function createRnnoiseNode(ctx: AudioContext): Promise<NodeHandle> {
  const { loadRnnoise, RnnoiseWorkletNode } = await import('@sapphi-red/web-noise-suppressor');
  const workletUrl = (await import('@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url')).default;
  const wasmUrl = (await import('@sapphi-red/web-noise-suppressor/rnnoise.wasm?url')).default;
  const simdUrl = (await import('@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url')).default;
  await ctx.audioWorklet.addModule(workletUrl);
  const wasmBinary = await loadRnnoise({ url: wasmUrl, simdUrl });
  const node = new RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary });
  return {
    node,
    destroy: () => {
      try {
        node.destroy();
      } catch {
        /* ignore */
      }
    },
  };
}

export async function createDtlnNode(ctx: AudioContext): Promise<NodeHandle> {
  const { createNoiseSuppressionAudioWorklet } = await import(
    '@workadventure/noise-suppression/audio-worklet'
  );
  // DTLN tipicamente a 16 kHz — se o contexto for 48k o worklet faz resample interno quando suportado
  const handle = await createNoiseSuppressionAudioWorklet(ctx, { bypassUntilReady: true });
  return {
    node: handle.node,
    destroy: () => {
      try {
        handle.dispose();
      } catch {
        /* ignore */
      }
    },
  };
}
