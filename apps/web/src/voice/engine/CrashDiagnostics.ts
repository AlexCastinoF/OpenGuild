/**
 * CrashDiagnostics - RFC v3.0 (Camada 2 - Orquestração & Diagnóstico)
 *
 * Buffer circular de alta performance (500 entradas) para rastreamento de eventos
 * de ciclo de vida de mídia, falhas de dispositivos, contexto de hardware e
 * histórico de recuperação, com sanitização estrita contra vazamento de tokens e credenciais.
 */

export type DiagnosticSubsystem =
  | 'audio'
  | 'video'
  | 'lifecycle'
  | 'device'
  | 'webrtc'
  | 'hardware'
  | 'recovery'
  | 'fatal';

export type DiagnosticLevel = 'debug' | 'info' | 'warn' | 'error';

export interface DiagnosticEntry {
  id: number;
  timestamp: string;
  uptimeMs: number;
  subsystem: DiagnosticSubsystem;
  level: DiagnosticLevel;
  event: string;
  details?: Record<string, unknown>;
}

export interface EnvironmentMetadata {
  userAgent: string;
  platform: string;
  language: string;
  hardwareConcurrency: number;
  screenResolution: string;
}

export interface DiagnosticDump {
  generatedAt: string;
  appVersion: string;
  environment: EnvironmentMetadata;
  entriesCount: number;
  recoveryEventsCount: number;
  entries: DiagnosticEntry[];
}

function sanitizeValue(val: unknown): unknown {
  if (val === null || val === undefined) return val;
  if (typeof val === 'string') {
    // Redação de JWTs (eyJ...)
    let sanitized = val.replace(
      /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
      '[REDACTED_JWT]',
    );
    // Redação de credenciais em URLs ou headers
    sanitized = sanitized.replace(
      /(password|token|secret|auth|bearer)[\s=:"]+([A-Za-z0-9_.\-@]+)/gi,
      '$1=[REDACTED]',
    );
    return sanitized;
  }
  if (Array.isArray(val)) {
    return val.map(sanitizeValue);
  }
  if (typeof val === 'object') {
    const res: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val)) {
      const lower = k.toLowerCase();
      if (
        lower.includes('token') ||
        lower.includes('password') ||
        lower.includes('secret') ||
        lower.includes('auth') ||
        lower.includes('jwt')
      ) {
        res[k] = '[REDACTED]';
      } else {
        res[k] = sanitizeValue(v);
      }
    }
    return res;
  }
  return val;
}

export class CrashDiagnostics {
  private static _instance: CrashDiagnostics | null = null;
  private readonly capacity: number;
  private readonly buffer: DiagnosticEntry[];
  private seq = 0;
  private startTime = performance.now();

  constructor(capacity = 500) {
    this.capacity = capacity;
    this.buffer = [];
  }

  static get instance(): CrashDiagnostics {
    if (!this._instance) {
      this._instance = new CrashDiagnostics(500);
    }
    return this._instance;
  }

  record(
    subsystem: DiagnosticSubsystem,
    level: DiagnosticLevel,
    event: string,
    details?: Record<string, unknown>,
  ): DiagnosticEntry {
    this.seq += 1;
    const sanitizedDetails = details
      ? (sanitizeValue(details) as Record<string, unknown>)
      : undefined;

    const entry: DiagnosticEntry = {
      id: this.seq,
      timestamp: new Date().toISOString(),
      uptimeMs: Math.round(performance.now() - this.startTime),
      subsystem,
      level,
      event,
      details: sanitizedDetails,
    };

    if (this.buffer.length >= this.capacity) {
      this.buffer.shift();
    }
    this.buffer.push(entry);

    if (level === 'error') {
      console.error(`[Diagnostics][${subsystem}] ${event}`, sanitizedDetails ?? '');
    } else if (level === 'warn') {
      console.warn(`[Diagnostics][${subsystem}] ${event}`, sanitizedDetails ?? '');
    }

    // Encaminha de forma não-bloqueante para o backend nativo Rust se disponível
    if (typeof window !== 'undefined' && window.sfDesktop?.recordDiagnosticEvent) {
      window.sfDesktop
        .recordDiagnosticEvent(
          subsystem,
          level,
          event,
          sanitizedDetails ? JSON.stringify(sanitizedDetails) : undefined,
        )
        .catch(() => undefined);
    }

    return entry;
  }

  getEntries(): readonly DiagnosticEntry[] {
    return [...this.buffer];
  }

  getRecoveryHistory(): readonly DiagnosticEntry[] {
    return this.buffer.filter(
      (e) => e.subsystem === 'recovery' || e.subsystem === 'device' || e.subsystem === 'lifecycle',
    );
  }

  clear(): void {
    this.buffer.length = 0;
    if (typeof window !== 'undefined' && window.sfDesktop?.clearCrashDiagnostics) {
      window.sfDesktop.clearCrashDiagnostics().catch(() => undefined);
    }
  }

  getEnvironmentMetadata(): EnvironmentMetadata {
    if (typeof navigator === 'undefined') {
      return {
        userAgent: 'unknown',
        platform: 'unknown',
        language: 'unknown',
        hardwareConcurrency: 0,
        screenResolution: '0x0',
      };
    }

    return {
      userAgent: navigator.userAgent,
      platform: navigator.platform || 'unknown',
      language: navigator.language || 'pt-BR',
      hardwareConcurrency: navigator.hardwareConcurrency || 4,
      screenResolution:
        typeof window !== 'undefined'
          ? `${window.screen?.width || 0}x${window.screen?.height || 0}`
          : 'unknown',
    };
  }

  dump(): DiagnosticDump {
    return {
      generatedAt: new Date().toISOString(),
      appVersion: '1.0.0',
      environment: this.getEnvironmentMetadata(),
      entriesCount: this.buffer.length,
      recoveryEventsCount: this.getRecoveryHistory().length,
      entries: this.getEntries() as DiagnosticEntry[],
    };
  }
}
