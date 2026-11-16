/**
 * WebRTCMetrics.ts — Coleta e Análise de Estatísticas WebRTC e Telemetria de Hardware
 * RFC v3.0 - Etapa 1: Baseline e Telemetria Integral
 */

import type { Room } from 'livekit-client';

export type HardwareTelemetrySample = {
  timestamp_ms: number;
  cpu_global_pct: number;
  cpu_process_pct: number;
  ram_process_mb: number;
  gpu_3d_pct: number;
  gpu_video_encode_pct: number;
  gpu_copy_engine_pct: number;
  vram_used_mb: number;
  vram_total_mb: number;
};

export type WebRTCSample = {
  timestamp_ms: number;
  rtt_ms: number;
  jitter_ms: number;
  audio_jitter_buffer_delay_ms: number;
  audio_packets_lost: number;
  audio_packets_received: number;
  audio_packet_loss_pct: number;
  audio_underruns_count: number;
  video_fps: number;
  video_bitrate_kbps: number;
  video_frames_decoded: number;
  video_frames_dropped: number;
  video_drop_pct: number;
  video_frame_time_ms: number;
  video_encoder_wait_time_ms: number;
  upload_kbps: number;
  download_kbps: number;
};

export type CombinedMetricsSnapshot = {
  timestamp_ms: number;
  webrtc: WebRTCSample;
  hardware: HardwareTelemetrySample;
};

export type MetricsPercentiles = {
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  avg: number;
};

export class WebRTCMetricsCollector {
  private room: Room | null = null;
  private timer: number | null = null;
  private samples: CombinedMetricsSnapshot[] = [];
  private maxSamples: number = 240; // 2 minutos a cada 500ms
  private latestHw: HardwareTelemetrySample = {
    timestamp_ms: Date.now(),
    cpu_global_pct: 0,
    cpu_process_pct: 0,
    ram_process_mb: 0,
    gpu_3d_pct: 0,
    gpu_video_encode_pct: 0,
    gpu_copy_engine_pct: 0,
    vram_used_mb: 0,
    vram_total_mb: 0,
  };

  private prevBytesSent: number = 0;
  private prevBytesReceived: number = 0;
  private prevTimestamp: number = 0;
  private prevFramesDecoded: number = 0;
  private prevFramesDropped: number = 0;
  private prevAudioPacketsReceived: number = 0;
  private prevAudioPacketsLost: number = 0;
  private unsubHw: (() => void) | null = null;
  private listeners: Set<(snapshot: CombinedMetricsSnapshot) => void> = new Set();

  constructor() {
    this.initHardwareListener();
  }

  private initHardwareListener() {
    if (typeof window !== 'undefined' && window.sfDesktop?.onHardwareTelemetry) {
      this.unsubHw = window.sfDesktop.onHardwareTelemetry((data) => {
        this.latestHw = data;
      });
      void window.sfDesktop.startHardwareTelemetry?.().catch(() => undefined);
    }
  }

  public attachRoom(room: Room | null) {
    this.room = room;
  }

  public start(intervalMs: number = 500) {
    if (this.timer != null) return;
    this.prevTimestamp = performance.now();
    this.timer = window.setInterval(() => {
      void this.collectTick();
    }, intervalMs);
  }

  public stop() {
    if (this.timer != null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  public subscribe(cb: (snapshot: CombinedMetricsSnapshot) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  public getHistory(): CombinedMetricsSnapshot[] {
    return [...this.samples];
  }

  public getLatest(): CombinedMetricsSnapshot | null {
    return this.samples.length > 0 ? this.samples[this.samples.length - 1] : null;
  }

  public clear() {
    this.samples = [];
  }

  public dispose() {
    this.stop();
    if (this.unsubHw) {
      this.unsubHw();
      this.unsubHw = null;
    }
    this.listeners.clear();
  }

  private async collectTick() {
    const now = performance.now();
    const dt = Math.max(0.001, (now - this.prevTimestamp) / 1000);
    this.prevTimestamp = now;

    const webrtc = await this.readWebRTCStats(dt);
    const snapshot: CombinedMetricsSnapshot = {
      timestamp_ms: Date.now(),
      webrtc,
      hardware: { ...this.latestHw },
    };

    this.samples.push(snapshot);
    if (this.samples.length > this.maxSamples) {
      this.samples.shift();
    }

    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch (err) {
        console.error('[WebRTCMetrics] Listener error:', err);
      }
    }
  }

  private async readWebRTCStats(dt: number): Promise<WebRTCSample> {
    const fallback: WebRTCSample = {
      timestamp_ms: Date.now(),
      rtt_ms: 0,
      jitter_ms: 0,
      audio_jitter_buffer_delay_ms: 0,
      audio_packets_lost: 0,
      audio_packets_received: 0,
      audio_packet_loss_pct: 0,
      audio_underruns_count: 0,
      video_fps: 0,
      video_bitrate_kbps: 0,
      video_frames_decoded: 0,
      video_frames_dropped: 0,
      video_drop_pct: 0,
      video_frame_time_ms: 0,
      video_encoder_wait_time_ms: 0,
      upload_kbps: 0,
      download_kbps: 0,
    };

    const room = this.room;
    if (!room) return fallback;

    try {
      // LiveKit room.engine.client expõe o RTCPeerConnection subscriber ou publisher
      const subscriberPc = (room.engine as unknown as { subscriber?: { pc?: RTCPeerConnection } })
        ?.subscriber?.pc;
      const publisherPc = (room.engine as unknown as { publisher?: { pc?: RTCPeerConnection } })
        ?.publisher?.pc;

      const pc = subscriberPc || publisherPc;
      if (!pc) return fallback;

      const report = await pc.getStats();

      let rtt = 0;
      let jitter = 0;
      let jbDelay = 0;
      let packetsLost = 0;
      let packetsReceived = 0;
      let bytesSent = 0;
      let bytesReceived = 0;
      let framesDecoded = 0;
      let framesDropped = 0;
      let fps = 0;
      let totalDecodeTime = 0;
      let underruns = 0;

      report.forEach((stat: Record<string, unknown>) => {
        // Candidate pair RTT
        if (stat.type === 'candidate-pair' && stat.state === 'succeeded' && typeof stat.currentRoundTripTime === 'number') {
          rtt = (stat.currentRoundTripTime as number) * 1000;
        }

        // Inbound Audio Track
        if (stat.type === 'inbound-rtp' && stat.kind === 'audio') {
          if (typeof stat.jitter === 'number') jitter = Math.max(jitter, (stat.jitter as number) * 1000);
          if (typeof stat.jitterBufferDelay === 'number' && typeof stat.jitterBufferEmittedCount === 'number') {
            const emitted = stat.jitterBufferEmittedCount as number;
            if (emitted > 0) {
              jbDelay = Math.max(jbDelay, ((stat.jitterBufferDelay as number) / emitted) * 1000);
            }
          }
          if (typeof stat.packetsLost === 'number') packetsLost += stat.packetsLost as number;
          if (typeof stat.packetsReceived === 'number') packetsReceived += stat.packetsReceived as number;
          if (typeof stat.bytesReceived === 'number') bytesReceived += stat.bytesReceived as number;
          if (typeof stat.totalSamplesDuration === 'number' && typeof stat.concealedSamples === 'number') {
            underruns += stat.concealedSamples as number;
          }
        }

        // Inbound Video Track
        if (stat.type === 'inbound-rtp' && stat.kind === 'video') {
          if (typeof stat.framesDecoded === 'number') framesDecoded += stat.framesDecoded as number;
          if (typeof stat.framesDropped === 'number') framesDropped += stat.framesDropped as number;
          if (typeof stat.framesPerSecond === 'number') fps = Math.max(fps, stat.framesPerSecond as number);
          if (typeof stat.totalDecodeTime === 'number') totalDecodeTime += stat.totalDecodeTime as number;
          if (typeof stat.bytesReceived === 'number') bytesReceived += stat.bytesReceived as number;
        }

        // Outbound RTP
        if (stat.type === 'outbound-rtp') {
          if (typeof stat.bytesSent === 'number') bytesSent += stat.bytesSent as number;
        }
      });

      // Delta calculations
      const deltaBytesSent = Math.max(0, bytesSent - this.prevBytesSent);
      const deltaBytesRecv = Math.max(0, bytesReceived - this.prevBytesReceived);
      this.prevBytesSent = bytesSent;
      this.prevBytesReceived = bytesReceived;

      const uploadKbps = (deltaBytesSent * 8) / (dt * 1000);
      const downloadKbps = (deltaBytesRecv * 8) / (dt * 1000);

      const deltaAudioLost = Math.max(0, packetsLost - this.prevAudioPacketsLost);
      const deltaAudioRecv = Math.max(0, packetsReceived - this.prevAudioPacketsReceived);
      this.prevAudioPacketsLost = packetsLost;
      this.prevAudioPacketsReceived = packetsReceived;

      const totalAudioPackets = deltaAudioLost + deltaAudioRecv;
      const packetLossPct = totalAudioPackets > 0 ? (deltaAudioLost / totalAudioPackets) * 100 : 0;

      const deltaDecoded = Math.max(0, framesDecoded - this.prevFramesDecoded);
      const deltaDropped = Math.max(0, framesDropped - this.prevFramesDropped);
      this.prevFramesDecoded = framesDecoded;
      this.prevFramesDropped = framesDropped;

      const totalFrames = deltaDecoded + deltaDropped;
      const dropPct = totalFrames > 0 ? (deltaDropped / totalFrames) * 100 : 0;
      const avgFrameTimeMs = deltaDecoded > 0 ? (totalDecodeTime / deltaDecoded) * 1000 : 0;

      return {
        timestamp_ms: Date.now(),
        rtt_ms: Math.round(rtt * 10) / 10,
        jitter_ms: Math.round(jitter * 10) / 10,
        audio_jitter_buffer_delay_ms: Math.round(jbDelay * 10) / 10,
        audio_packets_lost: packetsLost,
        audio_packets_received: packetsReceived,
        audio_packet_loss_pct: Math.round(packetLossPct * 10) / 10,
        audio_underruns_count: underruns,
        video_fps: Math.round(fps),
        video_bitrate_kbps: Math.round(downloadKbps),
        video_frames_decoded: framesDecoded,
        video_frames_dropped: framesDropped,
        video_drop_pct: Math.round(dropPct * 10) / 10,
        video_frame_time_ms: Math.round(avgFrameTimeMs * 10) / 10,
        video_encoder_wait_time_ms: 0,
        upload_kbps: Math.round(uploadKbps),
        download_kbps: Math.round(downloadKbps),
      };
    } catch (e) {
      return fallback;
    }
  }

  public static calculatePercentiles(values: number[]): MetricsPercentiles {
    if (values.length === 0) {
      return { p50: 0, p95: 0, p99: 0, min: 0, max: 0, avg: 0 };
    }
    const sorted = [...values].sort((a, b) => a - b);
    const count = sorted.length;

    const p50 = sorted[Math.floor(count * 0.5)] ?? 0;
    const p95 = sorted[Math.floor(count * 0.95)] ?? 0;
    const p99 = sorted[Math.floor(count * 0.99)] ?? 0;
    const min = sorted[0] ?? 0;
    const max = sorted[count - 1] ?? 0;
    const sum = sorted.reduce((acc, v) => acc + v, 0);
    const avg = sum / count;

    return {
      p50: Math.round(p50 * 100) / 100,
      p95: Math.round(p95 * 100) / 100,
      p99: Math.round(p99 * 100) / 100,
      min: Math.round(min * 100) / 100,
      max: Math.round(max * 100) / 100,
      avg: Math.round(avg * 100) / 100,
    };
  }
}
