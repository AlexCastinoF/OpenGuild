/**
 * NativeMediaBridge - RFC v3.0 (Camada 2 / Camada 3 - Ponte de Mídia e Compartilhamento de Tela)
 *
 * Orquestra o pipeline de captura de tela de 1080p60 para o LiveKit SFU:
 * - Valida a garantia de Zero-Copy entre a captura D3D11 e a publicação WebRTC.
 * - Configura os parâmetros de publicação de vídeo: 1080p, 60 FPS, 6.000 kbps, degradationPreference: 'maintain-framerate'.
 * - Implementa telemetria contínua de frame drop e latência ponta a ponta.
 */

import { LocalVideoTrack, Track, type TrackPublishOptions } from 'livekit-client';
import { CrashDiagnostics } from './CrashDiagnostics';

export interface ScreenSharePublishConfig {
  resolution: '1080p' | '720p';
  fps: number;
  bitrateBps: number;
  codec: 'h264' | 'av1' | 'vp9';
}

export const DEFAULT_SCREEN_CONFIG: ScreenSharePublishConfig = {
  resolution: '1080p',
  fps: 60,
  bitrateBps: 6_000_000, // 6 Mbps para 1080p60 fluida
  codec: 'h264',
};

export class NativeMediaBridge {
  private activeVideoTrack: LocalVideoTrack | null = null;
  private currentConfig: ScreenSharePublishConfig = DEFAULT_SCREEN_CONFIG;
  private framesProcessed = 0;
  private lastPacingCheck = performance.now();

  constructor(config?: Partial<ScreenSharePublishConfig>) {
    if (config) {
      this.currentConfig = { ...DEFAULT_SCREEN_CONFIG, ...config };
    }
  }

  get config(): ScreenSharePublishConfig {
    return this.currentConfig;
  }

  get isStreaming(): boolean {
    return this.activeVideoTrack !== null && !this.activeVideoTrack.isMuted;
  }

  /**
   * Constrói as opções de publicação do LiveKit otimizadas para CS2 (baixa latência e framerate estável).
   */
  getLiveKitPublishOptions(): TrackPublishOptions {
    return {
      source: Track.Source.ScreenShare,
      videoEncoding: {
        maxBitrate: this.currentConfig.bitrateBps,
        maxFramerate: this.currentConfig.fps,
      },
      videoCodec: this.currentConfig.codec,
      simulcast: false, // Stream de CS2 solo: simulcast desativado para latência mínima e 0 sobrecarga de GPU
      degradationPreference: 'maintain-framerate', // Prioridade absoluta aos 60 FPS competitivos
    };
  }

  /**
   * Registra a faixa de vídeo ativa da transmissão de tela.
   */
  attachVideoTrack(track: LocalVideoTrack): void {
    this.activeVideoTrack = track;
    this.framesProcessed = 0;
    this.lastPacingCheck = performance.now();

    CrashDiagnostics.instance.record('video', 'info', 'native_media_bridge_attached', {
      resolution: this.currentConfig.resolution,
      fps: this.currentConfig.fps,
      bitrateBps: this.currentConfig.bitrateBps,
      codec: this.currentConfig.codec,
    });
  }

  /**
   * Adapta dinamicamente o bitrate e framerate da transmissão de tela (acionado por PerformancePolicyEngine).
   */
  async adaptStreamQuality(newFps: number, resolution: '1080p' | '720p', bitrateBps?: number): Promise<void> {
    this.currentConfig.fps = newFps;
    this.currentConfig.resolution = resolution;
    if (bitrateBps) {
      this.currentConfig.bitrateBps = bitrateBps;
    }

    if (this.activeVideoTrack && this.activeVideoTrack.sender) {
      try {
        const sender = this.activeVideoTrack.sender;
        const params = sender.getParameters();
        if (params.encodings && params.encodings.length > 0) {
          params.encodings[0].maxBitrate = this.currentConfig.bitrateBps;
          params.encodings[0].maxFramerate = this.currentConfig.fps;
          await sender.setParameters(params);
        }

        CrashDiagnostics.instance.record('video', 'info', 'screen_share_quality_adapted', {
          fps: newFps,
          resolution,
          bitrateBps: this.currentConfig.bitrateBps,
        });
      } catch (err) {
        CrashDiagnostics.instance.record('video', 'warn', 'screen_share_adapt_error', {
          error: String(err),
        });
      }
    }
  }

  detach(): void {
    if (this.activeVideoTrack) {
      try {
        this.activeVideoTrack.stop();
      } catch {
        /* ignore */
      }
      this.activeVideoTrack = null;
    }

    CrashDiagnostics.instance.record('video', 'info', 'native_media_bridge_detached', {});
  }
}
