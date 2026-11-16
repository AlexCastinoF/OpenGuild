/**
 * FilterCrossfader - RFC v3.0 (Camada 2 / Camada 3 - Processamento de Áudio)
 *
 * Implementa transição suave e inaudível entre processadores de áudio (filtros de ruído)
 * utilizando curva equal-power (cos/sin de 20 ms), alinhamento de latência interna
 * via DelayNode e proteção contra clipping por Peak Limiter dinâmico.
 *
 * Fórmulas:
 *   g_A(t) = cos( (pi / 2) * (t / T) )
 *   g_B(t) = sin( (pi / 2) * (t / T) )
 *   g_A^2(t) + g_B^2(t) = 1 (Preservação de potência acústica contínua)
 */

import { CrashDiagnostics } from './CrashDiagnostics';

export interface FilterBranch {
  node: AudioNode;
  gainNode: GainNode;
  delayNode: DelayNode;
  latencyMs: number;
  engineName: string;
}

export class FilterCrossfader {
  private readonly ctx: AudioContext;
  private readonly inputNode: GainNode;
  private readonly outputNode: GainNode;
  private readonly limiterNode: DynamicsCompressorNode;

  private currentBranch: FilterBranch | null = null;
  private targetBranch: FilterBranch | null = null;
  private isTransitioning = false;

  // Precomputed curves for 20ms equal-power crossfade (128 sample points)
  private static readonly CURVE_POINTS = 128;
  private static readonly FADE_OUT_CURVE: Float32Array = (() => {
    const arr = new Float32Array(FilterCrossfader.CURVE_POINTS);
    for (let i = 0; i < FilterCrossfader.CURVE_POINTS; i++) {
      const frac = i / (FilterCrossfader.CURVE_POINTS - 1);
      arr[i] = Math.cos((Math.PI / 2) * frac);
    }
    return arr;
  })();

  private static readonly FADE_IN_CURVE: Float32Array = (() => {
    const arr = new Float32Array(FilterCrossfader.CURVE_POINTS);
    for (let i = 0; i < FilterCrossfader.CURVE_POINTS; i++) {
      const frac = i / (FilterCrossfader.CURVE_POINTS - 1);
      arr[i] = Math.sin((Math.PI / 2) * frac);
    }
    return arr;
  })();

  constructor(ctx: AudioContext) {
    this.ctx = ctx;

    // Nó de entrada mestre
    this.inputNode = ctx.createGain();
    this.inputNode.gain.setValueAtTime(1.0, ctx.currentTime);

    // Peak Limiter dinâmico pós-cruzamento (RFC v3.0 - Item 1.2)
    // Previne qualquer pico > 0 dBFS gerado por desalinhamento transitório de fase
    this.limiterNode = ctx.createDynamicsCompressor();
    this.limiterNode.threshold.setValueAtTime(-0.5, ctx.currentTime); // -0.5 dB
    this.limiterNode.knee.setValueAtTime(3.0, ctx.currentTime);
    this.limiterNode.ratio.setValueAtTime(20.0, ctx.currentTime); // Hard limiting
    this.limiterNode.attack.setValueAtTime(0.001, ctx.currentTime); // 1 ms
    this.limiterNode.release.setValueAtTime(0.040, ctx.currentTime); // 40 ms

    // Nó de saída mestre
    this.outputNode = ctx.createGain();
    this.outputNode.gain.setValueAtTime(1.0, ctx.currentTime);

    this.limiterNode.connect(this.outputNode);
  }

  get input(): AudioNode {
    return this.inputNode;
  }

  get output(): AudioNode {
    return this.outputNode;
  }

  get currentEngine(): string | null {
    return this.currentBranch?.engineName ?? null;
  }

  /**
   * Inicializa o primeiro ramo de processamento sem crossfade.
   */
  setInitialBranch(node: AudioNode, latencyMs = 0, engineName = 'initial'): void {
    if (this.currentBranch) {
      this.disconnectBranch(this.currentBranch);
    }

    const gainNode = this.ctx.createGain();
    gainNode.gain.setValueAtTime(1.0, this.ctx.currentTime);

    const delayNode = this.ctx.createDelay(0.1); // buffer máx 100ms
    delayNode.delayTime.setValueAtTime(0, this.ctx.currentTime);

    // Encadeamento: input -> node -> delayNode -> gainNode -> limiterNode
    this.inputNode.connect(node);
    node.connect(delayNode);
    delayNode.connect(gainNode);
    gainNode.connect(this.limiterNode);

    this.currentBranch = {
      node,
      gainNode,
      delayNode,
      latencyMs,
      engineName,
    };
  }

  /**
   * Executa transição equal-power com compensação de atraso algorítmico entre dois filtros.
   *
   * @param newNode Nó de áudio do novo filtro de ruído
   * @param targetLatencyMs Latência algorítmica interna do novo filtro em milissegundos
   * @param engineName Nome identificador do motor
   * @param durationSec Duração da janela de crossfade (padrão: 0.020s = 20ms)
   */
  async crossfadeTo(
    newNode: AudioNode,
    targetLatencyMs: number,
    engineName: string,
    durationSec = 0.020,
  ): Promise<void> {
    if (this.isTransitioning && this.targetBranch) {
      // Se já estava em transição, cancela o target anterior imediatamente
      this.disconnectBranch(this.targetBranch);
      this.targetBranch = null;
    }

    if (!this.currentBranch) {
      this.setInitialBranch(newNode, targetLatencyMs, engineName);
      return;
    }

    this.isTransitioning = true;
    const now = this.ctx.currentTime;

    // 1. Cria nós de controle para o novo ramo
    const targetGain = this.ctx.createGain();
    targetGain.gain.setValueAtTime(0.0, now);

    const targetDelay = this.ctx.createDelay(0.1);
    const currDelay = this.currentBranch.delayNode;

    // 2. Alinhamento de Latência Interna (RFC v3.0 - Item 1.2)
    // Se o filtro A tem maior latência que o filtro B, atrasamos o mais rápido
    // para evitar filtro pente (comb filtering) e cancelamento destrutivo de fase.
    const latencyDiffMs = this.currentBranch.latencyMs - targetLatencyMs;
    if (latencyDiffMs > 0) {
      // O atual é mais lento; atrasamos o novo
      targetDelay.delayTime.setValueAtTime(latencyDiffMs / 1000.0, now);
      currDelay.delayTime.setValueAtTime(0, now);
    } else if (latencyDiffMs < 0) {
      // O novo é mais lento; atrasamos o atual durante a transição
      currDelay.delayTime.setValueAtTime(Math.abs(latencyDiffMs) / 1000.0, now);
      targetDelay.delayTime.setValueAtTime(0, now);
    } else {
      currDelay.delayTime.setValueAtTime(0, now);
      targetDelay.delayTime.setValueAtTime(0, now);
    }

    // 3. Conecta o novo ramo no grafo
    this.inputNode.connect(newNode);
    newNode.connect(targetDelay);
    targetDelay.connect(targetGain);
    targetGain.connect(this.limiterNode);

    this.targetBranch = {
      node: newNode,
      gainNode: targetGain,
      delayNode: targetDelay,
      latencyMs: targetLatencyMs,
      engineName,
    };

    // 4. Aplica curvas Equal-Power simultaneamente
    // g_A: cos( (pi/2) * (t/T) ) de 1 a 0
    // g_B: sin( (pi/2) * (t/T) ) de 0 a 1
    const currGain = this.currentBranch.gainNode;
    currGain.gain.setValueCurveAtTime(FilterCrossfader.FADE_OUT_CURVE, now, durationSec);
    targetGain.gain.setValueCurveAtTime(FilterCrossfader.FADE_IN_CURVE, now, durationSec);

    // 5. Aguarda o término da janela de crossfade + margem de segurança (5ms)
    await new Promise<void>((resolve) => {
      window.setTimeout(() => {
        try {
          if (this.currentBranch) {
            this.disconnectBranch(this.currentBranch);
          }
          this.currentBranch = this.targetBranch;
          this.targetBranch = null;

          // Reseta delays para operação em regime estacionário
          if (this.currentBranch) {
            this.currentBranch.delayNode.delayTime.setValueAtTime(0, this.ctx.currentTime);
            this.currentBranch.gainNode.gain.setValueAtTime(1.0, this.ctx.currentTime);
          }

          CrashDiagnostics.instance.record('audio', 'info', 'filter_crossfade_completed', {
            toEngine: engineName,
            latencyMs: targetLatencyMs,
            durationMs: durationSec * 1000,
          });
        } catch (err) {
          CrashDiagnostics.instance.record('audio', 'warn', 'filter_crossfade_error', {
            error: String(err),
          });
        } finally {
          this.isTransitioning = false;
          resolve();
        }
      }, (durationSec * 1000) + 5);
    });
  }

  private disconnectBranch(branch: FilterBranch): void {
    try {
      this.inputNode.disconnect(branch.node);
    } catch {
      /* ignore */
    }
    try {
      branch.node.disconnect();
    } catch {
      /* ignore */
    }
    try {
      branch.delayNode.disconnect();
    } catch {
      /* ignore */
    }
    try {
      branch.gainNode.disconnect();
    } catch {
      /* ignore */
    }
  }

  dispose(): void {
    if (this.currentBranch) {
      this.disconnectBranch(this.currentBranch);
      this.currentBranch = null;
    }
    if (this.targetBranch) {
      this.disconnectBranch(this.targetBranch);
      this.targetBranch = null;
    }
    try {
      this.inputNode.disconnect();
      this.limiterNode.disconnect();
      this.outputNode.disconnect();
    } catch {
      /* ignore */
    }
  }
}
