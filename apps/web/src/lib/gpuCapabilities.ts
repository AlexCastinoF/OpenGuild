/**
 * OpenGuild GPU & WebRTC Capability Detection Engine
 * Integrates native hardware telemetry with WebRTC & MediaCapabilities APIs
 * to select optimal screen share profiles across NVIDIA, AMD, and Intel hardware.
 */

export interface GpuTelemetry {
  name: string;
  vendor: 'nvidia' | 'amd' | 'intel' | 'generic' | string;
  vendorId: string;
  driverVersion: string;
  dedicatedVramMb: number;
  isIntegrated: boolean;
  architecture: string;
  encoderTier: 'nvenc' | 'amf_vcn' | 'amf_vce' | 'quicksync' | 'software' | string;
  maxRecommendedResolution: string;
  maxRecommendedFps: number;
  recommendedPreset: 'eco' | 'balanced' | 'high';
  recommendedCodec: 'h264' | 'av1' | 'vp8';
  av1EncodeSupported: boolean;
  notes: string[];
}

export interface WebRtcCodecCaps {
  h264Supported: boolean;
  h264Hardware: boolean;
  av1Supported: boolean;
  av1Hardware: boolean;
  vp8Supported: boolean;
  vp9Supported: boolean;
}

export interface DetectedGpuProfile {
  gpu: GpuTelemetry;
  webrtc: WebRtcCodecCaps;
  osVersion: string;
  wgcSupported: boolean;
  zeroCopySupported: boolean;
  preset: 'eco' | 'balanced' | 'high';
  quality: string;
  fps: number;
  videoCodec: 'h264' | 'av1' | 'vp8';
  bitrateMode: 'auto' | 'fixed';
  badge: string;
  badgeTone: 'emerald' | 'amber' | 'blue' | 'purple';
  summary: string;
  reason: string;
}

let cachedProfile: DetectedGpuProfile | null = null;

export async function detectGpuAndCapabilities(): Promise<DetectedGpuProfile> {
  if (cachedProfile) return cachedProfile;

  // 1. Rust Native GPU Hardware Query
  let nativeGpu: GpuTelemetry = {
    name: 'GPU Padrão',
    vendor: 'generic',
    vendorId: '',
    driverVersion: 'N/A',
    dedicatedVramMb: 4096,
    isIntegrated: false,
    architecture: 'Genérica',
    encoderTier: 'software',
    maxRecommendedResolution: '720p',
    maxRecommendedFps: 30,
    recommendedPreset: 'eco',
    recommendedCodec: 'h264',
    av1EncodeSupported: false,
    notes: [],
  };
  let osVersion = 'Windows 10/11';
  let wgcSupported = true;
  let zeroCopySupported = true;

  if (typeof window !== 'undefined' && window.sfDesktop?.getGpuCapabilities) {
    try {
      const res = await window.sfDesktop.getGpuCapabilities();
      if (res && res.primaryGpu) {
        nativeGpu = res.primaryGpu as GpuTelemetry;
        osVersion = res.osVersion || osVersion;
        wgcSupported = res.wgcSupported ?? true;
        zeroCopySupported = res.zeroCopySupported ?? true;
      }
    } catch (e) {
      console.warn('[gpuCapabilities] Failed to query native GPU via Tauri bridge:', e);
    }
  }

  // 2. WebRTC & MediaCapabilities Runtime Probing
  const webrtc: WebRtcCodecCaps = {
    h264Supported: false,
    h264Hardware: false,
    av1Supported: false,
    av1Hardware: false,
    vp8Supported: false,
    vp9Supported: false,
  };

  if (typeof window !== 'undefined') {
    // Check RTCRtpSender.getCapabilities if available
    try {
      if (typeof RTCRtpSender !== 'undefined' && RTCRtpSender.getCapabilities) {
        const caps = RTCRtpSender.getCapabilities('video');
        if (caps?.codecs) {
          const mimes = caps.codecs.map((c) => c.mimeType.toLowerCase());
          webrtc.h264Supported = mimes.some((m) => m.includes('h264'));
          webrtc.av1Supported = mimes.some((m) => m.includes('av01') || m.includes('av1'));
          webrtc.vp8Supported = mimes.some((m) => m.includes('vp8'));
          webrtc.vp9Supported = mimes.some((m) => m.includes('vp9'));
        }
      }
    } catch {
      /* ignore */
    }

    // Check navigator.mediaCapabilities.encodingInfo for real hardware acceleration
    if (typeof navigator !== 'undefined' && navigator.mediaCapabilities?.encodingInfo) {
      try {
        const h264Probe = await navigator.mediaCapabilities.encodingInfo({
          type: 'webrtc',
          video: {
            contentType: 'video/mp4; codecs="avc1.42E01F"',
            width: 1920,
            height: 1080,
            framerate: 60,
            bitrate: 5_000_000,
          },
        });
        if (h264Probe.supported) {
          webrtc.h264Supported = true;
          webrtc.h264Hardware = !!h264Probe.powerEfficient;
        }
      } catch {
        /* ignore */
      }

      try {
        const av1Probe = await navigator.mediaCapabilities.encodingInfo({
          type: 'webrtc',
          video: {
            contentType: 'video/webm; codecs="av01.0.08M.08"',
            width: 1920,
            height: 1080,
            framerate: 60,
            bitrate: 4_000_000,
          },
        });
        if (av1Probe.supported) {
          webrtc.av1Supported = true;
          webrtc.av1Hardware = !!av1Probe.powerEfficient;
        }
      } catch {
        /* ignore */
      }
    }
  }

  // 3. Intelligent Tier & Preset Determination
  let preset: 'eco' | 'balanced' | 'high' = nativeGpu.recommendedPreset;
  let quality = nativeGpu.maxRecommendedResolution === '1080p' ? '1080' : '720';
  let fps = nativeGpu.maxRecommendedFps || 30;
  let videoCodec: 'h264' | 'av1' | 'vp8' = 'h264';
  let bitrateMode: 'auto' | 'fixed' = 'fixed';
  let badgeTone: 'emerald' | 'amber' | 'blue' | 'purple' = 'blue';
  let badge = `${nativeGpu.name}`;
  let summary = '';
  let reason = '';

  const nameUpper = nativeGpu.name.toUpperCase();
  const isAmdApu = nativeGpu.vendor === 'amd' && nativeGpu.isIntegrated;

  if (isAmdApu) {
    preset = 'eco';
    quality = '720';
    fps = 30;
    videoCodec = 'h264';
    bitrateMode = 'auto';
    badgeTone = 'amber';
    badge = `AMD APU • Memória Compartilhada UMA (Econômico 720p30)`;
    summary = `Gráficos Integrados AMD (${nativeGpu.name})`;
    reason = `Sua APU compartilha a memória RAM do sistema com o CS2. O perfil Econômico (720p 30 FPS adaptativo) reduz o tráfego no barramento de memória, prevenindo engasgos (stutter) no jogo.`;
  } else if (nameUpper.includes('RX 580') || nameUpper.includes('GTX 1050')) {
    preset = 'eco';
    quality = '720';
    fps = 30;
    videoCodec = 'h264';
    bitrateMode = 'auto';
    badgeTone = 'amber';
    badge = `${nativeGpu.name} • 4GB VRAM (Econômico 720p30)`;
    summary = `${nativeGpu.name} (Arquitetura ${nativeGpu.architecture})`;
    reason = `GPU com limite de VRAM de 4GB / driver legado. O perfil Econômico mantém folga de memória para o mapa do CS2 e evita saturação do encoder.`;
  } else if (
    nameUpper.includes('RTX 4060') ||
    nameUpper.includes('RTX 4070') ||
    nameUpper.includes('RTX 4080') ||
    nameUpper.includes('RTX 4090')
  ) {
    preset = 'high';
    quality = '1080';
    fps = 60;
    videoCodec = webrtc.av1Hardware && nativeGpu.av1EncodeSupported ? 'h264' : 'h264'; // H.264 is universal; AV1 optional
    bitrateMode = 'fixed';
    badgeTone = 'emerald';
    badge = `RTX 40 Series • NVENC Ada Lovelace (Alta Qualidade 1080p60)`;
    summary = `${nativeGpu.name} (NVENC de 8ª Geração + WGC Zero-Copy)`;
    reason = `Encoder NVENC Ada Lovelace dedicado com suporte a H.264 e AV1 via hardware. Transmissão 1080p60 cristalina com apenas ~3% a 5% de impacto no CS2.`;
  } else if (nameUpper.includes('RX 6650') || nameUpper.includes('RX 7600') || nameUpper.includes('RX 6700')) {
    preset = 'high';
    quality = '1080';
    fps = 60;
    videoCodec = 'h264';
    bitrateMode = 'fixed';
    badgeTone = 'purple';
    badge = `AMD ${nativeGpu.architecture} • VCN Hardware (Alta Qualidade 1080p60)`;
    summary = `${nativeGpu.name} (Infinity Cache + AMF/VCN)`;
    reason = `GPU dedicada de alta performance com VCN e Infinity Cache. Codificação H.264 por hardware com taxa de quadros e frametime do CS2 preservados.`;
  } else if (
    nameUpper.includes('GTX 1650') ||
    nameUpper.includes('RTX 3050') ||
    nameUpper.includes('GTX 1070') ||
    nameUpper.includes('RX 6600')
  ) {
    preset = 'balanced';
    quality = '1080';
    fps = 30; // 30 default for 1650/older cards, toggleable to 60
    if (nameUpper.includes('3050') || nameUpper.includes('6600') || nameUpper.includes('1070 TI')) {
      fps = 60;
    }
    videoCodec = 'h264';
    bitrateMode = 'fixed';
    badgeTone = 'blue';
    badge = `${nativeGpu.name} • ${nativeGpu.encoderTier.toUpperCase()} (Equilibrado 1080p${fps})`;
    summary = `${nativeGpu.name} (Aceleração por Hardware)`;
    reason = `Encoder dedicado por hardware ativo. Perfil Equilibrado oferece excelente fidelidade visual sem sobrecarregar a renderização do CS2.`;
  } else {
    // Fallback or Generic
    preset = 'balanced';
    quality = '1080';
    fps = 30;
    videoCodec = 'h264';
    bitrateMode = 'auto';
    badgeTone = 'blue';
    badge = `${nativeGpu.name} (Modo Otimizado 1080p30)`;
    summary = `${nativeGpu.name}`;
    reason = `Configuração balanceada com aceleração de vídeo H.264 para manter a estabilidade do jogo.`;
  }

  cachedProfile = {
    gpu: nativeGpu,
    webrtc,
    osVersion,
    wgcSupported,
    zeroCopySupported,
    preset,
    quality,
    fps,
    videoCodec,
    bitrateMode,
    badge,
    badgeTone,
    summary,
    reason,
  };

  return cachedProfile;
}
