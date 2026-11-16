/**
 * AudioBudgetMonitor - RFC v3.0 (Camada 2 - Orquestração & Monitoramento)
 *
 * Monitora o orçamento temporal por bloco de áudio no AudioWorklet.
 * Fórmula do orçamento: T_bloco = blockSize / sampleRate (ex: 128 / 48000 = 2,67 ms).
 * Coleta sinais numéricos compactos via MessagePort para zero alocação na thread de áudio
 * e calcula percentis (p50, p95, p99), deadline misses e glitches.
 */

import { CrashDiagnostics } from './CrashDiagnostics';

export interface AudioBlockTelemetry {
  execUs: number;
  blockSize: number;
  sampleRate: number;
  isMiss: boolean;
}

export interface AudioBudgetStats {
  blockSize: number;
  sampleRate: number;
  blockBudgetMs: number;
  execTimeP50Ms: number;
  execTimeP95Ms: number;
  execTimeP99Ms: number;
  execTimeAvgMs: number;
  execTimeMaxMs: number;
  budgetUtilizationP95Pct: number;
  totalBlocks: number;
  deadlineMisses: number;
  deadlineMissRatePct: number;
  glitchesDetected: number;
  isOverBudget: boolean;
}

export type AudioBudgetListener = (stats: AudioBudgetStats) => void;

export class AudioBudgetMonitor {
  private static readonly WINDOW_SIZE = 120; // Janela deslizante de ~320ms de áudio
  private readonly history: number[] = [];
  private totalBlocks = 0;
  private deadlineMisses = 0;
  private glitches = 0;

  private currentBlockSize = 128;
  private currentSampleRate = 48000;
  private lastAlertMs = 0;

  private readonly listeners = new Set<AudioBudgetListener>();

  /**
   * Conecta a porta de comunicação (MessagePort) de um nó AudioWorkletNode.
   */
  attachWorkletPort(port: MessagePort): () => void {
    const handler = (event: MessageEvent<AudioBlockTelemetry | [number, number, number, number]>) => {
      let data: AudioBlockTelemetry;
      if (Array.isArray(event.data)) {
        // Formato array compacto: [execUs, blockSize, sampleRate, isMiss (0 ou 1)]
        data = {
          execUs: event.data[0],
          blockSize: event.data[1] || 128,
          sampleRate: event.data[2] || 48000,
          isMiss: event.data[3] === 1,
        };
      } else {
        data = event.data;
      }
      this.recordBlock(data);
    };

    port.addEventListener('message', handler);
    port.start();

    return () => {
      port.removeEventListener('message', handler);
    };
  }

  recordBlock(telemetry: AudioBlockTelemetry): void {
    this.totalBlocks += 1;
    this.currentBlockSize = telemetry.blockSize || 128;
    this.currentSampleRate = telemetry.sampleRate || 48000;

    const execMs = telemetry.execUs / 1000.0;
    const budgetMs = (this.currentBlockSize / this.currentSampleRate) * 1000.0;

    this.history.push(execMs);
    if (this.history.length > AudioBudgetMonitor.WINDOW_SIZE) {
      this.history.shift();
    }

    if (telemetry.isMiss || execMs > budgetMs) {
      this.deadlineMisses += 1;
      this.glitches += 1;

      const now = performance.now();
      if (now - this.lastAlertMs > 2000) {
        this.lastAlertMs = now;
        CrashDiagnostics.instance.record('audio', 'warn', 'audio_deadline_miss_detected', {
          execMs: parseFloat(execMs.toFixed(3)),
          budgetMs: parseFloat(budgetMs.toFixed(3)),
          totalMisses: this.deadlineMisses,
        });
      }
    }

    // Notifica ouvintes a cada 10 blocos (~26ms) para baixo overhead
    if (this.totalBlocks % 10 === 0 && this.listeners.size > 0) {
      const stats = this.getStats();
      this.listeners.forEach((fn) => fn(stats));
    }
  }

  getStats(): AudioBudgetStats {
    const budgetMs = (this.currentBlockSize / this.currentSampleRate) * 1000.0;

    if (this.history.length === 0) {
      return {
        blockSize: this.currentBlockSize,
        sampleRate: this.currentSampleRate,
        blockBudgetMs: budgetMs,
        execTimeP50Ms: 0,
        execTimeP95Ms: 0,
        execTimeP99Ms: 0,
        execTimeAvgMs: 0,
        execTimeMaxMs: 0,
        budgetUtilizationP95Pct: 0,
        totalBlocks: this.totalBlocks,
        deadlineMisses: this.deadlineMisses,
        deadlineMissRatePct: 0,
        glitchesDetected: this.glitches,
        isOverBudget: false,
      };
    }

    const sorted = [...this.history].sort((a, b) => a - b);
    const p50 = this.percentile(sorted, 50);
    const p95 = this.percentile(sorted, 95);
    const p99 = this.percentile(sorted, 99);
    const sum = sorted.reduce((acc, v) => acc + v, 0);
    const avg = sum / sorted.length;
    const max = sorted[sorted.length - 1];

    const budgetUtilizationP95Pct = (p95 / budgetMs) * 100.0;
    const isOverBudget = budgetUtilizationP95Pct >= 70.0 || this.deadlineMisses > 0;
    const missRatePct =
      this.totalBlocks > 0 ? (this.deadlineMisses / this.totalBlocks) * 100.0 : 0;

    return {
      blockSize: this.currentBlockSize,
      sampleRate: this.currentSampleRate,
      blockBudgetMs: parseFloat(budgetMs.toFixed(3)),
      execTimeP50Ms: parseFloat(p50.toFixed(3)),
      execTimeP95Ms: parseFloat(p95.toFixed(3)),
      execTimeP99Ms: parseFloat(p99.toFixed(3)),
      execTimeAvgMs: parseFloat(avg.toFixed(3)),
      execTimeMaxMs: parseFloat(max.toFixed(3)),
      budgetUtilizationP95Pct: parseFloat(budgetUtilizationP95Pct.toFixed(1)),
      totalBlocks: this.totalBlocks,
      deadlineMisses: this.deadlineMisses,
      deadlineMissRatePct: parseFloat(missRatePct.toFixed(2)),
      glitchesDetected: this.glitches,
      isOverBudget,
    };
  }

  subscribe(listener: AudioBudgetListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  reset(): void {
    this.history.length = 0;
    this.totalBlocks = 0;
    this.deadlineMisses = 0;
    this.glitches = 0;
  }

  private percentile(sorted: number[], pct: number): number {
    if (sorted.length === 0) return 0;
    const idx = Math.min(
      Math.floor((pct / 100.0) * sorted.length),
      sorted.length - 1,
    );
    return sorted[idx];
  }
}
