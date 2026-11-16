/**
 * DeviceRecoveryManager - RFC v3.0 (Camada 2 - Orquestração)
 *
 * Resiliência e recuperação independente por subsistema:
 * 1. Microfone
 * 2. Headset
 * 3. Endpoint Padrão
 * 4. Dispositivos Bluetooth
 * 5. Captura WASAPI
 * 6. Contexto Gráfico (D3D11)
 * 7. Frame Pool WGC
 * 8. Encoder de Vídeo (NVENC)
 *
 * REGRA ARQUITETURAL: A recuperação de um subsistema NUNCA reinicia os demais
 * sem necessidade técnica comprovada (ex: queda de microfone não afeta gráficos nem tela).
 */

import { CrashDiagnostics } from './CrashDiagnostics';

export type SubsystemType =
  | 'mic'
  | 'headset'
  | 'default_endpoint'
  | 'bluetooth'
  | 'wasapi'
  | 'graphics'
  | 'wgc'
  | 'encoder';

export type SubsystemHealthState = 'healthy' | 'degraded' | 'recovering' | 'failed';

export interface SubsystemHealthInfo {
  type: SubsystemType;
  state: SubsystemHealthState;
  recoveryAttempts: number;
  lastRecoveredAt?: string;
  error?: string;
}

export interface DeviceRecoveryCallbacks {
  onInputDeviceLost: (preferredFallbackId: string, availableDevices: MediaDeviceInfo[]) => void | Promise<void>;
  onPreferredInputReconnected: (deviceId: string) => void | Promise<void>;
  onOutputDeviceLost: (preferredFallbackId: string, availableDevices: MediaDeviceInfo[]) => void | Promise<void>;
  onPreferredOutputReconnected: (deviceId: string) => void | Promise<void>;
  onTrackMutedAnomaly: (track: MediaStreamTrack) => void | Promise<void>;
  onBluetoothProfileShift?: (sampleRate: number) => void;
  onGraphicsContextReset?: () => void | Promise<void>;
  onWgcFramePoolLost?: () => void | Promise<void>;
  onEncoderFailure?: (error: string) => void | Promise<void>;
}

export class DeviceRecoveryManager {
  private activeInputId: string = 'default';
  private preferredInputId: string = 'default';
  private activeOutputId: string = 'default';
  private preferredOutputId: string = 'default';

  private readonly callbacks: DeviceRecoveryCallbacks;
  private readonly subsystemStates = new Map<SubsystemType, SubsystemHealthInfo>();

  private debounceTimer: number | null = null;
  private isListening = false;
  private watchedTrack: MediaStreamTrack | null = null;
  private trackMuteTimeout: number | null = null;
  private nativeUnlisten: (() => void) | null = null;

  constructor(callbacks: DeviceRecoveryCallbacks) {
    this.callbacks = callbacks;

    const allSubsystems: SubsystemType[] = [
      'mic',
      'headset',
      'default_endpoint',
      'bluetooth',
      'wasapi',
      'graphics',
      'wgc',
      'encoder',
    ];

    for (const sub of allSubsystems) {
      this.subsystemStates.set(sub, {
        type: sub,
        state: 'healthy',
        recoveryAttempts: 0,
      });
    }
  }

  start(): void {
    if (this.isListening) return;
    this.isListening = true;

    if (typeof navigator !== 'undefined' && navigator.mediaDevices?.addEventListener) {
      navigator.mediaDevices.addEventListener('devicechange', this.handleDeviceChange);
      CrashDiagnostics.instance.record('device', 'info', 'recovery_manager_started');
    }

    // Escuta eventos nativos de recuperação emitidos pelo Rust
    if (typeof window !== 'undefined' && window.sfDesktop?.onSubsystemRecovery) {
      try {
        this.nativeUnlisten = window.sfDesktop.onSubsystemRecovery((data) => {
          this.handleNativeRecoveryEvent(data);
        });
      } catch {
        /* ignore */
      }
    }
  }

  stop(): void {
    if (!this.isListening) return;
    this.isListening = false;

    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.trackMuteTimeout !== null) {
      window.clearTimeout(this.trackMuteTimeout);
      this.trackMuteTimeout = null;
    }

    if (typeof navigator !== 'undefined' && navigator.mediaDevices?.removeEventListener) {
      navigator.mediaDevices.removeEventListener('devicechange', this.handleDeviceChange);
    }

    if (this.nativeUnlisten) {
      this.nativeUnlisten();
      this.nativeUnlisten = null;
    }

    this.unwatchTrack();
    CrashDiagnostics.instance.record('device', 'info', 'recovery_manager_stopped');
  }

  setActiveDevices(
    input: { activeId: string; preferredId?: string },
    output?: { activeId: string; preferredId?: string },
  ): void {
    this.activeInputId = input.activeId || 'default';
    this.preferredInputId = input.preferredId || this.activeInputId;

    if (output) {
      this.activeOutputId = output.activeId || 'default';
      this.preferredOutputId = output.preferredId || this.activeOutputId;
    }
  }

  /**
   * Monitora uma trilha de microfone ativa para detecção de silenciamento de hardware
   * e queda de perfil Bluetooth.
   */
  watchInputTrack(track: MediaStreamTrack): void {
    this.unwatchTrack();
    this.watchedTrack = track;

    const onMute = () => {
      CrashDiagnostics.instance.record('device', 'warn', 'input_track_muted_by_system', {
        trackId: track.id,
        label: track.label,
        readyState: track.readyState,
      });

      if (this.trackMuteTimeout !== null) window.clearTimeout(this.trackMuteTimeout);
      this.trackMuteTimeout = window.setTimeout(() => {
        if (track.readyState === 'live' && track.muted) {
          CrashDiagnostics.instance.record('device', 'warn', 'triggering_mute_anomaly_recovery', {
            trackId: track.id,
          });
          void this.triggerSubsystemRecovery('mic', 'track_muted_anomaly', () =>
            this.callbacks.onTrackMutedAnomaly(track),
          );
        }
      }, 800);
    };

    const onUnmute = () => {
      if (this.trackMuteTimeout !== null) {
        window.clearTimeout(this.trackMuteTimeout);
        this.trackMuteTimeout = null;
      }
      CrashDiagnostics.instance.record('device', 'info', 'input_track_unmuted', {
        trackId: track.id,
      });
    };

    const onEnded = () => {
      CrashDiagnostics.instance.record('device', 'warn', 'input_track_ended_unexpectedly', {
        trackId: track.id,
        label: track.label,
      });
      this.triggerCheck();
    };

    track.addEventListener('mute', onMute);
    track.addEventListener('unmute', onUnmute);
    track.addEventListener('ended', onEnded);

    this.checkTrackSampleRate(track);
  }

  private unwatchTrack(): void {
    if (this.watchedTrack) {
      this.watchedTrack = null;
    }
    if (this.trackMuteTimeout !== null) {
      window.clearTimeout(this.trackMuteTimeout);
      this.trackMuteTimeout = null;
    }
  }

  private checkTrackSampleRate(track: MediaStreamTrack): void {
    try {
      const settings = track.getSettings?.();
      if (settings?.sampleRate && settings.sampleRate < 24000) {
        CrashDiagnostics.instance.record('device', 'warn', 'bluetooth_narrowband_profile_detected', {
          sampleRate: settings.sampleRate,
          label: track.label,
        });
        this.updateSubsystemHealth('bluetooth', 'degraded', 'narrowband_sample_rate');
        this.callbacks.onBluetoothProfileShift?.(settings.sampleRate);
      } else {
        this.updateSubsystemHealth('bluetooth', 'healthy');
      }
    } catch {
      /* ignore */
    }
  }

  private handleDeviceChange = (): void => {
    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = null;
      void this.evaluateDevices();
    }, 400);
  };

  triggerCheck(): void {
    void this.evaluateDevices();
  }

  /**
   * Executa a recuperação isolada de um subsistema específico.
   * Não afeta nenhum outro subsistema em operação.
   */
  async triggerSubsystemRecovery(
    subsystem: SubsystemType,
    reason: string,
    action: () => Promise<void> | void,
  ): Promise<void> {
    const info = this.subsystemStates.get(subsystem);
    if (info && info.state === 'recovering') {
      // Já está em processo de recuperação
      return;
    }

    this.updateSubsystemHealth(subsystem, 'recovering', reason);
    CrashDiagnostics.instance.record('recovery', 'warn', `recovering_subsystem:${subsystem}`, {
      reason,
      attempt: (info?.recoveryAttempts || 0) + 1,
    });

    try {
      await action();
      this.updateSubsystemHealth(subsystem, 'healthy');
      CrashDiagnostics.instance.record('recovery', 'info', `recovered_subsystem:${subsystem}`);
    } catch (err) {
      this.updateSubsystemHealth(subsystem, 'failed', String(err));
      CrashDiagnostics.instance.record('recovery', 'error', `recovery_failed:${subsystem}`, {
        error: String(err),
      });
      throw err;
    }
  }

  private updateSubsystemHealth(subsystem: SubsystemType, state: SubsystemHealthState, errorOrReason?: string): void {
    const current = this.subsystemStates.get(subsystem);
    if (!current) return;

    current.state = state;
    if (state === 'recovering') {
      current.recoveryAttempts += 1;
    } else if (state === 'healthy') {
      current.lastRecoveredAt = new Date().toISOString();
      current.error = undefined;
    } else if (state === 'failed') {
      current.error = errorOrReason;
    }
  }

  private handleNativeRecoveryEvent(data: { subsystem: string; state: string; timestamp_ms: number }): void {
    CrashDiagnostics.instance.record('recovery', 'info', 'native_subsystem_recovery_event', data);

    const subName = data.subsystem.toLowerCase();
    if (subName.includes('graphics') && data.state === 'healthy') {
      void this.callbacks.onGraphicsContextReset?.();
    } else if (subName.includes('framepool') && data.state === 'healthy') {
      void this.callbacks.onWgcFramePoolLost?.();
    } else if (subName.includes('encoder') && data.state === 'failed') {
      void this.callbacks.onEncoderFailure?.(data.state);
    }
  }

  private async evaluateDevices(): Promise<void> {
    if (!navigator.mediaDevices?.enumerateDevices) return;

    try {
      const allDevices = await navigator.mediaDevices.enumerateDevices();
      const inputs = allDevices.filter((d) => d.kind === 'audioinput');
      const outputs = allDevices.filter((d) => d.kind === 'audiooutput');

      CrashDiagnostics.instance.record('device', 'info', 'devices_enumerated', {
        inputsCount: inputs.length,
        outputsCount: outputs.length,
      });

      // 1. Avalia isoladamente a entrada de áudio (microfone)
      const hasActiveInput =
        this.activeInputId === 'default' ||
        inputs.some((d) => d.deviceId === this.activeInputId);

      const hasPreferredInput =
        this.preferredInputId !== 'default' &&
        this.preferredInputId !== this.activeInputId &&
        inputs.some((d) => d.deviceId === this.preferredInputId);

      if (!hasActiveInput) {
        const fallback = inputs[0]?.deviceId || 'default';
        CrashDiagnostics.instance.record('device', 'warn', 'active_input_lost', {
          lostId: this.activeInputId,
          fallbackId: fallback,
        });
        await this.triggerSubsystemRecovery('mic', 'active_input_lost', () =>
          this.callbacks.onInputDeviceLost(fallback, inputs),
        );
      } else if (hasPreferredInput) {
        CrashDiagnostics.instance.record('device', 'info', 'preferred_input_reconnected', {
          preferredId: this.preferredInputId,
        });
        await this.triggerSubsystemRecovery('mic', 'preferred_input_reconnected', () =>
          this.callbacks.onPreferredInputReconnected(this.preferredInputId),
        );
      }

      // 2. Avalia isoladamente a saída de áudio (headset/speaker)
      const hasActiveOutput =
        this.activeOutputId === 'default' ||
        outputs.some((d) => d.deviceId === this.activeOutputId);

      const hasPreferredOutput =
        this.preferredOutputId !== 'default' &&
        this.preferredOutputId !== this.activeOutputId &&
        outputs.some((d) => d.deviceId === this.preferredOutputId);

      if (!hasActiveOutput) {
        const fallback = outputs[0]?.deviceId || 'default';
        CrashDiagnostics.instance.record('device', 'warn', 'active_output_lost', {
          lostId: this.activeOutputId,
          fallbackId: fallback,
        });
        await this.triggerSubsystemRecovery('headset', 'active_output_lost', () =>
          this.callbacks.onOutputDeviceLost(fallback, outputs),
        );
      } else if (hasPreferredOutput) {
        CrashDiagnostics.instance.record('device', 'info', 'preferred_output_reconnected', {
          preferredId: this.preferredOutputId,
        });
        await this.triggerSubsystemRecovery('headset', 'preferred_output_reconnected', () =>
          this.callbacks.onPreferredOutputReconnected(this.preferredOutputId),
        );
      }
    } catch (err) {
      CrashDiagnostics.instance.record('device', 'error', 'evaluate_devices_error', {
        error: String(err),
      });
    }
  }

  getSubsystemStatuses(): SubsystemHealthInfo[] {
    return Array.from(this.subsystemStates.values());
  }

  dispose(): void {
    this.stop();
  }
}
