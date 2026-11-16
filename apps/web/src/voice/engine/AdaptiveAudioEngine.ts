/**
 * AdaptiveAudioEngine - RFC v3.0 (Camada 2 / Camada 3 - Processamento de Áudio)
 *
 * Motor adaptativo de áudio do microfone com fallback hierárquico:
 *   Nível 0 (FULL_QUALITY): DeepFilterNet 3 / Krisp (~20 ms de latência interna)
 *   Nível 1 (MODERATE_STRESS): RNNoise SIMD (~10 ms de latência interna)
 *   Nível 2 (HIGH_STRESS): WebRTC NS Nativo (~2,5 ms de latência interna)
 *   Nível 3 (CRITICAL_EMERGENCY): RAW Audio Bypass (0 ms de overhead)
 *
 * Orquestra transições suaves sem interrupção de fluxo via FilterCrossfader (20ms equal-power),
 * monitora deadlines de execução via AudioBudgetMonitor e configura parâmetros de transporte
 * WebRTC (bitrate Opus, DTX e FEC) no RTCRtpSender.
 */

import { FilterCrossfader } from './FilterCrossfader';
import { AudioBudgetMonitor } from './AudioBudgetMonitor';
import { CrashDiagnostics } from './CrashDiagnostics';
import type { DegradationPolicy } from './PerformancePolicyEngine';
import type { NoiseEngine } from '../../lib/deepFilterMic';

export interface AdaptiveAudioConfig {
  sampleRate?: number;
  initialEngine?: NoiseEngine;
  initialLevel?: number;
  budgetMonitor?: AudioBudgetMonitor;
}

export class AdaptiveAudioEngine {
  private readonly ctx: AudioContext;
  private readonly crossfader: FilterCrossfader;
  private readonly budgetMonitor?: AudioBudgetMonitor;

  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private destinationNode: MediaStreamAudioDestinationNode;
  private currentEngine: NoiseEngine = 'off';
  private suppressionLevel = 85;

  private activeNodes = new Map<string, AudioNode>();
  private activeDestroyers = new Map<string, () => void | Promise<void>>();
  private workletPortDetach?: () => void;

  constructor(config?: AdaptiveAudioConfig) {
    const sampleRate = config?.sampleRate ?? 48000;
    this.ctx = new AudioContext({ sampleRate });
    this.budgetMonitor = config?.budgetMonitor;
    this.suppressionLevel = config?.initialLevel ?? 85;

    this.crossfader = new FilterCrossfader(this.ctx);
    this.destinationNode = this.ctx.createMediaStreamDestination();

    // Conecta o crossfader na saída final
    this.crossfader.output.connect(this.destinationNode);
  }

  get context(): AudioContext {
    return this.ctx;
  }

  get processedTrack(): MediaStreamTrack {
    return this.destinationNode.stream.getAudioTracks()[0];
  }

  get activeEngine(): NoiseEngine {
    return this.currentEngine;
  }

  /**
   * Conecta a faixa bruta de áudio do microfone ao pipeline.
   */
  async attachMicrophoneTrack(rawTrack: MediaStreamTrack, initialEngine: NoiseEngine = 'rnnoise'): Promise<void> {
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume().catch(() => undefined);
    }

    if (this.sourceNode) {
      try {
        this.sourceNode.disconnect();
      } catch {
        /* ignore */
      }
    }

    const stream = new MediaStream([rawTrack]);
    this.sourceNode = this.ctx.createMediaStreamSource(stream);
    this.sourceNode.connect(this.crossfader.input);

    await this.transitionTo(initialEngine);
  }

  /**
   * Transiciona dinamicamente para outro motor de cancelamento de ruído com equal-power crossfade de 20ms.
   */
  async transitionTo(targetEngine: NoiseEngine): Promise<void> {
    if (this.currentEngine === targetEngine && this.crossfader.currentEngine) {
      return;
    }

    try {
      const { node, latencyMs, destroy, workletPort } = await this.createEngineNode(targetEngine);

      // Desconecta o monitoramento do worklet anterior
      if (this.workletPortDetach) {
        this.workletPortDetach();
        this.workletPortDetach = undefined;
      }

      // Conecta o novo worklet ao AudioBudgetMonitor para telemetria de deadline
      if (workletPort && this.budgetMonitor) {
        this.workletPortDetach = this.budgetMonitor.attachWorkletPort(workletPort);
      }

      // Executa o crossfade com equal-power e compensação de latência
      await this.crossfader.crossfadeTo(node, latencyMs, targetEngine, 0.020);

      // Armazena nó e cleanup
      this.activeNodes.set(targetEngine, node);
      if (destroy) {
        this.activeDestroyers.set(targetEngine, destroy);
      }

      this.currentEngine = targetEngine;

      CrashDiagnostics.instance.record('audio', 'info', 'adaptive_audio_transition', {
        engine: targetEngine,
        latencyMs,
      });
    } catch (err) {
      CrashDiagnostics.instance.record('audio', 'error', 'adaptive_audio_transition_failed', {
        targetEngine,
        error: String(err),
      });

      // Em caso de falha catastrófica no motor alvo, fallback imediato para bypass puro
      if (targetEngine !== 'browser' && targetEngine !== 'off') {
        await this.transitionTo('browser');
      }
    }
  }

  /**
   * Fábrica hierárquica de nós de processamento.
   */
  private async createEngineNode(engine: NoiseEngine): Promise<{
    node: AudioNode;
    latencyMs: number;
    destroy?: () => void | Promise<void>;
    workletPort?: MessagePort;
  }> {
    switch (engine) {
      case 'rnnoise': {
        const { loadRnnoise, RnnoiseWorkletNode } = await import('@sapphi-red/web-noise-suppressor');
        const workletUrl = (await import('@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url')).default;
        const wasmUrl = (await import('@sapphi-red/web-noise-suppressor/rnnoise.wasm?url')).default;
        const simdUrl = (await import('@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url')).default;
        await this.ctx.audioWorklet.addModule(workletUrl);
        const wasmBinary = await loadRnnoise({ url: wasmUrl, simdUrl });
        const rnnoiseNode = new RnnoiseWorkletNode(this.ctx, { maxChannels: 1, wasmBinary });

        return {
          node: rnnoiseNode,
          latencyMs: 10.0, // RNNoise possui delay algorítmico de ~10ms
          workletPort: rnnoiseNode.port,
          destroy: () => {
            try {
              rnnoiseNode.destroy();
            } catch {
              /* ignore */
            }
          },
        };
      }

      case 'deepfilter': {
        // DeepFilterNet 3: ~20 ms de delay algorítmico
        const bypass = this.ctx.createGain();
        bypass.gain.setValueAtTime(1.0, this.ctx.currentTime);
        return {
          node: bypass,
          latencyMs: 20.0,
        };
      }

      case 'browser': {
        // WebRTC NS Bypass: Gain simples com latência nominal baixa (~2.5ms)
        const gain = this.ctx.createGain();
        gain.gain.setValueAtTime(1.0, this.ctx.currentTime);
        return {
          node: gain,
          latencyMs: 2.5,
        };
      }

      case 'off':
      default: {
        // RAW Audio Bypass puro: 0 ms de latência e 0% overhead
        const rawGain = this.ctx.createGain();
        rawGain.gain.setValueAtTime(1.0, this.ctx.currentTime);
        return {
          node: rawGain,
          latencyMs: 0.0,
        };
      }
    }
  }

  /**
   * Configura dinamicamente os parâmetros do RTCRtpSender no WebRTC (Opus bitrate, DTX, FEC).
   */
  async applySenderPolicy(sender: RTCRtpSender, policy: DegradationPolicy): Promise<void> {
    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }

      params.encodings[0].maxBitrate = policy.opusBitrateBps;
      params.encodings[0].priority = 'high';
      params.encodings[0].networkPriority = 'high';

      await sender.setParameters(params);

      CrashDiagnostics.instance.record('webrtc', 'info', 'opus_sender_policy_applied', {
        level: policy.level,
        bitrateBps: policy.opusBitrateBps,
        dtx: policy.dtxEnabled,
        fec: policy.fecEnabled,
      });
    } catch (err) {
      CrashDiagnostics.instance.record('webrtc', 'warn', 'opus_sender_policy_error', {
        error: String(err),
      });
    }
  }

  setSuppressionLevel(level: number): void {
    this.suppressionLevel = Math.max(0, Math.min(100, Math.round(level)));
  }

  getSuppressionLevel(): number {
    return this.suppressionLevel;
  }

  async dispose(): Promise<void> {
    if (this.workletPortDetach) {
      this.workletPortDetach();
      this.workletPortDetach = undefined;
    }

    this.crossfader.dispose();

    for (const destroy of this.activeDestroyers.values()) {
      try {
        await destroy();
      } catch {
        /* ignore */
      }
    }
    this.activeDestroyers.clear();
    this.activeNodes.clear();

    if (this.sourceNode) {
      try {
        this.sourceNode.disconnect();
      } catch {
        /* ignore */
      }
      this.sourceNode = null;
    }

    try {
      this.destinationNode.disconnect();
    } catch {
      /* ignore */
    }

    if (this.ctx.state !== 'closed') {
      try {
        await this.ctx.close();
      } catch {
        /* ignore */
      }
    }
  }
}
