/**
 * PerformancePolicyEngine - RFC v3.0 (Camada 2 - Orquestração & Políticas)
 *
 * Máquina de estados finita de 4 níveis de degradação estruturada com histerese
 * de 5 segundos para prevenção de oscilação ('flapping').
 *
 * Estados:
 * - Nível 0 (FULL_QUALITY): DeepFilterNet 3 / Krisp, Opus 64k, 1080p60.
 * - Nível 1 (MODERATE_STRESS): RNNoise SIMD, Opus 48k, 1080p45.
 * - Nível 2 (HIGH_STRESS): WebRTC NS Bypass nativo, Opus 32k DTX, 720p30.
 * - Nível 3 (CRITICAL_EMERGENCY): RAW Audio Bypass, Opus 24k FEC, Stream Throttled (15 FPS).
 */

import { AudioBudgetMonitor, type AudioBudgetStats } from './AudioBudgetMonitor';
import { CrashDiagnostics } from './CrashDiagnostics';
import type { NoiseEngine } from '../../lib/deepFilterMic';

export type DegradationLevel = 0 | 1 | 2 | 3;

export interface DegradationPolicy {
  level: DegradationLevel;
  name: string;
  noiseEngine: NoiseEngine;
  opusBitrateBps: number;
  dtxEnabled: boolean;
  fecEnabled: boolean;
  maxScreenFps: number;
  screenResolution: '1080p' | '720p';
  description: string;
}

export const POLICIES: Record<DegradationLevel, DegradationPolicy> = {
  0: {
    level: 0,
    name: 'FULL_QUALITY',
    noiseEngine: 'deepfilter',
    opusBitrateBps: 64000,
    dtxEnabled: false,
    fecEnabled: true,
    maxScreenFps: 60,
    screenResolution: '1080p',
    description: 'Qualidade máxima: IA DeepFilterNet 3 e transmissão 1080p60.',
  },
  1: {
    level: 1,
    name: 'MODERATE_STRESS',
    noiseEngine: 'rnnoise',
    opusBitrateBps: 48000,
    dtxEnabled: false,
    fecEnabled: true,
    maxScreenFps: 45,
    screenResolution: '1080p',
    description: 'Estresse moderado: RNNoise SIMD leve e framerate de tela a 45 FPS.',
  },
  2: {
    level: 2,
    name: 'HIGH_STRESS',
    noiseEngine: 'browser',
    opusBitrateBps: 32000,
    dtxEnabled: true,
    fecEnabled: true,
    maxScreenFps: 30,
    screenResolution: '720p',
    description: 'Alto estresse: WebRTC NS nativo (0% de carga JS/WASM) e tela a 720p30.',
  },
  3: {
    level: 3,
    name: 'CRITICAL_EMERGENCY',
    noiseEngine: 'off',
    opusBitrateBps: 24000,
    dtxEnabled: true,
    fecEnabled: true,
    maxScreenFps: 15,
    screenResolution: '720p',
    description: 'Emergência crítica: bypass total de filtros e prioridade absoluta ao jogo.',
  },
};

export type PolicyChangeListener = (newPolicy: DegradationPolicy, oldPolicy: DegradationPolicy) => void;

export class PerformancePolicyEngine {
  private currentLevel: DegradationLevel = 0;
  private readonly listeners = new Set<PolicyChangeListener>();

  private audioBudgetMonitor: AudioBudgetMonitor | null = null;
  private budgetUnsub: (() => void) | null = null;
  private guardianUnsub: (() => void) | null = null;

  // Histerese: requer 5 segundos contínuos de estabilidade para promover o nível
  private lastDowngradeTimestamp = 0;
  private stableCandidateTimestamp = 0;
  private static readonly UPGRADE_HYSTERESIS_MS = 5000;

  // Proteção contra oscilação
  private manualLockLevel: DegradationLevel | null = null;

  constructor(audioBudgetMonitor?: AudioBudgetMonitor) {
    if (audioBudgetMonitor) {
      this.attachBudgetMonitor(audioBudgetMonitor);
    }
  }

  attachBudgetMonitor(monitor: AudioBudgetMonitor): void {
    if (this.budgetUnsub) {
      this.budgetUnsub();
    }
    this.audioBudgetMonitor = monitor;
    this.budgetUnsub = monitor.subscribe((stats) => {
      this.evaluateBudget(stats);
    });
  }

  startListeningNativeGuardian(): void {
    if (typeof window !== 'undefined' && window.sfDesktop?.onGuardianAlert) {
      try {
        this.guardianUnsub = window.sfDesktop.onGuardianAlert((alert) => {
          this.evaluateNativeGuardian(alert);
        });
      } catch {
        /* ignore */
      }
    }
  }

  stop(): void {
    if (this.budgetUnsub) {
      this.budgetUnsub();
      this.budgetUnsub = null;
    }
    if (this.guardianUnsub) {
      this.guardianUnsub();
      this.guardianUnsub = null;
    }
  }

  get currentPolicy(): DegradationPolicy {
    return POLICIES[this.currentLevel];
  }

  get level(): DegradationLevel {
    return this.currentLevel;
  }

  /**
   * Avalia as métricas de orçamento do AudioWorklet.
   */
  private evaluateBudget(stats: AudioBudgetStats): void {
    if (this.manualLockLevel !== null) return;

    const now = performance.now();

    // 1. Condição de Rebaixamento Rápido (< 50 ms):
    // Se o uso de orçamento p95 ultrapassar 75% ou houver deadline misses consecutivos
    if (stats.deadlineMisses > 2 || stats.budgetUtilizationP95Pct >= 75.0) {
      if (this.currentLevel < 3) {
        const nextLevel = (this.currentLevel + 1) as DegradationLevel;
        this.transitionTo(nextLevel, `Audio budget pressure (p95: ${stats.budgetUtilizationP95Pct}%, misses: ${stats.deadlineMisses})`);
        this.lastDowngradeTimestamp = now;
        this.stableCandidateTimestamp = 0;
        return;
      }
    }

    // 2. Condição de Promoção com Histerese (5 segundos estáveis):
    // Orçamento p95 abaixo de 45% e zero deadline misses
    if (stats.budgetUtilizationP95Pct < 45.0 && stats.deadlineMisses === 0) {
      if (this.currentLevel > 0) {
        if (this.stableCandidateTimestamp === 0) {
          this.stableCandidateTimestamp = now;
        } else if (now - this.stableCandidateTimestamp >= PerformancePolicyEngine.UPGRADE_HYSTERESIS_MS) {
          // 5 segundos decorridos com estabilidade contínua!
          const prevLevel = (this.currentLevel - 1) as DegradationLevel;
          this.transitionTo(prevLevel, `Stability window satisfied (p95: ${stats.budgetUtilizationP95Pct}% for 5s)`);
          this.stableCandidateTimestamp = now;
        }
      }
    } else {
      // Qualquer flutuação reseta o temporizador de histerese
      this.stableCandidateTimestamp = 0;
    }
  }

  /**
   * Avalia os alertas do PerformanceGuardian nativo (Rust).
   */
  private evaluateNativeGuardian(alert: {
    pressure_level: string;
    cpu_global_pct: number;
    cs2_running: boolean;
  }): void {
    if (this.manualLockLevel !== null) return;

    const now = performance.now();
    const levelStr = alert.pressure_level.toLowerCase();

    if (levelStr === 'critical') {
      // Rebaixamento imediato para Nível 3
      if (this.currentLevel !== 3) {
        this.transitionTo(3, `PerformanceGuardian CRITICAL (CPU: ${alert.cpu_global_pct.toFixed(1)}%)`);
        this.lastDowngradeTimestamp = now;
        this.stableCandidateTimestamp = 0;
      }
    } else if (levelStr === 'high') {
      // Rebaixamento para Nível 2
      if (this.currentLevel < 2) {
        this.transitionTo(2, `PerformanceGuardian HIGH (CPU: ${alert.cpu_global_pct.toFixed(1)}%)`);
        this.lastDowngradeTimestamp = now;
        this.stableCandidateTimestamp = 0;
      }
    } else if (levelStr === 'moderate') {
      // Rebaixamento para Nível 1
      if (this.currentLevel < 1) {
        this.transitionTo(1, `PerformanceGuardian MODERATE (CPU: ${alert.cpu_global_pct.toFixed(1)}%)`);
        this.lastDowngradeTimestamp = now;
        this.stableCandidateTimestamp = 0;
      }
    }
  }

  forceLevel(level: DegradationLevel, reason = 'manual_override'): void {
    this.manualLockLevel = level;
    this.transitionTo(level, reason);
  }

  clearForceLevel(): void {
    this.manualLockLevel = null;
  }

  private transitionTo(newLevel: DegradationLevel, reason: string): void {
    if (this.currentLevel === newLevel) return;

    const oldPolicy = POLICIES[this.currentLevel];
    const newPolicy = POLICIES[newLevel];
    this.currentLevel = newLevel;

    CrashDiagnostics.instance.record('hardware', 'warn', 'policy_engine_level_changed', {
      from: oldPolicy.level,
      to: newPolicy.level,
      policyName: newPolicy.name,
      reason,
    });

    this.listeners.forEach((fn) => fn(newPolicy, oldPolicy));
  }

  subscribe(listener: PolicyChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
