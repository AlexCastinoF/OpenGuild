/**
 * VoiceTelemetryPanel.tsx — Painel Visual de Telemetria e Benchmark C1–C8
 * RFC v3.0 - Etapa 1: Suite de Testes e Telemetria
 * RFC v3.0 - Etapa 2: Diagnósticos de Quedas e Resiliência
 * RFC v3.0 - Etapa 3: PerformanceGuardian & Monitor de Deadline
 * RFC v3.0 - Etapa 4: AdaptiveAudioEngine & Equal-Power Crossfade
 * RFC v3.0 - Etapa 5: AudioRoutingEngine & Windows Process Loopback
 */

import { useEffect, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Cpu,
  Download,
  Gamepad2,
  Gauge,
  HardDrive,
  Play,
  RotateCcw,
  Shield,
  Volume2,
  Wifi,
  X,
  XCircle,
  Zap,
} from 'lucide-react';
import {
  BenchmarkRunner,
  SCENARIOS,
  type BenchmarkResult,
  type BenchmarkScenarioId,
} from '../voice/engine/BenchmarkRunner';
import {
  WebRTCMetricsCollector,
  type CombinedMetricsSnapshot,
} from '../voice/engine/WebRTCMetrics';
import { CrashDiagnostics, type DiagnosticEntry } from '../voice/engine/CrashDiagnostics';
import {
  POLICIES,
  type DegradationLevel,
  type DegradationPolicy,
  type PerformancePolicyEngine,
} from '../voice/engine/PerformancePolicyEngine';
import type { AudioBudgetMonitor, AudioBudgetStats } from '../voice/engine/AudioBudgetMonitor';

export function VoiceTelemetryPanel({
  open,
  onClose,
  metricsCollector,
  benchmarkRunner,
  policyEngine,
  audioBudgetMonitor,
}: {
  open: boolean;
  onClose: () => void;
  metricsCollector?: WebRTCMetricsCollector | null;
  benchmarkRunner?: BenchmarkRunner | null;
  policyEngine?: PerformancePolicyEngine | null;
  audioBudgetMonitor?: AudioBudgetMonitor | null;
}) {
  const [activeTab, setActiveTab] = useState<'realtime' | 'benchmarks' | 'diagnostics'>('realtime');
  const [snapshot, setSnapshot] = useState<CombinedMetricsSnapshot | null>(null);
  const [selectedScenario, setSelectedScenario] = useState<BenchmarkScenarioId>('C1');
  const [isBenchmarking, setIsBenchmarking] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [lastResult, setLastResult] = useState<BenchmarkResult | null>(null);
  const [diagnosticEntries, setDiagnosticEntries] = useState<readonly DiagnosticEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Estados da Etapa 3 (PerformanceGuardian, PolicyEngine, AudioBudget)
  const [currentPolicy, setCurrentPolicy] = useState<DegradationPolicy>(
    policyEngine ? policyEngine.currentPolicy : POLICIES[0],
  );
  const [manualOverrideLevel, setManualOverrideLevel] = useState<DegradationLevel | null>(null);
  const [budgetStats, setBudgetStats] = useState<AudioBudgetStats | null>(
    audioBudgetMonitor ? audioBudgetMonitor.getStats() : null,
  );
  const [guardianStatus, setGuardianStatus] = useState<{
    pressure_level: string;
    cpu_global_pct: number;
    cs2_running: boolean;
    cs2_pid?: number | null;
  } | null>(null);

  // Estados da Etapa 5 (AudioRoutingEngine & Windows Process Loopback)
  const [routingStatus, setRoutingStatus] = useState<{
    is_capturing: boolean;
    mode: string;
    target_process_name: string;
    target_pid: number | null;
    os_build: number;
    supports_process_loopback: boolean;
    chunks_emitted: number;
  } | null>(null);

  useEffect(() => {
    if (!open || !metricsCollector) return;

    const unsub = metricsCollector.subscribe((snap) => {
      setSnapshot(snap);
    });

    return () => unsub();
  }, [open, metricsCollector]);

  useEffect(() => {
    if (!open || !policyEngine) return;
    setCurrentPolicy(policyEngine.currentPolicy);
    const unsub = policyEngine.subscribe((newP) => {
      setCurrentPolicy(newP);
    });
    return () => unsub();
  }, [open, policyEngine]);

  useEffect(() => {
    if (!open || !audioBudgetMonitor) return;
    setBudgetStats(audioBudgetMonitor.getStats());
    const unsub = audioBudgetMonitor.subscribe((st) => {
      setBudgetStats(st);
    });
    return () => unsub();
  }, [open, audioBudgetMonitor]);

  useEffect(() => {
    if (!open) return;
    if (typeof window !== 'undefined' && window.sfDesktop?.onGuardianAlert) {
      const unsub = window.sfDesktop.onGuardianAlert((alert) => {
        setGuardianStatus(alert);
      });
      window.sfDesktop.getGuardianStatus?.().then((st) => {
        setGuardianStatus(st);
      }).catch(() => {});
      return () => unsub();
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const fetchRouting = () => {
      if (typeof window !== 'undefined' && window.sfDesktop?.getAudioRoutingStatus) {
        window.sfDesktop.getAudioRoutingStatus().then((st) => setRoutingStatus(st)).catch(() => {});
      }
    };
    fetchRouting();
    const interval = window.setInterval(fetchRouting, 1000);
    return () => window.clearInterval(interval);
  }, [open]);

  useEffect(() => {
    if (open && activeTab === 'diagnostics') {
      setDiagnosticEntries(CrashDiagnostics.instance.getEntries());
      const interval = window.setInterval(() => {
        setDiagnosticEntries(CrashDiagnostics.instance.getEntries());
      }, 1000);
      return () => window.clearInterval(interval);
    }
  }, [open, activeTab]);

  if (!open) return null;

  function handleSetOverride(level: DegradationLevel | null) {
    setManualOverrideLevel(level);
    if (!policyEngine) return;
    if (level === null) {
      policyEngine.clearForceLevel();
      setCurrentPolicy(policyEngine.currentPolicy);
    } else {
      policyEngine.forceLevel(level, 'ui_manual_override');
      setCurrentPolicy(policyEngine.currentPolicy);
    }
  }

  async function handleRunBenchmark() {
    if (!benchmarkRunner) return;
    setIsBenchmarking(true);
    setError(null);
    try {
      const res = await benchmarkRunner.runBenchmark(
        selectedScenario,
        10,
        (secLeft) => setCountdown(secLeft),
      );
      setLastResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsBenchmarking(false);
      setCountdown(null);
    }
  }

  function downloadDiagnostics() {
    const dump = CrashDiagnostics.instance.dump();
    const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `crash-diagnostics-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function clearDiagnostics() {
    CrashDiagnostics.instance.clear();
    setDiagnosticEntries([]);
  }

  const hw = snapshot?.hardware;
  const rtc = snapshot?.webrtc;
  const scenarioDef = SCENARIOS[selectedScenario];

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 24,
        right: 24,
        width: 480,
        maxHeight: '85vh',
        background: '#0d182b',
        border: '1px solid rgba(255, 255, 255, 0.12)',
        borderRadius: 16,
        boxShadow: '0 24px 60px rgba(0, 0, 0, 0.85)',
        zIndex: 100150,
        display: 'flex',
        flexDirection: 'column',
        color: '#f3f4f6',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '14px 18px',
          borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
          background: 'rgba(0, 0, 0, 0.25)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Activity size={18} color="#ff9a3d" />
          <strong style={{ fontSize: 14 }}>Telemetria & Benchmarks (RFC v3.0)</strong>
        </div>
        <button
          type="button"
          onClick={onClose}
          style={{
            background: 'transparent',
            border: 'none',
            color: '#9ca3af',
            cursor: 'pointer',
            padding: 4,
          }}
        >
          <X size={18} />
        </button>
      </div>

      {/* Tabs */}
      <div
        style={{
          display: 'flex',
          borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
          background: 'rgba(0, 0, 0, 0.2)',
        }}
      >
        <button
          type="button"
          onClick={() => setActiveTab('realtime')}
          style={{
            flex: 1,
            padding: '10px 12px',
            background: activeTab === 'realtime' ? 'rgba(255, 154, 61, 0.15)' : 'transparent',
            color: activeTab === 'realtime' ? '#ff9a3d' : '#9ca3af',
            border: 'none',
            borderBottom: activeTab === 'realtime' ? '2px solid #ff9a3d' : '2px solid transparent',
            cursor: 'pointer',
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          Tempo Real
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('benchmarks')}
          style={{
            flex: 1,
            padding: '10px 12px',
            background: activeTab === 'benchmarks' ? 'rgba(255, 154, 61, 0.15)' : 'transparent',
            color: activeTab === 'benchmarks' ? '#ff9a3d' : '#9ca3af',
            border: 'none',
            borderBottom: activeTab === 'benchmarks' ? '2px solid #ff9a3d' : '2px solid transparent',
            cursor: 'pointer',
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          Benchmarks C1–C8
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('diagnostics')}
          style={{
            flex: 1,
            padding: '10px 12px',
            background: activeTab === 'diagnostics' ? 'rgba(255, 154, 61, 0.15)' : 'transparent',
            color: activeTab === 'diagnostics' ? '#ff9a3d' : '#9ca3af',
            border: 'none',
            borderBottom: activeTab === 'diagnostics' ? '2px solid #ff9a3d' : '2px solid transparent',
            cursor: 'pointer',
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          Diagnósticos
        </button>
      </div>

      {/* Body */}
      <div style={{ padding: 16, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
        {activeTab === 'realtime' && (
          <>
            {/* Hardware Status Grid */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
              <div
                style={{
                  background: 'rgba(255, 255, 255, 0.03)',
                  border: '1px solid rgba(255, 255, 255, 0.06)',
                  borderRadius: 8,
                  padding: '8px 10px',
                }}
              >
                <div style={{ fontSize: 11, color: '#9ca3af', display: 'flex', alignItems: 'center', gap: 4 }}>
                  <Cpu size={12} /> CPU Global
                </div>
                <div style={{ fontSize: 16, fontWeight: 700, marginTop: 2 }}>
                  {hw ? `${hw.cpu_global_pct.toFixed(1)}%` : '—'}
                </div>
                <div style={{ fontSize: 10, color: '#6b7280' }}>
                  App: {hw ? `${hw.cpu_process_pct.toFixed(1)}%` : '—'}
                </div>
              </div>

              <div
                style={{
                  background: 'rgba(255, 255, 255, 0.03)',
                  border: '1px solid rgba(255, 255, 255, 0.06)',
                  borderRadius: 8,
                  padding: '8px 10px',
                }}
              >
                <div style={{ fontSize: 11, color: '#9ca3af', display: 'flex', alignItems: 'center', gap: 4 }}>
                  <Gauge size={12} /> GPU 3D
                </div>
                <div style={{ fontSize: 16, fontWeight: 700, marginTop: 2 }}>
                  {hw ? `${hw.gpu_3d_pct.toFixed(1)}%` : '—'}
                </div>
                <div style={{ fontSize: 10, color: '#6b7280' }}>
                  Enc: {hw ? `${hw.gpu_video_encode_pct.toFixed(1)}%` : '—'}
                </div>
              </div>

              <div
                style={{
                  background: 'rgba(255, 255, 255, 0.03)',
                  border: '1px solid rgba(255, 255, 255, 0.06)',
                  borderRadius: 8,
                  padding: '8px 10px',
                }}
              >
                <div style={{ fontSize: 11, color: '#9ca3af', display: 'flex', alignItems: 'center', gap: 4 }}>
                  <HardDrive size={12} /> Copy Engine
                </div>
                <div
                  style={{
                    fontSize: 16,
                    fontWeight: 700,
                    marginTop: 2,
                    color: hw && hw.gpu_copy_engine_pct > 8 ? '#f87171' : '#34d399',
                  }}
                >
                  {hw ? `${hw.gpu_copy_engine_pct.toFixed(1)}%` : '—'}
                </div>
                <div style={{ fontSize: 10, color: '#6b7280' }}>
                  RAM: {hw ? `${hw.ram_process_mb.toFixed(0)} MB` : '—'}
                </div>
              </div>
            </div>

            {/* WebRTC Status Row */}
            <div
              style={{
                background: 'rgba(0, 0, 0, 0.3)',
                borderRadius: 8,
                padding: '10px 12px',
                border: '1px solid rgba(255, 255, 255, 0.06)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Wifi size={14} color="#60a5fa" />
                <span style={{ fontSize: 12, color: '#9ca3af' }}>RTT:</span>
                <strong style={{ fontSize: 13 }}>{rtc ? `${rtc.rtt_ms} ms` : '—'}</strong>
              </div>
              <div style={{ fontSize: 12, color: '#9ca3af' }}>
                Jitter: <strong style={{ color: '#f3f4f6' }}>{rtc ? `${rtc.jitter_ms} ms` : '—'}</strong>
              </div>
              <div style={{ fontSize: 12, color: '#9ca3af' }}>
                Perda:{' '}
                <strong style={{ color: rtc && rtc.audio_packet_loss_pct > 2 ? '#f87171' : '#34d399' }}>
                  {rtc ? `${rtc.audio_packet_loss_pct}%` : '—'}
                </strong>
              </div>
              <div style={{ fontSize: 12, color: '#9ca3af' }}>
                Video: <strong style={{ color: '#f3f4f6' }}>{rtc ? `${rtc.video_fps} FPS` : '—'}</strong>
              </div>
            </div>

            {/* PerformanceGuardian & CS2 Watchdog (RFC v3.0 - Etapa 3) */}
            <div
              style={{
                background: 'rgba(255, 255, 255, 0.03)',
                border: '1px solid rgba(255, 255, 255, 0.08)',
                borderRadius: 10,
                padding: '10px 12px',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Shield size={14} color="#38bdf8" />
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#e5e7eb' }}>
                    PerformanceGuardian
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      padding: '2px 8px',
                      borderRadius: 12,
                      background:
                        guardianStatus?.pressure_level === 'Critical'
                          ? 'rgba(239, 68, 68, 0.25)'
                          : guardianStatus?.pressure_level === 'High'
                          ? 'rgba(249, 115, 22, 0.25)'
                          : guardianStatus?.pressure_level === 'Moderate'
                          ? 'rgba(234, 179, 8, 0.25)'
                          : 'rgba(16, 185, 129, 0.2)',
                      color:
                        guardianStatus?.pressure_level === 'Critical'
                          ? '#f87171'
                          : guardianStatus?.pressure_level === 'High'
                          ? '#fb923c'
                          : guardianStatus?.pressure_level === 'Moderate'
                          ? '#facc15'
                          : '#34d399',
                      border: '1px solid rgba(255,255,255,0.1)',
                      textTransform: 'uppercase',
                    }}
                  >
                    Pressão: {guardianStatus?.pressure_level || 'Normal'}
                  </span>
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 11 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <Gamepad2 size={13} color={guardianStatus?.cs2_running ? '#34d399' : '#6b7280'} />
                  <span style={{ color: guardianStatus?.cs2_running ? '#34d399' : '#9ca3af', fontWeight: 600 }}>
                    {guardianStatus?.cs2_running
                      ? `CS2 Ativo (PID: ${guardianStatus.cs2_pid || '—'})`
                      : 'CS2 Inativo'}
                  </span>
                </div>
                <span style={{ color: '#9ca3af' }}>
                  CPU Global: <strong style={{ color: '#f3f4f6' }}>{guardianStatus ? `${guardianStatus.cpu_global_pct.toFixed(1)}%` : '—'}</strong>
                </span>
              </div>
            </div>

            {/* Plano de Degradação Ativo (RFC v3.0 - Etapa 3) */}
            <div
              style={{
                background: 'rgba(255, 255, 255, 0.03)',
                border: '1px solid rgba(255, 255, 255, 0.08)',
                borderRadius: 10,
                padding: '10px 12px',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Zap size={14} color="#f59e0b" />
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#e5e7eb' }}>
                    Política de Degradação Ativa
                  </span>
                </div>
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 800,
                    padding: '2px 8px',
                    borderRadius: 12,
                    background:
                      currentPolicy.level === 3
                        ? 'rgba(239, 68, 68, 0.25)'
                        : currentPolicy.level === 2
                        ? 'rgba(245, 158, 11, 0.25)'
                        : currentPolicy.level === 1
                        ? 'rgba(59, 130, 246, 0.25)'
                        : 'rgba(16, 185, 129, 0.2)',
                    color:
                      currentPolicy.level === 3
                        ? '#f87171'
                        : currentPolicy.level === 2
                        ? '#fbbf24'
                        : currentPolicy.level === 1
                        ? '#60a5fa'
                        : '#34d399',
                    border: '1px solid rgba(255,255,255,0.1)',
                  }}
                >
                  NÍVEL {currentPolicy.level} — {currentPolicy.name}
                </span>
              </div>

              <div style={{ fontSize: 11, color: '#9ca3af', lineHeight: 1.4 }}>
                {currentPolicy.description}
              </div>

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(3, 1fr)',
                  gap: 6,
                  fontSize: 10,
                  color: '#9ca3af',
                  background: 'rgba(0,0,0,0.2)',
                  padding: 8,
                  borderRadius: 6,
                }}
              >
                <div>
                  Filtro: <strong style={{ color: '#fff' }}>{currentPolicy.noiseEngine}</strong>
                </div>
                <div>
                  Bitrate: <strong style={{ color: '#fff' }}>{Math.round(currentPolicy.opusBitrateBps / 1000)}k</strong>
                </div>
                <div>
                  Tela: <strong style={{ color: '#fff' }}>{currentPolicy.screenResolution}@{currentPolicy.maxScreenFps}</strong>
                </div>
              </div>

              {/* Botões de Override Manual para Homologação */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 2 }}>
                <span style={{ fontSize: 10, color: '#9ca3af', marginRight: 4 }}>Forçar:</span>
                {(['auto', 0, 1, 2, 3] as const).map((lvl) => {
                  const isSelected = lvl === 'auto' ? manualOverrideLevel === null : manualOverrideLevel === lvl;
                  return (
                    <button
                      key={lvl}
                      type="button"
                      onClick={() => handleSetOverride(lvl === 'auto' ? null : lvl)}
                      style={{
                        flex: 1,
                        padding: '4px 6px',
                        fontSize: 10,
                        fontWeight: isSelected ? 700 : 500,
                        borderRadius: 6,
                        border: isSelected ? '1px solid #ff9a3d' : '1px solid rgba(255,255,255,0.1)',
                        background: isSelected ? 'rgba(255, 154, 61, 0.25)' : 'rgba(0,0,0,0.3)',
                        color: isSelected ? '#ff9a3d' : '#9ca3af',
                        cursor: 'pointer',
                      }}
                    >
                      {lvl === 'auto' ? 'Auto' : `L${lvl}`}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Monitor de Deadline de Áudio (RFC v3.0 - Etapa 3) */}
            <div
              style={{
                background: 'rgba(255, 255, 255, 0.03)',
                border: '1px solid rgba(255, 255, 255, 0.08)',
                borderRadius: 10,
                padding: '10px 12px',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Activity size={14} color="#a78bfa" />
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#e5e7eb' }}>
                    Orçamento AudioWorklet (T_bloco)
                  </span>
                </div>
                <span style={{ fontSize: 10, color: '#9ca3af' }}>
                  Limite: <strong style={{ color: '#fff' }}>{budgetStats ? `${budgetStats.blockBudgetMs.toFixed(2)} ms` : '2.67 ms'}</strong>
                </span>
              </div>

              {/* Barra de Utilização do Orçamento */}
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, marginBottom: 4 }}>
                  <span style={{ color: '#9ca3af' }}>Uso p95 do Orçamento:</span>
                  <strong
                    style={{
                      color:
                        (budgetStats?.budgetUtilizationP95Pct || 0) > 70
                          ? '#f87171'
                          : (budgetStats?.budgetUtilizationP95Pct || 0) > 50
                          ? '#facc15'
                          : '#34d399',
                    }}
                  >
                    {budgetStats ? `${budgetStats.budgetUtilizationP95Pct}%` : '0%'}
                  </strong>
                </div>
                <div
                  style={{
                    height: 6,
                    background: 'rgba(255,255,255,0.08)',
                    borderRadius: 3,
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      height: '100%',
                      width: `${Math.min(100, Math.max(0, budgetStats?.budgetUtilizationP95Pct || 0))}%`,
                      background:
                        (budgetStats?.budgetUtilizationP95Pct || 0) > 70
                          ? '#f87171'
                          : (budgetStats?.budgetUtilizationP95Pct || 0) > 50
                          ? '#facc15'
                          : '#34d399',
                      transition: 'width 0.2s ease',
                    }}
                  />
                </div>
              </div>

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(4, 1fr)',
                  gap: 6,
                  fontSize: 10,
                  color: '#9ca3af',
                  background: 'rgba(0,0,0,0.2)',
                  padding: 8,
                  borderRadius: 6,
                }}
              >
                <div>
                  p50: <strong style={{ color: '#fff' }}>{budgetStats ? `${budgetStats.execTimeP50Ms}ms` : '—'}</strong>
                </div>
                <div>
                  p95: <strong style={{ color: '#fff' }}>{budgetStats ? `${budgetStats.execTimeP95Ms}ms` : '—'}</strong>
                </div>
                <div>
                  Misses: <strong style={{ color: budgetStats && budgetStats.deadlineMisses > 0 ? '#f87171' : '#34d399' }}>
                    {budgetStats?.deadlineMisses || 0}
                  </strong>
                </div>
                <div>
                  Glitches: <strong style={{ color: budgetStats && budgetStats.glitchesDetected > 0 ? '#f87171' : '#34d399' }}>
                    {budgetStats?.glitchesDetected || 0}
                  </strong>
                </div>
              </div>
            </div>

            {/* AudioRoutingEngine & Windows Process Loopback (RFC v3.0 - Etapa 5) */}
            <div
              style={{
                background: 'rgba(255, 255, 255, 0.03)',
                border: '1px solid rgba(255, 255, 255, 0.08)',
                borderRadius: 10,
                padding: '10px 12px',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Volume2 size={14} color="#10b981" />
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#e5e7eb' }}>
                    AudioRoutingEngine (Process Loopback)
                  </span>
                </div>
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    padding: '2px 8px',
                    borderRadius: 12,
                    background: routingStatus?.is_capturing ? 'rgba(16, 185, 129, 0.25)' : 'rgba(255, 255, 255, 0.08)',
                    color: routingStatus?.is_capturing ? '#34d399' : '#9ca3af',
                    border: '1px solid rgba(255,255,255,0.1)',
                  }}
                >
                  {routingStatus?.is_capturing ? 'Captura Ativa' : 'Dormant (Inativo)'}
                </span>
              </div>

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(2, 1fr)',
                  gap: 6,
                  fontSize: 10,
                  color: '#9ca3af',
                  background: 'rgba(0,0,0,0.2)',
                  padding: 8,
                  borderRadius: 6,
                }}
              >
                <div>
                  Alvo: <strong style={{ color: '#fff' }}>cs2.exe</strong> {routingStatus?.target_pid ? `(PID: ${routingStatus.target_pid})` : '(aguardando)'}
                </div>
                <div>
                  Modo: <strong style={{ color: '#fff' }}>{routingStatus?.mode || 'process_loopback'}</strong>
                </div>
                <div>
                  Windows Build: <strong style={{ color: '#fff' }}>{routingStatus?.os_build || '—'}</strong>
                </div>
                <div>
                  Suporte API: <strong style={{ color: routingStatus?.supports_process_loopback ? '#34d399' : '#facc15' }}>
                    {routingStatus?.supports_process_loopback ? 'Nativo (≥20348)' : 'Fallback Endpoint'}
                  </strong>
                </div>
              </div>
            </div>

            <div style={{ fontSize: 11, color: '#9ca3af', lineHeight: 1.5, background: 'rgba(0,0,0,0.2)', padding: 10, borderRadius: 8 }}>
              💡 Pressione <strong>F8</strong> ou <strong>Ctrl+Shift+T</strong> a qualquer momento para abrir ou fechar este painel.
            </div>
          </>
        )}

        {activeTab === 'benchmarks' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <span style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', color: '#9ca3af' }}>
              Runner de Benchmark Reproduzível (SLOs p95)
            </span>

            <div style={{ display: 'flex', gap: 8 }}>
              <select
                value={selectedScenario}
                onChange={(e) => setSelectedScenario(e.target.value as BenchmarkScenarioId)}
                disabled={isBenchmarking}
                style={{
                  flex: 1,
                  background: 'rgba(0, 0, 0, 0.4)',
                  border: '1px solid rgba(255, 255, 255, 0.15)',
                  borderRadius: 8,
                  color: '#fff',
                  padding: '8px 10px',
                  fontSize: 12,
                }}
              >
                {(Object.keys(SCENARIOS) as BenchmarkScenarioId[]).map((k) => (
                  <option key={k} value={k} style={{ background: '#111827' }}>
                    {k}: {SCENARIOS[k].name}
                  </option>
                ))}
              </select>

              <button
                type="button"
                onClick={handleRunBenchmark}
                disabled={isBenchmarking || !benchmarkRunner}
                style={{
                  background: isBenchmarking ? 'rgba(255, 154, 61, 0.2)' : '#ff9a3d',
                  color: isBenchmarking ? '#ff9a3d' : '#000',
                  fontWeight: 700,
                  border: 'none',
                  borderRadius: 8,
                  padding: '8px 14px',
                  cursor: isBenchmarking || !benchmarkRunner ? 'not-allowed' : 'pointer',
                  fontSize: 12,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                {isBenchmarking ? <RotateCcw size={14} className="animate-spin" /> : <Play size={14} />}
                {isBenchmarking ? `Executando (${countdown}s)...` : 'Iniciar Teste'}
              </button>
            </div>

            <div style={{ fontSize: 11, color: '#9ca3af', lineHeight: 1.4 }}>
              <strong>Objetivo do Cenário:</strong> {scenarioDef.description}
            </div>

            {error && (
              <div
                style={{
                  background: 'rgba(239, 68, 68, 0.15)',
                  border: '1px solid rgba(239, 68, 68, 0.3)',
                  color: '#f87171',
                  borderRadius: 8,
                  padding: 10,
                  fontSize: 11,
                }}
              >
                {error}
              </div>
            )}

            {lastResult && (
              <div
                style={{
                  background: 'rgba(0, 0, 0, 0.35)',
                  borderRadius: 8,
                  padding: 12,
                  border: '1px solid rgba(255, 255, 255, 0.08)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {lastResult.verdict === 'PASS' ? (
                      <CheckCircle2 size={16} color="#34d399" />
                    ) : lastResult.verdict === 'WARN' ? (
                      <AlertTriangle size={16} color="#facc15" />
                    ) : (
                      <XCircle size={16} color="#f87171" />
                    )}
                    <strong
                      style={{
                        fontSize: 13,
                        color:
                          lastResult.verdict === 'PASS'
                            ? '#34d399'
                            : lastResult.verdict === 'WARN'
                            ? '#facc15'
                            : '#f87171',
                      }}
                    >
                      {lastResult.verdict === 'PASS'
                        ? 'APROVADO (Dentro dos SLOs)'
                        : lastResult.verdict === 'WARN'
                        ? 'AVISO (Métricas limítrofes)'
                        : 'REPROVADO (Violou SLOs)'}
                    </strong>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      const dump = JSON.stringify(lastResult, null, 2);
                      const blob = new Blob([dump], { type: 'application/json' });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = `benchmark-${lastResult.scenarioId}-${Date.now()}.json`;
                      a.click();
                      URL.revokeObjectURL(url);
                    }}
                    style={{
                      background: 'rgba(255, 255, 255, 0.08)',
                      border: '1px solid rgba(255, 255, 255, 0.15)',
                      color: '#fff',
                      borderRadius: 6,
                      padding: '4px 8px',
                      fontSize: 11,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                    }}
                  >
                    <Download size={12} /> Exportar JSON
                  </button>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 6, fontSize: 11 }}>
                  <div>RTT p95: <strong>{lastResult.summary.rtt.p95} ms</strong></div>
                  <div>CPU App p95: <strong>{lastResult.summary.cpuProcessPct.p95}%</strong></div>
                  <div>Perda Média: <strong>{lastResult.summary.packetLossPctAvg}%</strong></div>
                  <div>UI FPS: <strong>{lastResult.summary.uiFps.p50} FPS</strong></div>
                  <div>GPU 3D: <strong>{lastResult.summary.gpu3dPct.p95}%</strong></div>
                  <div>Copy Engine: <strong>{lastResult.summary.gpuCopyEnginePct.p95}%</strong></div>
                </div>

                {lastResult.violations.length > 0 && (
                  <div style={{ marginTop: 4, fontSize: 10, color: '#f87171' }}>
                    <strong>Violações observadas:</strong>
                    <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
                      {lastResult.violations.map((v, i) => (
                        <li key={i}>{v}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {activeTab === 'diagnostics' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', color: '#9ca3af' }}>
                Buffer Circular de Diagnóstico ({diagnosticEntries.length}/500)
              </span>
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  type="button"
                  onClick={clearDiagnostics}
                  style={{
                    padding: '3px 8px',
                    fontSize: 11,
                    background: 'rgba(255, 255, 255, 0.08)',
                    color: '#9ca3af',
                    border: '1px solid rgba(255, 255, 255, 0.1)',
                    borderRadius: 6,
                    cursor: 'pointer',
                  }}
                >
                  Limpar
                </button>
                <button
                  type="button"
                  onClick={downloadDiagnostics}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    padding: '3px 8px',
                    fontSize: 11,
                    background: 'rgba(255, 154, 61, 0.15)',
                    color: '#ff9a3d',
                    border: '1px solid rgba(255, 154, 61, 0.3)',
                    borderRadius: 6,
                    cursor: 'pointer',
                  }}
                >
                  <Download size={11} /> Baixar Dump
                </button>
              </div>
            </div>

            <div
              style={{
                maxHeight: 280,
                overflowY: 'auto',
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
                background: 'rgba(0, 0, 0, 0.35)',
                padding: 8,
                borderRadius: 8,
                border: '1px solid rgba(255, 255, 255, 0.06)',
                fontFamily: 'monospace',
                fontSize: 11,
              }}
            >
              {diagnosticEntries.length === 0 ? (
                <div style={{ color: '#6b7280', textAlign: 'center', padding: '16px 0' }}>
                  Nenhum evento registrado ainda.
                </div>
              ) : (
                diagnosticEntries
                  .slice()
                  .reverse()
                  .map((e) => (
                    <div
                      key={e.id}
                      style={{
                        padding: '4px 6px',
                        borderRadius: 4,
                        background:
                          e.level === 'error'
                            ? 'rgba(239, 68, 68, 0.15)'
                            : e.level === 'warn'
                            ? 'rgba(245, 158, 11, 0.15)'
                            : 'rgba(255, 255, 255, 0.02)',
                        borderLeft: `3px solid ${
                          e.level === 'error'
                            ? '#f87171'
                            : e.level === 'warn'
                            ? '#fbbf24'
                            : '#60a5fa'
                        }`,
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', color: '#9ca3af', fontSize: 10 }}>
                        <span>
                          [{e.subsystem.toUpperCase()}] {e.event}
                        </span>
                        <span>{e.timestamp.split('T')[1]?.replace('Z', '')}</span>
                      </div>
                      {e.details ? (
                        <div style={{ color: '#d1d5db', marginTop: 2, fontSize: 10, wordBreak: 'break-all' }}>
                          {JSON.stringify(e.details)}
                        </div>
                      ) : null}
                    </div>
                  ))
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
