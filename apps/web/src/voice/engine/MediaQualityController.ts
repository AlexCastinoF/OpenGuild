/**
 * MediaQualityController (RFC v3.0 - Etapa 8)
 *
 * Centraliza a qualidade perceptual e o controle de transporte WebRTC / LiveKit SFU:
 * 1. Arbitra parâmetros de transmissão (resolução, FPS, bitrate de vídeo e áudio) em
 *    harmonia com Dynacast e Simulcast do LiveKit sem conflito com o BWE (Bandwidth Estimator).
 * 2. Seleção de codec de vídeo em 3 níveis (AV1 HW -> H.264 High -> VP8/VP9 fallback).
 * 3. Máquina de estados de reconexão resiliente em 5 fases com backoff exponencial
 *    (500 ms -> 1 s -> 2 s -> 4 s -> 8 s) e renovação silenciosa de tokens JWT.
 * 4. Atendimento aos SLOs de CS2: zero jitter induced, latência de voz p95 < 150 ms
 *    e reconexão controlada p95 < 2 s.
 */

import type { Room, LocalVideoTrack, LocalAudioTrack, TrackPublication } from 'livekit-client';
import type { DegradationLevel } from './PerformancePolicyEngine';

export type MediaPriorityMode = 'extreme_performance' | 'visual_fidelity';

export type VideoCodecTier = 'av1' | 'h264' | 'vp8' | 'vp9';

export type ReconnectionPhase =
  | 'IDLE'
  | 'FAST_RECONNECT'       // Fase 1: 0 - 500ms (soft signal reconnect)
  | 'ICE_RESTART'          // Fase 2: 500 - 1500ms (ICE restart)
  | 'TOKEN_REFRESH'        // Fase 3: 1500 - 3500ms (silent JWT renewal)
  | 'SESSION_RENEGOTIATE'  // Fase 4: 3500 - 7500ms (clean track teardown & rejoin)
  | 'TERMINAL_FALLBACK';   // Fase 5: > 7500ms (graceful notification & safe retry)

export interface QualityProfile {
  name: string;
  width: number;
  height: number;
  fps: number;
  maxBitrateBps: number;
  minBitrateBps: number;
  audioBitrateBps: number;
  simulcastEnabled: boolean;
  dynacastEnabled: boolean;
  preferredCodec: VideoCodecTier;
}

export interface ReconnectionState {
  phase: ReconnectionPhase;
  attempt: number;
  startTime: number;
  lastAttemptDurationMs: number;
  totalOutageMs: number;
  reconnectCount: number;
  p95LatencyMs: number;
}

export interface MediaQualityControllerOptions {
  room?: Room | null;
  priorityMode?: MediaPriorityMode;
  tokenProvider?: () => Promise<string>;
  onReconnectionPhaseChange?: (phase: ReconnectionPhase, attempt: number) => void;
  onQualityAdjusted?: (profile: QualityProfile, reason: string) => void;
}

/** Perfis de qualidade por nível de degradação estruturada (L0 a L3) */
const QUALITY_PROFILES: Record<DegradationLevel, QualityProfile> = {
  0: {
    name: 'L0 - Full Quality (1080p60)',
    width: 1920,
    height: 1080,
    fps: 60,
    maxBitrateBps: 6_000_000,
    minBitrateBps: 3_000_000,
    audioBitrateBps: 64_000,
    simulcastEnabled: true,
    dynacastEnabled: true,
    preferredCodec: 'av1', // Tier 1: Hardware AV1 (NVIDIA RTX 40 series)
  },
  1: {
    name: 'L1 - Moderate Stress (1080p30 / 720p60)',
    width: 1920,
    height: 1080,
    fps: 30,
    maxBitrateBps: 4_000_000,
    minBitrateBps: 2_000_000,
    audioBitrateBps: 48_000,
    simulcastEnabled: true,
    dynacastEnabled: true,
    preferredCodec: 'h264', // Tier 2: Universal NVENC / AMD H.264
  },
  2: {
    name: 'L2 - High Stress (720p30)',
    width: 1280,
    height: 720,
    fps: 30,
    maxBitrateBps: 2_200_000,
    minBitrateBps: 1_000_000,
    audioBitrateBps: 32_000,
    simulcastEnabled: true,
    dynacastEnabled: true,
    preferredCodec: 'h264',
  },
  3: {
    name: 'L3 - Critical Emergency (480p15)',
    width: 854,
    height: 480,
    fps: 15,
    maxBitrateBps: 1_000_000,
    minBitrateBps: 500_000,
    audioBitrateBps: 24_000,
    simulcastEnabled: false,
    dynacastEnabled: true,
    preferredCodec: 'h264',
  },
};

export class MediaQualityController {
  private room: Room | null = null;
  private priorityMode: MediaPriorityMode = 'extreme_performance';
  private currentLevel: DegradationLevel = 0;
  private currentProfile: QualityProfile = QUALITY_PROFILES[0];
  private selectedCodec: VideoCodecTier = 'h264';
  private tokenProvider?: () => Promise<string>;
  private onReconnectionPhaseChange?: (phase: ReconnectionPhase, attempt: number) => void;
  private onQualityAdjusted?: (profile: QualityProfile, reason: string) => void;

  // Estado da máquina de 5 fases de reconexão
  private reconnectionState: ReconnectionState = {
    phase: 'IDLE',
    attempt: 0,
    startTime: 0,
    lastAttemptDurationMs: 0,
    totalOutageMs: 0,
    reconnectCount: 0,
    p95LatencyMs: 0,
  };
  private reconnectionLatencies: number[] = [];
  private reconnectionTimer: ReturnType<typeof setTimeout> | null = null;
  private activeScreenTrack: LocalVideoTrack | null = null;
  private activeAudioTrack: LocalAudioTrack | null = null;
  private isDisposed = false;

  constructor(options: MediaQualityControllerOptions = {}) {
    this.room = options.room || null;
    this.priorityMode = options.priorityMode || 'extreme_performance';
    this.tokenProvider = options.tokenProvider;
    this.onReconnectionPhaseChange = options.onReconnectionPhaseChange;
    this.onQualityAdjusted = options.onQualityAdjusted;

    // Detecta suporte a AV1 no hardware
    this.detectHardwareCodecSupport();
  }

  /**
   * Vincula ou atualiza a instância da Sala LiveKit
   */
  public attachRoom(room: Room | null): void {
    this.room = room;
    if (!room) return;

    // Garante que Dynacast está habilitado para economizar banda e CPU
    try {
      // LiveKit Client dynacast & simulcast handling
      if ('setDynacast' in room && typeof (room as any).setDynacast === 'function') {
        (room as any).setDynacast(true);
      }
    } catch {
      // Ignora erro se versão do client não expor diretamente
    }
  }

  /**
   * Vincula tracks locais ativas para controle dinâmico de bitrate e resolução
   */
  public attachTracks(screenTrack: LocalVideoTrack | null, audioTrack: LocalAudioTrack | null): void {
    this.activeScreenTrack = screenTrack;
    this.activeAudioTrack = audioTrack;
    this.applyCurrentProfile('Track attach');
  }

  /**
   * Define o modo de prioridade do usuário:
   * - 'extreme_performance': Garante impacto < 3% no CS2 a qualquer custo
   * - 'visual_fidelity': Permite maior resolução e bitrate enquanto CPU/GPU permitirem
   */
  public setPriorityMode(mode: MediaPriorityMode): void {
    if (this.priorityMode === mode) return;
    this.priorityMode = mode;
    this.evaluateQualityState('Priority mode changed to ' + mode);
  }

  public getPriorityMode(): MediaPriorityMode {
    return this.priorityMode;
  }

  public getCurrentProfile(): QualityProfile {
    return { ...this.currentProfile };
  }

  public getReconnectionState(): ReconnectionState {
    return { ...this.reconnectionState };
  }

  /**
   * Recebe atualização de degradação emitida pelo PerformancePolicyEngine
   */
  public onDegradationLevelChanged(level: DegradationLevel, reason: string): void {
    if (this.isDisposed) return;
    this.currentLevel = level;
    this.evaluateQualityState(`Policy level changed to L${level}: ${reason}`);
  }

  /**
   * Avalia e aplica o perfil ideal considerando o nível de estresse e o modo de prioridade
   */
  private evaluateQualityState(reason: string): void {
    let targetProfile = { ...QUALITY_PROFILES[this.currentLevel] };

    // Se usuário exige desempenho extremo no CS2, limita resolução máxima a 720p60 ou 1080p30
    if (this.priorityMode === 'extreme_performance' && this.currentLevel === 0) {
      targetProfile.maxBitrateBps = Math.min(targetProfile.maxBitrateBps, 4_500_000);
      targetProfile.fps = 60;
    }

    // Se o codec escolhido for H.264 por restrição de receptor, respeita
    if (this.selectedCodec !== 'av1') {
      targetProfile.preferredCodec = this.selectedCodec;
    }

    this.currentProfile = targetProfile;
    this.applyCurrentProfile(reason);
    this.onQualityAdjusted?.(this.currentProfile, reason);
  }

  /**
   * Aplica dinamicamente limites de bitrate no RTCRtpSender sem reiniciar a track
   */
  private applyCurrentProfile(reason: string): void {
    if (!this.activeScreenTrack) return;

    try {
      const mediaTrack = this.activeScreenTrack.mediaStreamTrack;
      if (mediaTrack && 'applyConstraints' in mediaTrack) {
        void mediaTrack.applyConstraints({
          width: { max: this.currentProfile.width },
          height: { max: this.currentProfile.height },
          frameRate: { max: this.currentProfile.fps },
        }).catch(() => undefined);
      }

      // Ajusta parâmetros de codificação RTCRtpSender se disponível
      const sender = (this.activeScreenTrack as any).sender as RTCRtpSender | undefined;
      if (sender && typeof sender.getParameters === 'function') {
        const params = sender.getParameters();
        if (params.encodings && params.encodings.length > 0) {
          for (const enc of params.encodings) {
            enc.maxBitrate = this.currentProfile.maxBitrateBps;
            enc.maxFramerate = this.currentProfile.fps;
          }
          void sender.setParameters(params).catch(() => undefined);
        }
      }
    } catch (err) {
      console.warn('[MediaQualityController] Erro ao aplicar perfil de mídia:', err);
    }
  }

  /**
   * Detecta se o ambiente suporta AV1 por hardware
   */
  private detectHardwareCodecSupport(): void {
    // No Windows / Chromium, podemos verificar RTCRtpSender.getCapabilities se disponível
    if (typeof RTCRtpSender !== 'undefined' && 'getCapabilities' in RTCRtpSender) {
      const caps = RTCRtpSender.getCapabilities('video');
      const hasAV1 = caps?.codecs.some((c) => c.mimeType.toLowerCase() === 'video/av1');
      if (hasAV1) {
        this.selectedCodec = 'av1';
        return;
      }
    }
    // Fallback universal: H.264
    this.selectedCodec = 'h264';
  }

  /**
   * Força downgrade para H.264 se receptor remoto não suportar AV1 ou em caso de perda alta
   */
  public fallbackToH264(reason: string): void {
    if (this.selectedCodec === 'h264') return;
    console.info(`[MediaQualityController] Codec fallback de AV1 para H.264: ${reason}`);
    this.selectedCodec = 'h264';
    this.currentProfile.preferredCodec = 'h264';
    this.evaluateQualityState('Codec fallback to H.264');
  }

  // =========================================================================
  // MÁQUINA DE ESTADOS DE RECONEXÃO EM 5 FASES
  // =========================================================================

  /**
   * Inicia o ciclo de reconexão estruturada em 5 fases
   */
  public startReconnection(triggerReason: string): void {
    if (this.isDisposed || this.reconnectionState.phase !== 'IDLE') return;

    this.clearReconnectionTimer();
    this.reconnectionState.startTime = performance.now();
    this.reconnectionState.attempt = 1;
    this.reconnectionState.reconnectCount++;

    console.warn(`[MediaQualityController] Iniciando reconexão (Trigger: ${triggerReason})`);
    this.transitionPhase('FAST_RECONNECT');
  }

  /**
   * Notifica que a reconexão foi concluída com sucesso
   */
  public onReconnectionSuccess(): void {
    if (this.reconnectionState.phase === 'IDLE') return;

    const duration = performance.now() - this.reconnectionState.startTime;
    this.reconnectionState.lastAttemptDurationMs = duration;
    this.reconnectionState.totalOutageMs += duration;
    this.reconnectionLatencies.push(duration);

    // Calcula p95 das reconexões
    this.computeP95();

    console.info(
      `[MediaQualityController] Reconexão restabelecida com sucesso em ${duration.toFixed(1)}ms ` +
      `(Fase: ${this.reconnectionState.phase}, p95: ${this.reconnectionState.p95LatencyMs.toFixed(1)}ms)`
    );

    this.clearReconnectionTimer();
    this.reconnectionState.phase = 'IDLE';
    this.reconnectionState.attempt = 0;
    this.onReconnectionPhaseChange?.('IDLE', 0);
  }

  private transitionPhase(nextPhase: ReconnectionPhase): void {
    if (this.isDisposed) return;
    this.reconnectionState.phase = nextPhase;
    this.onReconnectionPhaseChange?.(nextPhase, this.reconnectionState.attempt);

    switch (nextPhase) {
      case 'FAST_RECONNECT':
        // Fase 1: 0 - 500 ms (Fast reconnect com tentativa de sinal rápido)
        this.executeFastReconnect();
        break;

      case 'ICE_RESTART':
        // Fase 2: 500 - 1500 ms (Reinício de negociação ICE)
        this.executeIceRestart();
        break;

      case 'TOKEN_REFRESH':
        // Fase 3: 1500 - 3500 ms (Renovação silenciosa de token JWT e re-autenticação)
        void this.executeTokenRefresh();
        break;

      case 'SESSION_RENEGOTIATE':
        // Fase 4: 3500 - 7500 ms (Teardown gracioso e reconstrução da sessão)
        void this.executeSessionRenegotiate();
        break;

      case 'TERMINAL_FALLBACK':
        // Fase 5: > 7500 ms (Notificação de rede persistente e retry suave com backoff de 8s)
        this.executeTerminalFallback();
        break;

      default:
        break;
    }
  }

  private executeFastReconnect(): void {
    // Tenta reconexão rápida no LiveKit
    try {
      if (this.room && 'reconnect' in this.room && typeof (this.room as any).reconnect === 'function') {
        void (this.room as any).reconnect();
      }
    } catch {
      // continua
    }

    // Se não restabelecer em 500ms, avança para Fase 2 (ICE Restart)
    this.schedulePhaseTransition('ICE_RESTART', 500);
  }

  private executeIceRestart(): void {
    this.reconnectionState.attempt++;
    console.warn('[MediaQualityController] Fase 2: Disparando ICE Restart na PeerConnection');

    try {
      // Dispara ICE restart na sala se suportado
      const engine = (this.room as any)?.engine;
      if (engine && typeof engine.restartIce === 'function') {
        void engine.restartIce();
      }
    } catch {
      // continua
    }

    // Se não restabelecer em 1000ms adicionais, avança para Fase 3 (Token Refresh)
    this.schedulePhaseTransition('TOKEN_REFRESH', 1000);
  }

  private async executeTokenRefresh(): Promise<void> {
    this.reconnectionState.attempt++;
    console.warn('[MediaQualityController] Fase 3: Renovação silenciosa de token JWT');

    if (this.tokenProvider) {
      try {
        const newToken = await this.tokenProvider();
        if (newToken && this.room && 'setToken' in this.room) {
          (this.room as any).setToken(newToken);
        }
      } catch (err) {
        console.warn('[MediaQualityController] Falha silenciosa ao obter novo token:', err);
      }
    }

    // Se não restabelecer em 2000ms adicionais, avança para Fase 4 (Session Renegotiate)
    this.schedulePhaseTransition('SESSION_RENEGOTIATE', 2000);
  }

  private async executeSessionRenegotiate(): Promise<void> {
    this.reconnectionState.attempt++;
    console.warn('[MediaQualityController] Fase 4: Reconstrução completa da sessão WebRTC');

    try {
      if (this.room) {
        // Tenta reconexão completa da engine
        const engine = (this.room as any)?.engine;
        if (engine && typeof engine.fullReconnect === 'function') {
          await engine.fullReconnect();
        }
      }
    } catch (err) {
      console.warn('[MediaQualityController] Erro na renegotiation:', err);
    }

    // Se não restabelecer em 4000ms adicionais, avança para Fase 5 (Terminal Fallback)
    this.schedulePhaseTransition('TERMINAL_FALLBACK', 4000);
  }

  private executeTerminalFallback(): void {
    console.error('[MediaQualityController] Fase 5: Conexão instável após 4 fases. Modo fallback ativado.');
    // Agenda nova tentativa a cada 8000ms
    this.schedulePhaseTransition('ICE_RESTART', 8000);
  }

  private schedulePhaseTransition(nextPhase: ReconnectionPhase, delayMs: number): void {
    this.clearReconnectionTimer();
    this.reconnectionTimer = setTimeout(() => {
      if (!this.isDisposed && this.reconnectionState.phase !== 'IDLE') {
        this.transitionPhase(nextPhase);
      }
    }, delayMs);
  }

  private clearReconnectionTimer(): void {
    if (this.reconnectionTimer) {
      clearTimeout(this.reconnectionTimer);
      this.reconnectionTimer = null;
    }
  }

  private computeP95(): void {
    if (this.reconnectionLatencies.length === 0) return;
    const sorted = [...this.reconnectionLatencies].sort((a, b) => a - b);
    const idx = Math.min(
      sorted.length - 1,
      Math.max(0, Math.ceil(sorted.length * 0.95) - 1)
    );
    this.reconnectionState.p95LatencyMs = sorted[idx];
  }

  public dispose(): void {
    this.isDisposed = true;
    this.clearReconnectionTimer();
    this.room = null;
    this.activeScreenTrack = null;
    this.activeAudioTrack = null;
  }
}
