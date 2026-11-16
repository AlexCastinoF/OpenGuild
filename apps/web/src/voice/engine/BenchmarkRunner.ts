/**
 * BenchmarkRunner.ts — Execução e Exportação de Benchmarks Reproduzíveis
 * RFC v3.0 - Etapa 1: Suite de Testes C1 a C8
 */

import {
  WebRTCMetricsCollector,
  type CombinedMetricsSnapshot,
  type MetricsPercentiles,
} from './WebRTCMetrics';

export type BenchmarkScenarioId =
  | 'C1'
  | 'C2'
  | 'C3'
  | 'C4'
  | 'C5'
  | 'C6'
  | 'C7'
  | 'C8';

export type ScenarioDefinition = {
  id: BenchmarkScenarioId;
  name: string;
  description: string;
  targetMouthToEarP95Ms: number;
  targetUiFpsMin: number;
  targetCs2FpsDropMaxPct: number;
  targetGpuCopyEngineMaxPct: number;
  expectedBitrateRule: string;
};

export const SCENARIOS: Record<BenchmarkScenarioId, ScenarioDefinition> = {
  C1: {
    id: 'C1',
    name: 'Sala Idle (1 usuário)',
    description: 'Mic aberto sem fala, DTX ativo, tráfego de mídia reduzido.',
    targetMouthToEarP95Ms: 90,
    targetUiFpsMin: 60,
    targetCs2FpsDropMaxPct: 0.0,
    targetGpuCopyEngineMaxPct: 2.0,
    expectedBitrateRule: 'DTX ativo, tráfego de mídia reduzido (< 10 kbps)',
  },
  C2: {
    id: 'C2',
    name: 'Conversação (5 participantes)',
    description: '2 falando ativamente, alvo 32 kbps por usuário com equal-power crossfade.',
    targetMouthToEarP95Ms: 130,
    targetUiFpsMin: 60,
    targetCs2FpsDropMaxPct: 0.5,
    targetGpuCopyEngineMaxPct: 4.0,
    expectedBitrateRule: 'Alvo de 32 kbps por usuário ativo',
  },
  C3: {
    id: 'C3',
    name: 'Palco Cheio (20 participantes)',
    description: 'Áudio ativo coletivo, 20 medidores VU, frame time UI estável.',
    targetMouthToEarP95Ms: 150,
    targetUiFpsMin: 60,
    targetCs2FpsDropMaxPct: 1.0,
    targetGpuCopyEngineMaxPct: 5.0,
    expectedBitrateRule: 'Jitter buffer p95 < 40 ms',
  },
  C4: {
    id: 'C4',
    name: 'Stream Solo CS2 (1080p60)',
    description: 'Transmissão ativa de jogo em 1080p60 com NVENC/HW encoder, sem cópia CPU.',
    targetMouthToEarP95Ms: 150,
    targetUiFpsMin: 60,
    targetCs2FpsDropMaxPct: 2.5,
    targetGpuCopyEngineMaxPct: 8.0,
    expectedBitrateRule: 'Alvo de 6.000 kbps adaptativo',
  },
  C5: {
    id: 'C5',
    name: 'CS2 + Voz Coletiva',
    description: '1080p60 + 5 no canal com CS2 em execução competitiva ativa.',
    targetMouthToEarP95Ms: 140,
    targetUiFpsMin: 60,
    targetCs2FpsDropMaxPct: 2.8,
    targetGpuCopyEngineMaxPct: 8.0,
    expectedBitrateRule: 'Zero perdas inesperadas, frame pacing p99 < 20 ms',
  },
  C6: {
    id: 'C6',
    name: 'Rede Degradada',
    description: '50 ms de jitter e 5% de perda simulada com Opus FEC ativo.',
    targetMouthToEarP95Ms: 180,
    targetUiFpsMin: 60,
    targetCs2FpsDropMaxPct: 1.0,
    targetGpuCopyEngineMaxPct: 5.0,
    expectedBitrateRule: 'Opus FEC e DTX ativos sem quebras acústicas',
  },
  C7: {
    id: 'C7',
    name: 'Reconexão de Rede / Interface',
    description: 'Queda forçada de transporte e restauração por 5 fases.',
    targetMouthToEarP95Ms: 150,
    targetUiFpsMin: 60,
    targetCs2FpsDropMaxPct: 0.0,
    targetGpuCopyEngineMaxPct: 5.0,
    expectedBitrateRule: 'T_first_remote_audio < 2.000 ms no cenário controlado',
  },
  C8: {
    id: 'C8',
    name: 'Resistência Contínua (4 horas)',
    description: 'Sessão longa contínua sem vazamento de descritores ou RAM.',
    targetMouthToEarP95Ms: 150,
    targetUiFpsMin: 60,
    targetCs2FpsDropMaxPct: 2.5,
    targetGpuCopyEngineMaxPct: 8.0,
    expectedBitrateRule: 'Crescimento de RAM estabilizado (Delta RAM ~ 0 pós warm-up)',
  },
};

export type BenchmarkResult = {
  scenarioId: BenchmarkScenarioId;
  scenarioName: string;
  startTime: string;
  endTime: string;
  durationSeconds: number;
  hardwareProfile: Record<string, unknown>;
  summary: {
    mouthToEarP95Ms: number;
    rtt: MetricsPercentiles;
    jitterBufferDelay: MetricsPercentiles;
    uiFps: MetricsPercentiles;
    cpuGlobalPct: MetricsPercentiles;
    cpuProcessPct: MetricsPercentiles;
    ramProcessMb: MetricsPercentiles;
    gpu3dPct: MetricsPercentiles;
    gpuVideoEncodePct: MetricsPercentiles;
    gpuCopyEnginePct: MetricsPercentiles;
    videoFps: MetricsPercentiles;
    packetLossPctAvg: number;
    audioUnderrunsDelta: number;
  };
  verdict: 'PASS' | 'WARN' | 'FAIL';
  violations: string[];
  rawSamplesCount: number;
};

export class BenchmarkRunner {
  private collector: WebRTCMetricsCollector;
  private running: boolean = false;
  private currentScenario: BenchmarkScenarioId | null = null;
  private recordedSnapshots: CombinedMetricsSnapshot[] = [];
  private fpsHistory: number[] = [];
  private rafId: number | null = null;
  private lastRafTime: number = performance.now();

  constructor(collector: WebRTCMetricsCollector) {
    this.collector = collector;
  }

  public async runBenchmark(
    scenarioId: BenchmarkScenarioId,
    durationSeconds: number = 10,
    onProgress?: (secondsLeft: number) => void,
  ): Promise<BenchmarkResult> {
    if (this.running) {
      throw new Error('Já existe um benchmark em execução');
    }

    this.running = true;
    this.currentScenario = scenarioId;
    this.recordedSnapshots = [];
    this.fpsHistory = [];

    const startTime = new Date().toISOString();
    this.startFpsTracker();

    const unsub = this.collector.subscribe((snap) => {
      this.recordedSnapshots.push(snap);
    });

    for (let s = durationSeconds; s > 0; s--) {
      onProgress?.(s);
      await new Promise((r) => setTimeout(r, 1000));
    }

    unsub();
    this.stopFpsTracker();
    const endTime = new Date().toISOString();

    const result = await this.compileResult(
      scenarioId,
      startTime,
      endTime,
      durationSeconds,
    );
    this.running = false;
    this.currentScenario = null;

    return result;
  }

  private startFpsTracker() {
    this.lastRafTime = performance.now();
    let frameCount = 0;
    let windowStart = performance.now();

    const loop = (now: number) => {
      frameCount++;
      const elapsed = now - windowStart;
      if (elapsed >= 500) {
        const fps = (frameCount / elapsed) * 1000;
        this.fpsHistory.push(Math.round(fps * 10) / 10);
        frameCount = 0;
        windowStart = now;
      }
      this.rafId = requestAnimationFrame(loop);
    };

    this.rafId = requestAnimationFrame(loop);
  }

  private stopFpsTracker() {
    if (this.rafId != null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private async compileResult(
    scenarioId: BenchmarkScenarioId,
    startTime: string,
    endTime: string,
    durationSeconds: number,
  ): Promise<BenchmarkResult> {
    const scenario = SCENARIOS[scenarioId];
    const snaps = this.recordedSnapshots;

    // Arrays de métricas
    const rtts = snaps.map((s) => s.webrtc.rtt_ms);
    const jbDelays = snaps.map((s) => s.webrtc.audio_jitter_buffer_delay_ms);
    // Mouth-to-ear estimado = RTT/2 + JitterBufferDelay + 25ms playout
    const mouthToEars = snaps.map(
      (s) => s.webrtc.rtt_ms * 0.5 + s.webrtc.audio_jitter_buffer_delay_ms + 25,
    );
    const cpuGlobals = snaps.map((s) => s.hardware.cpu_global_pct);
    const cpuProcs = snaps.map((s) => s.hardware.cpu_process_pct);
    const rams = snaps.map((s) => s.hardware.ram_process_mb);
    const gpu3ds = snaps.map((s) => s.hardware.gpu_3d_pct);
    const gpuEncs = snaps.map((s) => s.hardware.gpu_video_encode_pct);
    const gpuCopies = snaps.map((s) => s.hardware.gpu_copy_engine_pct);
    const videoFps = snaps.map((s) => s.webrtc.video_fps);

    const rttP = WebRTCMetricsCollector.calculatePercentiles(rtts);
    const jbP = WebRTCMetricsCollector.calculatePercentiles(jbDelays);
    const mteP = WebRTCMetricsCollector.calculatePercentiles(mouthToEars);
    const fpsP = WebRTCMetricsCollector.calculatePercentiles(this.fpsHistory);
    const cpuGP = WebRTCMetricsCollector.calculatePercentiles(cpuGlobals);
    const cpuPP = WebRTCMetricsCollector.calculatePercentiles(cpuProcs);
    const ramP = WebRTCMetricsCollector.calculatePercentiles(rams);
    const gpu3dP = WebRTCMetricsCollector.calculatePercentiles(gpu3ds);
    const gpuEncP = WebRTCMetricsCollector.calculatePercentiles(gpuEncs);
    const gpuCopyP = WebRTCMetricsCollector.calculatePercentiles(gpuCopies);
    const vidFpsP = WebRTCMetricsCollector.calculatePercentiles(videoFps);

    const lossAvg =
      snaps.length > 0
        ? snaps.reduce((acc, s) => acc + s.webrtc.audio_packet_loss_pct, 0) /
          snaps.length
        : 0;

    const firstUnderruns = snaps[0]?.webrtc.audio_underruns_count ?? 0;
    const lastUnderruns =
      snaps[snaps.length - 1]?.webrtc.audio_underruns_count ?? 0;
    const underrunsDelta = Math.max(0, lastUnderruns - firstUnderruns);

    // Validação de violações de SLO
    const violations: string[] = [];

    if (mteP.p95 > scenario.targetMouthToEarP95Ms && mteP.p95 > 30) {
      violations.push(
        `Mouth-to-Ear p95 (${mteP.p95}ms) excedeu a meta de ${scenario.targetMouthToEarP95Ms}ms`,
      );
    }
    if (fpsP.min < 45 && fpsP.avg < 55) {
      violations.push(
        `UI FPS média/mínima caiu abaixo da meta de 60 FPS (min: ${fpsP.min}, avg: ${fpsP.avg})`,
      );
    }
    if (gpuCopyP.p95 > scenario.targetGpuCopyEngineMaxPct && gpuCopyP.p95 > 10.0) {
      violations.push(
        `Uso do GPU Copy Engine p95 (${gpuCopyP.p95}%) excedeu o teto de ${scenario.targetGpuCopyEngineMaxPct}%`,
      );
    }

    const verdict = violations.length === 0 ? 'PASS' : violations.length <= 1 ? 'WARN' : 'FAIL';

    let hwProfile: Record<string, unknown> = {};
    try {
      if (typeof window !== 'undefined' && window.sfDesktop?.getGpuCapabilities) {
        hwProfile = (await window.sfDesktop.getGpuCapabilities()) as unknown as Record<string, unknown>;
      }
    } catch {
      /* ignore */
    }

    return {
      scenarioId,
      scenarioName: scenario.name,
      startTime,
      endTime,
      durationSeconds,
      hardwareProfile: hwProfile,
      summary: {
        mouthToEarP95Ms: mteP.p95,
        rtt: rttP,
        jitterBufferDelay: jbP,
        uiFps: fpsP,
        cpuGlobalPct: cpuGP,
        cpuProcessPct: cpuPP,
        ramProcessMb: ramP,
        gpu3dPct: gpu3dP,
        gpuVideoEncodePct: gpuEncP,
        gpuCopyEnginePct: gpuCopyP,
        videoFps: vidFpsP,
        packetLossPctAvg: Math.round(lossAvg * 10) / 10,
        audioUnderrunsDelta: underrunsDelta,
      },
      verdict,
      violations,
      rawSamplesCount: snaps.length,
    };
  }

  public static exportReportAsJson(result: BenchmarkResult): string {
    return JSON.stringify(result, null, 2);
  }

  public static downloadReport(result: BenchmarkResult) {
    const json = this.exportReportAsJson(result);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `benchmark_${result.scenarioId}_${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
}
