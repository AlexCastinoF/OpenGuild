/**
 * ResourceLifecycleManager - RFC v3.0 (Camada 2 - Orquestração)
 *
 * Gerencia aquisição cooperativa e descarte de recursos de mídia
 * com proteção estrita por timeout de 2.000 ms e isolamento contra vazamentos.
 */

import { CrashDiagnostics } from './CrashDiagnostics';

export type DisposableResource =
  | MediaStream
  | MediaStreamTrack
  | AudioContext
  | AudioNode
  | { close: () => void | Promise<void> }
  | { stop: () => void | Promise<void> }
  | { disconnect: () => void }
  | { dispose: () => void | Promise<void> }
  | (() => void | Promise<void>);

export interface ManagedAcquisitionOptions {
  label: string;
  timeoutMs?: number;
}

export class ResourceLifecycleManager {
  private readonly id: string;
  private readonly resources = new Set<DisposableResource>();
  private activeAbortController: AbortController | null = null;
  private isDisposed = false;

  constructor(id = 'default') {
    this.id = id;
  }

  /**
   * Executa uma tarefa de aquisição assíncrona com cancelamento cooperativo
   * e timeout garantido de 2.000 ms.
   * Se uma nova aquisição for iniciada antes da anterior concluir, a anterior
   * é abortada imediatamente via AbortSignal.
   */
  async acquire<T>(
    task: (signal: AbortSignal) => Promise<T>,
    options: ManagedAcquisitionOptions,
  ): Promise<T> {
    if (this.isDisposed) {
      throw new Error(`[ResourceLifecycleManager:${this.id}] Cannot acquire on disposed manager`);
    }

    // Aborta aquisição em voo se houver
    if (this.activeAbortController) {
      CrashDiagnostics.instance.record(
        'lifecycle',
        'info',
        `aborting_previous_acquisition:${this.id}`,
        { label: options.label },
      );
      this.activeAbortController.abort('Superceded by new acquisition');
    }

    const abortController = new AbortController();
    this.activeAbortController = abortController;
    const timeoutMs = options.timeoutMs ?? 2000;

    let timeoutId: number | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = window.setTimeout(() => {
        abortController.abort(`Acquisition timeout after ${timeoutMs}ms`);
        const err = new Error(
          `[ResourceLifecycleManager:${this.id}] Acquisition "${options.label}" timed out after ${timeoutMs}ms`,
        );
        CrashDiagnostics.instance.record('lifecycle', 'error', 'acquisition_timeout', {
          label: options.label,
          timeoutMs,
        });
        reject(err);
      }, timeoutMs);
    });

    try {
      CrashDiagnostics.instance.record('lifecycle', 'info', 'acquisition_start', {
        label: options.label,
      });

      const result = await Promise.race([task(abortController.signal), timeoutPromise]);

      CrashDiagnostics.instance.record('lifecycle', 'info', 'acquisition_success', {
        label: options.label,
      });

      return result;
    } catch (err) {
      CrashDiagnostics.instance.record('lifecycle', 'warn', 'acquisition_failed', {
        label: options.label,
        error: String(err),
      });
      throw err;
    } finally {
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
      if (this.activeAbortController === abortController) {
        this.activeAbortController = null;
      }
    }
  }

  /**
   * Registra um recurso para descarte automático quando o ciclo de vida terminar.
   * Retorna uma função de desregistro manual se o chamador descartar antes.
   */
  register<T extends DisposableResource>(resource: T): () => void {
    if (this.isDisposed) {
      // Já descartado: descarta imediatamente o novo recurso
      void this.disposeSingle(resource);
      return () => {};
    }

    this.resources.add(resource);
    return () => {
      this.resources.delete(resource);
    };
  }

  /**
   * Monitora uma MediaStreamTrack: ao terminar (ended), remove dos recursos rastreados.
   */
  trackMediaStreamTrack(track: MediaStreamTrack): () => void {
    const unreg = this.register(track);
    const onEnded = () => {
      unreg();
      track.removeEventListener('ended', onEnded);
    };
    track.addEventListener('ended', onEnded);
    return () => {
      unreg();
      track.removeEventListener('ended', onEnded);
    };
  }

  /**
   * Desiste de todas as operações em andamento e fecha todos os recursos
   * registrados em ordem inversa com proteção contra travamento.
   */
  async disposeAll(timeoutMs = 2000): Promise<void> {
    if (this.isDisposed) return;
    this.isDisposed = true;

    // Cancela aquisições ativas
    if (this.activeAbortController) {
      this.activeAbortController.abort('Manager disposing');
      this.activeAbortController = null;
    }

    const items = Array.from(this.resources).reverse();
    this.resources.clear();

    CrashDiagnostics.instance.record('lifecycle', 'info', 'dispose_all_start', {
      managerId: this.id,
      itemCount: items.length,
    });

    const cleanupPromises = items.map((res) => this.disposeSingle(res));

    const timeoutPromise = new Promise<void>((resolve) => {
      window.setTimeout(() => {
        CrashDiagnostics.instance.record('lifecycle', 'warn', 'dispose_all_timeout', {
          managerId: this.id,
          timeoutMs,
        });
        resolve();
      }, timeoutMs);
    });

    await Promise.race([Promise.allSettled(cleanupPromises), timeoutPromise]);

    CrashDiagnostics.instance.record('lifecycle', 'info', 'dispose_all_complete', {
      managerId: this.id,
    });
  }

  private async disposeSingle(resource: DisposableResource): Promise<void> {
    try {
      if (typeof resource === 'function') {
        await resource();
      } else if (resource instanceof MediaStream) {
        resource.getTracks().forEach((t) => {
          try {
            t.stop();
          } catch {
            /* ignore */
          }
        });
      } else if (resource instanceof MediaStreamTrack) {
        try {
          resource.stop();
        } catch {
          /* ignore */
        }
      } else if (typeof (resource as AudioContext).close === 'function') {
        const ctx = resource as AudioContext;
        if (ctx.state !== 'closed') {
          await ctx.close().catch(() => {});
        }
      } else if (typeof (resource as AudioNode).disconnect === 'function') {
        (resource as AudioNode).disconnect();
      } else if ('dispose' in resource && typeof resource.dispose === 'function') {
        await resource.dispose();
      } else if ('stop' in resource && typeof resource.stop === 'function') {
        await resource.stop();
      } else if ('close' in resource && typeof resource.close === 'function') {
        await resource.close();
      }
    } catch (err) {
      CrashDiagnostics.instance.record('lifecycle', 'warn', 'dispose_single_error', {
        error: String(err),
      });
    }
  }

  get trackedCount(): number {
    return this.resources.size;
  }
}
