import {
  LocalAudioTrack,
  LocalVideoTrack,
  RemoteAudioTrack,
  Room,
  RoomEvent,
  Track,
  VideoQuality,
  createAudioAnalyser,
  type LocalTrackPublication,
  type RemoteTrack,
  type RemoteTrackPublication,
} from 'livekit-client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { startDesktopGameAudio, stopDesktopGameAudio, getDesktopGameAudioLevel, hasDesktopGameAudioBridge } from '../lib/desktopGameAudio';
import { snapAudioEls, snapRoomAudio, voiceLog } from '../lib/voiceDebug';
import {
  clearVoiceWebAudio,
  removeVoiceWebAudio,
  resumeVoiceWebAudio,
  setVoiceWebAudioSink,
  upsertVoiceWebAudio,
  voiceWebAudioStats,
} from '../lib/remoteVoiceWebAudio';
import { scaleScreenTrack } from '../lib/scaleScreenTrack';
import { playVoiceJoinChime } from '../lib/voiceJoinChime';
import { createVoiceMicTrack } from '../lib/deepFilterMic';
import type { AudioDevicePrefs } from '../components/AudioSettingsDialog';

export type StageParticipant = {
  id: string;
  name: string;
  avatarUrl: string;
  speaking: boolean;
  muted: boolean;
  hasScreen: boolean;
  screenTrack?: RemoteTrack | Track;
  isLocal: boolean;
};

export type ShareScreenOpts = {
  quality?: string;
  fps?: number;
  audioMode?: 'off' | 'app' | 'system';
  bitrateMode?: 'auto' | 'fixed';
  title?: string;
  publicWatch?: boolean;
  publicWatchMax?: number;
  publicWatchCustomNames?: boolean;
  publicWatchChat?: boolean;
  publicWatchChatPost?: boolean;
};

function shareQualityBitrate(quality: string, fps: number): number {
  const q = quality || '720';
  const f = fps === 15 || fps === 60 ? fps : 30;
  const table: Record<string, Record<number, number>> = {
    source: { 15: 2_500_000, 30: 3_500_000, 60: 6_000_000 },
    '480': { 15: 1_200_000, 30: 2_000_000, 60: 3_500_000 },
    '720': { 15: 2_000_000, 30: 3_000_000, 60: 5_000_000 },
    '1080': { 15: 3_500_000, 30: 5_000_000, 60: 8_000_000 },
  };
  const row = table[q] || table['720'];
  return row[f] || row[30] || 3_000_000;
}

export type StreamStatsLine = {
  width: number;
  height: number;
  fps: number;
  uploadBps: number;
  downloadBps: number;
};

/** Níveis 0–1 por participante (voz e tela isolados). */
export type AudioSignalLevels = Record<
  string,
  { mic: number; screen: number; hasMicTrack: boolean; hasScreenTrack: boolean }
>;

export type VoiceDebugSnapshot = {
  bundle: string;
  canPlayback: boolean;
  shareLock: boolean;
  sharing: boolean;
  micOn: boolean;
  deafened: boolean;
  wasapiBridge: boolean;
  wasapiLevel: number;
  webAudio: { ctxState: string; nodes: number };
  webContentsMuted: boolean | null;
  localId: string;
  els: ReturnType<typeof snapAudioEls>;
  tracks: Array<{
    identity: string;
    name: string;
    isLocal: boolean;
    mic: { has: boolean; level: number };
    screenAudio: { has: boolean; level: number };
    screenVideo: boolean;
  }>;
};

function isScreenAudioPub(pub: {
  source?: Track.Source;
  trackName?: string;
  track?: { source?: Track.Source } | null;
}): boolean {
  const src = pub.source ?? pub.track?.source;
  if (src === Track.Source.ScreenShareAudio) return true;
  if (src === Track.Source.Microphone) return false;
  const name = String(pub.trackName || '').toLowerCase();
  return (
    name.includes('screen') ||
    name.includes('screen_share') ||
    name.includes('screenshare') ||
    name.includes('display') ||
    name.includes('loopback') ||
    name.includes('game')
  );
}

function isMicAudioPub(pub: {
  source?: Track.Source;
  trackName?: string;
  track?: { source?: Track.Source } | null;
}): boolean {
  if (isScreenAudioPub(pub)) return false;
  const src = pub.source ?? pub.track?.source;
  return src === Track.Source.Microphone;
}

/**
 * Classifica pubs de áudio: mic vs tela.
 * Com transmissão ativa, só Microphone explícito é voz — o resto (Electron/loopback
 * sem source ScreenShareAudio) vai para o slider de Tela.
 */
function splitAudioPubs(p: {
  identity: string;
  audioTrackPublications: Map<
    string,
    { source?: Track.Source; trackName?: string; track?: { source?: Track.Source } | null }
  >;
  getTrackPublication: (source: Track.Source) => { track?: unknown; source?: Track.Source } | undefined;
}) {
  const pubs = [...p.audioTrackPublications.values()].filter((pub) => !!pub.track);
  const hasScreenVideo = !!(
    typeof p.getTrackPublication === 'function' &&
    p.getTrackPublication(Track.Source.ScreenShare)?.track
  );

  const screenExplicit = pubs.filter((pub) => isScreenAudioPub(pub));
  const micExplicit = pubs.filter((pub) => isMicAudioPub(pub));
  const other = pubs.filter((pub) => !isScreenAudioPub(pub) && !isMicAudioPub(pub));

  let screen = [...screenExplicit];
  let mic = [...micExplicit];

  if (hasScreenVideo) {
    // Nuclear: com tela, "other" e qualquer sobra NÃO-mic → screen
    screen = [...screen, ...other];
    if (!screen.length && pubs.length >= 2 && micExplicit.length) {
      // Electron às vezes marca os dois como Microphone — 1º mic, resto tela
      mic = [micExplicit[0]];
      screen = pubs.filter((pub) => pub !== micExplicit[0]);
    } else if (!screen.length && pubs.length === 1 && other.length) {
      screen = other;
      mic = [];
    }
  } else {
    mic = [...mic, ...other, ...screenExplicit];
    screen = [];
  }

  return { mic, screen };
}

function setTrackGain(
  track: {
    setVolume?: (n: number) => void;
    mediaStreamTrack?: MediaStreamTrack;
  } | null | undefined,
  vol: number,
  _enabled?: boolean,
) {
  if (!track) return;
  try {
    track.setVolume?.(vol);
  } catch {
    /* ignore */
  }
  // Não desliga mediaStreamTrack — o medidor de sinal precisa do PCM com volume 0
}

function forceMuteTrack(track: {
  setVolume?: (n: number) => void;
  detach?: () => HTMLMediaElement[];
  mediaStreamTrack?: MediaStreamTrack;
}) {
  try {
    track.setVolume?.(0);
  } catch {
    /* ignore */
  }
  try {
    track.detach?.().forEach((el) => {
      try {
        el.pause();
        el.srcObject = null;
        el.remove();
      } catch {
        /* ignore */
      }
    });
  } catch {
    /* ignore */
  }
}

function isVideoRtcStat(s: {
  kind?: string;
  mediaType?: string;
  frameWidth?: number;
  frameHeight?: number;
  framesEncoded?: number;
  framesDecoded?: number;
  framesPerSecond?: number;
}): boolean {
  if (s.kind === 'audio' || s.mediaType === 'audio') return false;
  if (s.kind === 'video' || s.mediaType === 'video') return true;
  return !!(
    s.frameWidth ||
    s.frameHeight ||
    s.framesEncoded != null ||
    s.framesDecoded != null ||
    s.framesPerSecond != null
  );
}

export function formatStreamStatsLine(stats?: StreamStatsLine | null) {
  if (!stats) return '';
  const res = (() => {
    const { width: w, height: h } = stats;
    if (!w || !h) return '—';
    if (h <= 490) return '480p';
    if (h <= 730) return '720p';
    if (h <= 1090) return '1080p';
    return `${w}×${h}`;
  })();
  const formatBitrate = (bps: number) => {
    if (!bps || !Number.isFinite(bps) || bps <= 0) return '—';
    if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} Mbps`;
    return `${Math.round(bps / 1000)} kbps`;
  };
  const fps = stats.fps > 0.5 ? `${Math.round(stats.fps)}fps` : '—fps';
  return `${res} · ${fps} · ↑${formatBitrate(stats.uploadBps)} · ↓${formatBitrate(stats.downloadBps)}`;
}

export function useLiveKitRoom(
  channelId: number | null,
  enabled: boolean,
  opts?: {
    serverId?: number | null;
    audioPrefs?: AudioDevicePrefs;
  },
) {
  const [connected, setConnected] = useState(false);
  const [participants, setParticipants] = useState<StageParticipant[]>([]);
  const [micOn, setMicOn] = useState(true);
  const [deafened, setDeafened] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState('');
  const [focusIdentity, setFocusIdentity] = useState<string | null>(null);
  const [volumes, setVolumes] = useState<Record<string, { mic: number; screen: number }>>({});
  const [streamStats, setStreamStats] = useState<Record<string, StreamStatsLine>>({});
  const [audioSignals, setAudioSignals] = useState<AudioSignalLevels>({});
  const [voiceDebug, setVoiceDebug] = useState<VoiceDebugSnapshot | null>(null);
  const roomRef = useRef<Room | null>(null);
  const audioEls = useRef<
    Array<{
      el: HTMLAudioElement;
      identity: string;
      kind: 'mic' | 'screen';
      track: RemoteTrack | Track;
    }>
  >([]);
  const volumesRef = useRef(volumes);
  const prefsRef = useRef(opts?.audioPrefs);
  // Sync no render — senão o efeito do CommunityPage (filho) chama switchMic com prefs antigas
  prefsRef.current = opts?.audioPrefs;
  const deafenedRef = useRef(deafened);
  const streamStatsPrev = useRef<
    Record<string, { ts: number; bytesSent: number; bytesReceived: number; frames: number }>
  >({});
  const screenTracksRef = useRef<
    Record<string, { track: RemoteTrack | Track; isLocal: boolean }>
  >({});
  const audioMetersRef = useRef<
    Map<string, { sid: string; calculateVolume: () => number; cleanup: () => Promise<void> }>
  >(new Map());
  const connectGen = useRef(0);
  const disconnectChain = useRef(Promise.resolve());
  const chimeReady = useRef(false);
  /** Cleanup do DeepFilterNet (Electron) ao trocar mic / sair da call */
  const deepFilterDisposeRef = useRef<(() => Promise<void>) | null>(null);
  const deepFilterSetLevelRef = useRef<(n: number) => void>(() => undefined);
  const screenScalerStopRef = useRef<(() => void) | null>(null);
  /** Evita teardown de áudio remoto durante getDisplayMedia (senão a call fica muda). */
  const shareAudioLockRef = useRef(false);
  const sharingRef = useRef(false);
  const shareKeepAliveRef = useRef<number | null>(null);
  const webContentsMutedRef = useRef<boolean | null>(null);
  /** Auto-liga slider Tela uma vez quando alguém começa a transmitir (não reescreve escolha do user). */
  const autoScreenVolOnceRef = useRef(new Set<string>());

  useEffect(() => {
    sharingRef.current = sharing;
  }, [sharing]);

  /**
   * No Electron, HTMLAudioElement dá referência ao AEC WebRTC (como o Discord precisa).
   * Web Audio só quando ESTE cliente partilha ecrã — o Chromium silencia <audio> nesse caso.
   */
  const shouldUseWebAudioPlayout = useCallback(() => {
    if (typeof window === 'undefined' || !window.sfDesktop) return false;
    return !!(shareAudioLockRef.current || sharingRef.current);
  }, []);

  const applyElementPlayout = useCallback(
    (
      el: HTMLAudioElement,
      key: string,
      mst: MediaStreamTrack | undefined | null,
      vol: number,
      want: boolean,
    ) => {
      const useWa = shouldUseWebAudioPlayout();
      if (useWa) {
        el.muted = true;
        el.volume = 0;
        if (mst) upsertVoiceWebAudio(key, mst, vol, want);
        else removeVoiceWebAudio(key);
      } else {
        el.muted = !want;
        el.volume = want ? Math.max(0, Math.min(1, vol)) : 0;
        removeVoiceWebAudio(key);
        if (want && el.paused) void el.play().catch(() => undefined);
      }
      return useWa;
    },
    [shouldUseWebAudioPlayout],
  );

  const stopScreenScaler = useCallback(() => {
    try {
      screenScalerStopRef.current?.();
    } catch {
      /* ignore */
    }
    screenScalerStopRef.current = null;
  }, []);

  useEffect(() => {
    prefsRef.current = opts?.audioPrefs;
  }, [opts?.audioPrefs]);

  useEffect(() => {
    deafenedRef.current = deafened;
  }, [deafened]);

  const applyMicVolume = useCallback((identity: string) => {
    const deaf = deafenedRef.current;
    const vol = deaf ? 0 : Math.max(0, Math.min(1, volumesRef.current[identity]?.mic ?? 1));
    const screenVol = deaf ? 0 : Math.max(0, Math.min(1, volumesRef.current[identity]?.screen ?? 0));
    for (const item of audioEls.current) {
      if (item.identity !== identity || item.kind !== 'mic') continue;
      const mst = (item.track as RemoteTrack | undefined)?.mediaStreamTrack;
      applyElementPlayout(item.el, `${identity}:mic`, mst, vol, vol > 0.001 && !deaf);
    }
    const p = roomRef.current?.remoteParticipants.get(identity);
    if (!p) return;
    // Só Microphone — nunca setVolume amplo (mistura tela no Electron)
    try {
      p.setVolume(vol, Track.Source.Microphone);
    } catch {
      /* ignore */
    }
    const { mic, screen } = splitAudioPubs(p);
    for (const pub of mic) {
      setTrackGain(
        pub.track as { setVolume?: (n: number) => void; mediaStreamTrack?: MediaStreamTrack },
        vol,
        vol > 0.001 && !deaf,
      );
    }
    // Reaplica tela para não “vazar” no slider de voz
    for (const pub of screen) {
      if (screenVol <= 0.001 || deaf) {
        forceMuteTrack(
          pub.track as {
            setVolume?: (n: number) => void;
            detach?: () => HTMLMediaElement[];
            mediaStreamTrack?: MediaStreamTrack;
          },
        );
        try {
          (pub.track as { setVolume?: (n: number) => void } | null)?.setVolume?.(0);
        } catch {
          /* ignore */
        }
      } else {
        setTrackGain(
          pub.track as { setVolume?: (n: number) => void; mediaStreamTrack?: MediaStreamTrack },
          screenVol,
          true,
        );
      }
    }
    try {
      p.setVolume(screenVol <= 0.001 || deaf ? 0 : screenVol, Track.Source.ScreenShareAudio);
    } catch {
      /* ignore */
    }
  }, [applyElementPlayout]);

  const removeScreenAudioElements = useCallback((identity: string) => {
    audioEls.current = audioEls.current.filter((item) => {
      if (item.identity !== identity || item.kind !== 'screen') return true;
      try {
        item.track.detach(item.el);
      } catch {
        /* ignore */
      }
      try {
        item.el.pause();
        item.el.srcObject = null;
        item.el.remove();
      } catch {
        /* ignore */
      }
      return false;
    });
    removeVoiceWebAudio(`${identity}:screen`);
    document
      .querySelectorAll(`audio[data-comm-audio="screen"][data-identity="${CSS.escape(identity)}"]`)
      .forEach((el) => el.remove());
  }, []);

  const applyScreenVolume = useCallback(
    (identity: string) => {
      const deaf = deafenedRef.current;
      const vol = deaf ? 0 : Math.max(0, Math.min(1, volumesRef.current[identity]?.screen ?? 0));
      const micVol = deaf ? 0 : Math.max(0, Math.min(1, volumesRef.current[identity]?.mic ?? 1));
      const localId = roomRef.current?.localParticipant?.identity;
      const p = roomRef.current?.remoteParticipants.get(identity);

      if (identity === localId || vol <= 0.001) {
        removeScreenAudioElements(identity);
        if (p) {
          const { mic, screen } = splitAudioPubs(p);
          for (const pub of screen) {
            forceMuteTrack(
              pub.track as {
                setVolume?: (n: number) => void;
                detach?: () => HTMLMediaElement[];
                mediaStreamTrack?: MediaStreamTrack;
              },
            );
          }
          try {
            p.setVolume(0, Track.Source.ScreenShareAudio);
          } catch {
            /* ignore */
          }
          // Garante que mic não ficou no volume da tela por classificação errada anterior
          for (const pub of mic) {
            setTrackGain(
              pub.track as { setVolume?: (n: number) => void; mediaStreamTrack?: MediaStreamTrack },
              micVol,
              micVol > 0.001 && !deaf,
            );
          }
          try {
            p.setVolume(micVol, Track.Source.Microphone);
          } catch {
            /* ignore */
          }
        }
        return;
      }

      for (const item of audioEls.current) {
        if (item.identity !== identity || item.kind !== 'screen') continue;
        const mst = (item.track as RemoteTrack | undefined)?.mediaStreamTrack;
        applyElementPlayout(item.el, `${identity}:screen`, mst, vol, !deaf && vol > 0.001);
      }
      if (!p) return;
      try {
        p.setVolume(vol, Track.Source.ScreenShareAudio);
      } catch {
        /* ignore */
      }
      const { mic, screen } = splitAudioPubs(p);
      for (const pub of screen) {
        setTrackGain(
          pub.track as { setVolume?: (n: number) => void; mediaStreamTrack?: MediaStreamTrack },
          vol,
          true,
        );
      }
      // Mic isolado do slider de tela
      for (const pub of mic) {
        setTrackGain(
          pub.track as { setVolume?: (n: number) => void; mediaStreamTrack?: MediaStreamTrack },
          micVol,
          micVol > 0.001 && !deaf,
        );
      }
      try {
        p.setVolume(micVol, Track.Source.Microphone);
      } catch {
        /* ignore */
      }
    },
    [removeScreenAudioElements, applyElementPlayout],
  );

  const applyIdentityVolumes = useCallback(
    (identity: string) => {
      applyMicVolume(identity);
      applyScreenVolume(identity);
    },
    [applyMicVolume, applyScreenVolume],
  );

  const applyAllAudioOutput = useCallback(() => {
    const room = roomRef.current;
    const ids = new Set<string>();
    for (const item of audioEls.current) ids.add(item.identity);
    if (room) {
      for (const p of room.remoteParticipants.values()) ids.add(p.identity);
    }
    for (const id of ids) applyIdentityVolumes(id);
  }, [applyIdentityVolumes]);

  useEffect(() => {
    volumesRef.current = volumes;
    applyAllAudioOutput();
  }, [volumes, applyAllAudioOutput]);

  useEffect(() => {
    applyAllAudioOutput();
  }, [deafened, applyAllAudioOutput]);

  const applySpeaker = useCallback(async (els: HTMLAudioElement[], sinkOverride?: string) => {
    const sink = sinkOverride !== undefined ? sinkOverride : prefsRef.current?.speakerId || '';
    // Electron: voz sai no AudioContext (HTML fica mudo)
    if (typeof window !== 'undefined' && window.sfDesktop) {
      const ok = await setVoiceWebAudioSink(sink);
      voiceLog('applySpeaker:webAudioSink', { sink: sink || '(default)', ok, ...voiceWebAudioStats() });
    }
    for (const el of els) {
      const anyEl = el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
      if (typeof anyEl.setSinkId === 'function') {
        try {
          await anyEl.setSinkId(sink);
        } catch {
          /* ignore */
        }
      }
    }
    const room = roomRef.current;
    if (room && typeof room.switchActiveDevice === 'function' && sink) {
      try {
        await room.switchActiveDevice('audiooutput', sink);
      } catch {
        /* ignore — nem todos os builds expõem */
      }
    }
  }, []);

  const hardDisconnect = useCallback(async (
    leaveServerId?: number | null,
    opts?: { notifyServer?: boolean },
  ) => {
    const room = roomRef.current;
    roomRef.current = null;
    chimeReady.current = false;
    const dfDispose = deepFilterDisposeRef.current;
    deepFilterDisposeRef.current = null;
    deepFilterSetLevelRef.current = () => undefined;
    if (dfDispose) {
      try {
        await dfDispose();
      } catch {
        /* ignore */
      }
    }
    stopScreenScaler();
    if (shareKeepAliveRef.current != null) {
      window.clearInterval(shareKeepAliveRef.current);
      shareKeepAliveRef.current = null;
    }
    try {
      await window.sfDesktop?.setShareActive?.(false);
    } catch {
      /* ignore */
    }
    await stopDesktopGameAudio(room?.localParticipant).catch(() => undefined);
    clearVoiceWebAudio();
    for (const item of audioEls.current) {
      try {
        item.track.detach(item.el);
      } catch {
        /* ignore */
      }
      try {
        item.el.pause();
        item.el.srcObject = null;
      } catch {
        /* ignore */
      }
      item.el.remove();
    }
    audioEls.current = [];
    streamStatsPrev.current = {};
    screenTracksRef.current = {};
    for (const m of audioMetersRef.current.values()) {
      void m.cleanup().catch(() => undefined);
    }
    audioMetersRef.current.clear();
    setAudioSignals({});
    setStreamStats({});
    setVoiceDebug(null);
    if (room) {
      try {
        await room.disconnect(true);
      } catch {
        /* ignore */
      }
    }
    // Ao trocar de canal no mesmo servidor, o livekit-token seguinte trata o kick/Redis.
    // voice-leave aqui corrida com o token e limpa a sessão nova (palco/roster bugados).
    if (leaveServerId && opts?.notifyServer !== false) {
      await api(`/api/community/servers/${leaveServerId}/voice-leave`, {
        method: 'POST',
        body: '{}',
      }).catch(() => undefined);
    }
    setConnected(false);
    setParticipants([]);
    setSharing(false);
    setFocusIdentity(null);
    setDeafened(false);
    setMicOn(true);
  }, [stopScreenScaler]);

  const refresh = useCallback((room: Room) => {
    const list: StageParticipant[] = [];
    const push = (
      identity: string,
      name: string,
      avatarUrl: string,
      speaking: boolean,
      muted: boolean,
      hasScreen: boolean,
      screenTrack: RemoteTrack | Track | undefined,
      isLocal: boolean,
    ) => {
      list.push({
        id: identity,
        name,
        avatarUrl,
        speaking,
        muted,
        hasScreen,
        screenTrack,
        isLocal,
      });
    };

    for (const p of room.remoteParticipants.values()) {
      let screen: RemoteTrack | undefined;
      for (const pub of p.videoTrackPublications.values()) {
        if (pub.source === Track.Source.ScreenShare && pub.track) {
          screen = pub.track as RemoteTrack;
        }
      }
      push(
        p.identity,
        p.name || p.identity,
        String(p.metadata || ''),
        p.isSpeaking,
        p.isMicrophoneEnabled === false,
        !!screen,
        screen,
        false,
      );
    }
    const local = room.localParticipant;
    if (local) {
      let screen: Track | undefined;
      for (const pub of local.videoTrackPublications.values()) {
        if (pub.source === Track.Source.ScreenShare && pub.track) screen = pub.track;
      }
      push(
        local.identity,
        local.name || 'Você',
        String(local.metadata || ''),
        local.isSpeaking,
        !local.isMicrophoneEnabled,
        !!screen,
        screen,
        true,
      );
    }
    setParticipants(list);
    setSharing(list.some((p) => p.isLocal && p.hasScreen));
    const tracks: Record<string, { track: RemoteTrack | Track; isLocal: boolean }> = {};
    for (const p of list) {
      if (p.screenTrack) tracks[p.id] = { track: p.screenTrack, isLocal: p.isLocal };
    }
    screenTracksRef.current = tracks;
    setVolumes((prev) => {
      const next = { ...prev };
      for (const p of list) {
        if (!next[p.id]) next[p.id] = { mic: 1, screen: 0 };
        if (p.isLocal) continue;
        if (p.hasScreen) {
          if (!autoScreenVolOnceRef.current.has(p.id)) {
            autoScreenVolOnceRef.current.add(p.id);
            next[p.id] = { ...next[p.id], screen: 1 };
          }
        } else {
          autoScreenVolOnceRef.current.delete(p.id);
        }
      }
      return next;
    });
  }, []);

  const attachRemoteAudio = useCallback(
    (room: Room, mode?: 'full' | 'patch') => {
      const duringShare = shareAudioLockRef.current || sharingRef.current;
      const usePatch = mode === 'patch' || (duringShare && mode !== 'full');

      const attachOne = (track: RemoteTrack | Track, identity: string, kind: 'mic' | 'screen') => {
        if (kind === 'screen' && identity === room.localParticipant.identity) {
          forceMuteTrack(track as { setVolume?: (n: number) => void; detach?: () => HTMLMediaElement[] });
          return;
        }
        if (audioEls.current.some((x) => x.identity === identity && x.kind === kind)) {
          const item = audioEls.current.find((x) => x.identity === identity && x.kind === kind);
          const vol =
            kind === 'screen'
              ? Math.max(0, Math.min(1, volumesRef.current[identity]?.screen ?? 0))
              : Math.max(0, Math.min(1, volumesRef.current[identity]?.mic ?? 1));
          const want = !deafenedRef.current && vol > 0.001;
          const mst = (item?.track as RemoteTrack | undefined)?.mediaStreamTrack;
          if (item) applyElementPlayout(item.el, `${identity}:${kind}`, mst, vol, want);
          return;
        }
        try {
          track.detach().forEach((el) => el.remove());
        } catch {
          /* ignore */
        }
        const el = track.attach() as HTMLAudioElement;
        el.autoplay = true;
        el.dataset.commAudio = kind;
        el.dataset.identity = identity;
        const vol =
          kind === 'screen'
            ? Math.max(0, Math.min(1, volumesRef.current[identity]?.screen ?? 0))
            : Math.max(0, Math.min(1, volumesRef.current[identity]?.mic ?? 1));
        const want = !deafenedRef.current && vol > 0.001;
        document.body.appendChild(el);
        audioEls.current.push({ el, identity, kind, track });
        void el.play().catch((err) => {
          voiceLog('attachRemoteAudio:play-fail', {
            identity,
            kind,
            err: String((err as Error)?.message || err),
          });
        });
        const mst = (track as RemoteTrack).mediaStreamTrack;
        const key = `${identity}:${kind}`;
        // HTML = AEC consegue cancelar; Web Audio só enquanto ESTE cliente partilha ecrã
        const useWebAudio = applyElementPlayout(el, key, mst, vol, want);
        if (useWebAudio) {
          void setVoiceWebAudioSink(prefsRef.current?.speakerId || '');
        }
        voiceLog('attachRemoteAudio:webAudio', { key, ok: true, useWebAudio, ...voiceWebAudioStats() });
      };

      const bindRemotes = () => {
        const liveKeys = new Set<string>();
        for (const p of room.remoteParticipants.values()) {
          const { mic, screen } = splitAudioPubs(p);
          for (const pub of mic) {
            if (pub.track) {
              liveKeys.add(`${p.identity}:mic`);
              attachOne(pub.track as RemoteTrack, p.identity, 'mic');
            }
          }
          const screenVol = volumesRef.current[p.identity]?.screen ?? 0;
          if (!deafenedRef.current && screenVol > 0.001) {
            for (const pub of screen) {
              if (pub.track) {
                liveKeys.add(`${p.identity}:screen`);
                attachOne(pub.track as RemoteTrack, p.identity, 'screen');
              }
            }
          } else {
            for (const pub of screen) {
              if (pub.track) {
                forceMuteTrack(
                  pub.track as { setVolume?: (n: number) => void; detach?: () => HTMLMediaElement[] },
                );
                removeVoiceWebAudio(`${p.identity}:screen`);
              }
            }
          }
        }
        for (const key of voiceWebAudioStats().keys) {
          if (!liveKeys.has(key)) removeVoiceWebAudio(key);
        }
      };

      if (usePatch) {
        const before = audioEls.current.length;
        audioEls.current = audioEls.current.filter((item) => {
          const mst = (item.track as RemoteTrack | undefined)?.mediaStreamTrack;
          const dead =
            (mst && mst.readyState === 'ended') ||
            !item.el.isConnected ||
            (!(item.el as HTMLAudioElement).srcObject && !(item.el as HTMLAudioElement).src);
          if (!dead) return true;
          try {
            item.el.remove();
          } catch {
            /* ignore */
          }
          removeVoiceWebAudio(`${item.identity}:${item.kind}`);
          return false;
        });
        voiceLog('attachRemoteAudio:patch-during-share', {
          before,
          afterPrune: audioEls.current.length,
          remotes: room.remoteParticipants.size,
        });
        bindRemotes();
        void resumeVoiceWebAudio();
        applyAllAudioOutput();
        void applySpeaker(audioEls.current.map((x) => x.el));
        void window.sfDesktop?.setAudioMuted?.(false);
        return;
      }

      const before = audioEls.current.length;
      voiceLog('attachRemoteAudio:start', {
        beforeEls: before,
        shareLock: shareAudioLockRef.current,
        sharing: sharingRef.current,
        ...snapRoomAudio(room),
      });
      for (const item of audioEls.current) {
        try {
          item.track.detach(item.el);
        } catch {
          /* ignore */
        }
        try {
          item.el.pause();
          item.el.srcObject = null;
          item.el.remove();
        } catch {
          /* ignore */
        }
      }
      audioEls.current = [];
      clearVoiceWebAudio();
      bindRemotes();
      void resumeVoiceWebAudio().then((s) => voiceLog('attachRemoteAudio:webAudio-resume', s));
      applyAllAudioOutput();
      void applySpeaker(audioEls.current.map((x) => x.el));
      void window.sfDesktop?.setAudioMuted?.(false);
      voiceLog('attachRemoteAudio:done', {
        els: snapAudioEls(audioEls.current),
        canPlayback: room.canPlaybackAudio,
        webAudio: voiceWebAudioStats(),
      });
    },
    [applySpeaker, applyAllAudioOutput, applyElementPlayout],
  );

  /** Só retoma playback — NÃO faz detach/recreate (getDisplayMedia deixa elementos pausados). */
  const resumeRemoteAudio = useCallback(
    async (room?: Room | null, reason = 'unknown') => {
      const r = room || roomRef.current;
      if (!r) {
        voiceLog('resumeRemoteAudio:no-room', { reason });
        return;
      }
      const before = snapAudioEls(audioEls.current);
      voiceLog('resumeRemoteAudio:start', {
        reason,
        shareLock: shareAudioLockRef.current,
        sharing: sharingRef.current,
        canPlayback: r.canPlaybackAudio,
        els: before,
      });
      try {
        await r.startAudio();
      } catch (err) {
        voiceLog('resumeRemoteAudio:startAudio-fail', {
          reason,
          err: String((err as Error)?.message || err),
        });
      }
      applyAllAudioOutput();
      for (const item of audioEls.current) {
        try {
          const vol =
            item.kind === 'screen'
              ? volumesRef.current[item.identity]?.screen ?? 0
              : volumesRef.current[item.identity]?.mic ?? 1;
          const want = !deafenedRef.current && vol > 0.001;
          const mst = (item.track as RemoteTrack | undefined)?.mediaStreamTrack;
          applyElementPlayout(item.el, `${item.identity}:${item.kind}`, mst, vol, want);
        } catch (err) {
          voiceLog('resumeRemoteAudio:el-fail', {
            identity: item.identity,
            kind: item.kind,
            err: String((err as Error)?.message || err),
          });
        }
      }
      const wa = await resumeVoiceWebAudio();
      voiceLog('resumeRemoteAudio:webAudio', wa);
      try {
        await window.sfDesktop?.setAudioMuted?.(false);
      } catch {
        /* ignore */
      }
      if (r.remoteParticipants.size > 0) {
        const missingMic = [...r.remoteParticipants.values()].some((p) => {
          const { mic } = splitAudioPubs(p);
          return mic.some((pub) => pub.track) && !audioEls.current.some((x) => x.identity === p.identity && x.kind === 'mic');
        });
        const missingScreen = [...r.remoteParticipants.values()].some((p) => {
          const screenVol = volumesRef.current[p.identity]?.screen ?? 0;
          if (screenVol <= 0.001) return false;
          const { screen } = splitAudioPubs(p);
          return (
            screen.some((pub) => pub.track) &&
            !audioEls.current.some((x) => x.identity === p.identity && x.kind === 'screen')
          );
        });
        if (!audioEls.current.length || missingMic || missingScreen) {
          voiceLog('resumeRemoteAudio:patch-missing', {
            reason,
            remotes: r.remoteParticipants.size,
            els: audioEls.current.length,
            missingMic,
            missingScreen,
          });
          attachRemoteAudio(r, 'patch');
        }
      }
      // Unmute OS só em restores “fortes” — volumes-during-share spamava PowerShell e atrasava tudo
      if (
        reason === 'main-restore' ||
        reason === 'share-after-video' ||
        reason === 'share-after-wasapi' ||
        reason === 'share-stop'
      ) {
        try {
          const um = await window.sfDesktop?.ensureSpeakersUnmuted?.();
          voiceLog('resumeRemoteAudio:ensureSpeakers', { reason, result: um || null });
        } catch (err) {
          voiceLog('resumeRemoteAudio:ensureSpeakers-fail', {
            reason,
            err: String((err as Error)?.message || err),
          });
        }
      }
      voiceLog('resumeRemoteAudio:done', {
        reason,
        canPlayback: r.canPlaybackAudio,
        els: snapAudioEls(audioEls.current),
        webAudio: voiceWebAudioStats(),
      });
    },
    [applyAllAudioOutput, attachRemoteAudio, applyElementPlayout],
  );

  // Quando o slider Tela sobe (auto ao partilhar), anexa o áudio da stream se ainda não existir
  useEffect(() => {
    const room = roomRef.current;
    if (!room) return;
    if (shareAudioLockRef.current || sharingRef.current) {
      attachRemoteAudio(room, 'patch');
      void resumeRemoteAudio(room, 'volumes-during-share');
      return;
    }
    const needsScreenAttach = [...room.remoteParticipants.values()].some((p) => {
      const screenVol = volumes[p.identity]?.screen ?? 0;
      if (screenVol <= 0.001) return false;
      const { screen } = splitAudioPubs(p);
      if (!screen.some((pub) => pub.track)) return false;
      return !audioEls.current.some((x) => x.identity === p.identity && x.kind === 'screen');
    });
    if (needsScreenAttach) attachRemoteAudio(room);
  }, [volumes, attachRemoteAudio, resumeRemoteAudio]);

  const voiceServerIdRef = useRef(opts?.serverId);
  useEffect(() => {
    voiceServerIdRef.current = opts?.serverId;
  }, [opts?.serverId]);

  useEffect(() => {
    if (!enabled || !channelId) {
      const gen = ++connectGen.current;
      disconnectChain.current = disconnectChain.current
        .then(() => hardDisconnect(voiceServerIdRef.current))
        .catch(() => undefined);
      return () => {
        void gen;
      };
    }

    const gen = ++connectGen.current;
    let cancelled = false;
    const leaveServerId = opts?.serverId ?? null;

    disconnectChain.current = disconnectChain.current.then(async () => {
      // Troca de canal: só desliga LiveKit local; o token seguinte actualiza Redis/kick.
      await hardDisconnect(leaveServerId, { notifyServer: false });
      if (cancelled || gen !== connectGen.current) return;

      const room = new Room({ adaptiveStream: true, dynacast: true });
      roomRef.current = room;
      try {
        const data = await api<{ url: string; token: string; avatar_url?: string }>(
          `/api/community/channels/${channelId}/livekit-token`,
          { method: 'POST', body: '{}' },
        );
        if (cancelled || gen !== connectGen.current) {
          await room.disconnect(true).catch(() => undefined);
          return;
        }
        const onParticipantsChanged = () => {
          refresh(room);
        };
        const onTracksChanged = () => {
          refresh(room);
          attachRemoteAudio(room);
        };
        room.on(RoomEvent.ParticipantConnected, () => {
          onParticipantsChanged();
          attachRemoteAudio(room);
          if (chimeReady.current) void playVoiceJoinChime();
        });
        room.on(RoomEvent.ParticipantDisconnected, onTracksChanged);
        room.on(RoomEvent.TrackSubscribed, (track, pub, participant) => {
          refresh(room);
          if (pub?.source === Track.Source.ScreenShare) {
            try {
              (pub as RemoteTrackPublication).setVideoQuality?.(VideoQuality.HIGH);
            } catch {
              /* ignore */
            }
          }
          if (track.kind === Track.Kind.Audio || pub?.source === Track.Source.ScreenShareAudio) {
            const id = participant?.identity;
            if (id && pub?.source === Track.Source.ScreenShareAudio && id !== room.localParticipant.identity) {
              autoScreenVolOnceRef.current.add(id);
              setVolumes((prev) => ({
                ...prev,
                [id]: { mic: prev[id]?.mic ?? 1, screen: 1 },
              }));
            }
            attachRemoteAudio(room);
          }
        });
        room.on(RoomEvent.TrackUnsubscribed, (track) => {
          refresh(room);
          if (track.kind === Track.Kind.Audio) attachRemoteAudio(room);
        });
        room.on(RoomEvent.LocalTrackPublished, onParticipantsChanged);
        room.on(RoomEvent.LocalTrackUnpublished, onParticipantsChanged);
        room.on(RoomEvent.ActiveSpeakersChanged, () => refresh(room));
        room.on(RoomEvent.AudioPlaybackStatusChanged, () => {
          voiceLog('AudioPlaybackStatusChanged', {
            canPlayback: room.canPlaybackAudio,
            shareLock: shareAudioLockRef.current,
            sharing: sharingRef.current,
            els: snapAudioEls(audioEls.current),
          });
          if (shareAudioLockRef.current || sharingRef.current) {
            attachRemoteAudio(room, 'patch');
            void resumeRemoteAudio(room, 'AudioPlaybackStatusChanged-share');
            return;
          }
          attachRemoteAudio(room);
        });
        await room.connect(data.url, data.token);
        if (cancelled || gen !== connectGen.current) {
          await room.disconnect(true).catch(() => undefined);
          return;
        }

        const prefs = prefsRef.current;
        const mic = await createVoiceMicTrack(prefs);
        if (cancelled || gen !== connectGen.current) {
          await mic.dispose().catch(() => undefined);
          mic.track.stop();
          await room.disconnect(true).catch(() => undefined);
          return;
        }
        deepFilterDisposeRef.current = mic.dispose;
        deepFilterSetLevelRef.current = mic.setNoiseLevel;
        if (mic.deepFilter) {
          voiceLog('DeepFilterMic', { enabled: true, engine: mic.engine });
        }
        await room.localParticipant.publishTrack(mic.track);
        if (cancelled || gen !== connectGen.current) {
          await room.disconnect(true).catch(() => undefined);
          return;
        }
        setConnected(true);
        setMicOn(true);
        setError('');
        refresh(room);
        attachRemoteAudio(room);
        chimeReady.current = true;
        void playVoiceJoinChime();
      } catch (e) {
        if (!cancelled && gen === connectGen.current) {
          setError(e instanceof Error ? e.message : 'voice_error');
        }
        try {
          await room.disconnect(true);
        } catch {
          /* ignore */
        }
        if (roomRef.current === room) roomRef.current = null;
      }
    });

    return () => {
      cancelled = true;
      connectGen.current += 1;
      // Cleanup de troca/unmount: não voice-leave aqui (corrida com token / leaveVoice trata saída).
      disconnectChain.current = disconnectChain.current
        .then(() => hardDisconnect(voiceServerIdRef.current, { notifyServer: false }))
        .catch(() => undefined);
    };
    // Não depender de opts.serverId da navegação — evita reconnect ao trocar de servidor
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId, enabled, refresh, attachRemoteAudio, resumeRemoteAudio, hardDisconnect]);

  // Electron: picker/getDisplayMedia pausa o áudio da call — main process pede restore
  useEffect(() => {
      const off = window.sfDesktop?.onRestoreVoiceAudio?.(() => {
      voiceLog('onRestoreVoiceAudio', {
        shareLock: shareAudioLockRef.current,
        sharing: sharingRef.current,
        els: snapAudioEls(audioEls.current),
        ...snapRoomAudio(roomRef.current),
      });
      if (roomRef.current) attachRemoteAudio(roomRef.current, 'patch');
      void resumeRemoteAudio(roomRef.current, 'main-restore');
    });
    return () => {
      try {
        off?.();
      } catch {
        /* ignore */
      }
    };
  }, [resumeRemoteAudio, attachRemoteAudio]);

  useEffect(() => {
    void applySpeaker(
      audioEls.current.map((x) => x.el),
      opts?.audioPrefs?.speakerId || '',
    );
  }, [opts?.audioPrefs?.speakerId, applySpeaker]);

  useEffect(() => {
    if (!connected) {
      setStreamStats({});
      streamStatsPrev.current = {};
      return;
    }
    let alive = true;

    async function readTrackStats(
      track: {
        getRTCStatsReport?: () => Promise<RTCStatsReport | undefined>;
        sid?: string;
        mediaStreamTrack?: MediaStreamTrack;
        receiver?: { getStats?: () => Promise<RTCStatsReport> };
        sender?: { getStats?: () => Promise<RTCStatsReport> };
      },
      isLocal: boolean,
      identity: string,
    ): Promise<StreamStatsLine | null> {
      let width = 0;
      let height = 0;
      let fps = 0;

      const settings = track.mediaStreamTrack?.getSettings?.() || {};
      width = Number(settings.width) || 0;
      height = Number(settings.height) || 0;
      fps = Number(settings.frameRate) || 0;

      const videos = document.querySelectorAll(
        `video[data-stream-video="${CSS.escape(identity)}"]`,
      );
      for (const node of videos) {
        const videoEl = node as HTMLVideoElement & { webkitDecodedFrameCount?: number };
        if (videoEl.videoWidth) width = videoEl.videoWidth;
        if (videoEl.videoHeight) height = videoEl.videoHeight;
        const decoded = videoEl.webkitDecodedFrameCount;
        const prevKey = `dom:${identity}`;
        const prevDom = streamStatsPrev.current[prevKey];
        const nowDom = performance.now();
        if (typeof decoded === 'number') {
          if (prevDom?.ts) {
            const dtDom = Math.max(0.001, (nowDom - prevDom.ts) / 1000);
            if (decoded >= prevDom.frames) {
              const domFps = (decoded - prevDom.frames) / dtDom;
              if (domFps > 0.5) fps = domFps;
            }
          }
          streamStatsPrev.current[prevKey] = {
            ts: nowDom,
            bytesSent: 0,
            bytesReceived: 0,
            frames: decoded,
          };
        }
      }

      let report: RTCStatsReport | undefined;
      try {
        if (typeof track.getRTCStatsReport === 'function') {
          report = await track.getRTCStatsReport();
        }
      } catch {
        report = undefined;
      }
      if (!report) {
        try {
          if (isLocal && track.sender?.getStats) report = await track.sender.getStats();
          else if (!isLocal && track.receiver?.getStats) report = await track.receiver.getStats();
        } catch {
          report = undefined;
        }
      }

      const key = track.sid || track.mediaStreamTrack?.id || identity;
      const prev = streamStatsPrev.current[key] || {
        ts: 0,
        bytesSent: 0,
        bytesReceived: 0,
        frames: 0,
      };
      const now = performance.now();
      const dt = prev.ts ? Math.max(0.001, (now - prev.ts) / 1000) : 0;
      let bytesSent = prev.bytesSent || 0;
      let bytesReceived = prev.bytesReceived || 0;
      let frames = prev.frames || 0;

      if (report) {
        report.forEach((stat) => {
          const s = stat as {
            type?: string;
            kind?: string;
            mediaType?: string;
            frameWidth?: number;
            frameHeight?: number;
            width?: number;
            height?: number;
            framesPerSecond?: number;
            bytesSent?: number;
            bytesReceived?: number;
            framesEncoded?: number;
            framesDecoded?: number;
          };
          // Paridade Flask: só RTP de vídeo
          if (s.type === 'outbound-rtp' && (s.kind === 'video' || isVideoRtcStat(s))) {
            if (s.frameWidth) width = s.frameWidth;
            if (s.frameHeight) height = s.frameHeight;
            if (s.framesPerSecond) fps = s.framesPerSecond;
            if (s.bytesSent != null) bytesSent = s.bytesSent;
            if (s.framesEncoded != null) frames = s.framesEncoded;
          }
          if (s.type === 'inbound-rtp' && (s.kind === 'video' || isVideoRtcStat(s))) {
            if (s.frameWidth) width = s.frameWidth;
            if (s.frameHeight) height = s.frameHeight;
            if (s.framesPerSecond) fps = s.framesPerSecond;
            if (s.bytesReceived != null) bytesReceived = s.bytesReceived;
            if (s.framesDecoded != null) frames = s.framesDecoded;
          }
          if (s.type === 'media-source' && isVideoRtcStat(s)) {
            if (s.width) width = s.width;
            if (s.height) height = s.height;
            if (s.framesPerSecond) fps = s.framesPerSecond;
          }
        });
      }

      if ((!fps || fps <= 0) && dt && prev.ts && frames >= prev.frames) {
        fps = (frames - prev.frames) / dt;
      }
      const uploadBps =
        dt && bytesSent >= prev.bytesSent ? ((bytesSent - prev.bytesSent) * 8) / dt : 0;
      const downloadBps =
        dt && bytesReceived >= prev.bytesReceived
          ? ((bytesReceived - prev.bytesReceived) * 8) / dt
          : 0;
      streamStatsPrev.current[key] = { ts: now, bytesSent, bytesReceived, frames };

      // Mesmo sem bitrate ainda, resolução/FPS do <video> já valem
      if (!width && !height && !fps && !uploadBps && !downloadBps) return null;
      return {
        width,
        height,
        fps,
        uploadBps: isLocal ? uploadBps : 0,
        downloadBps: isLocal ? 0 : downloadBps,
      };
    }

    async function poll() {
      if (!alive) return;
      const next: Record<string, StreamStatsLine> = {};
      const entries = Object.entries(screenTracksRef.current);
      for (const [identity, { track, isLocal }] of entries) {
        const s = await readTrackStats(track, isLocal, identity);
        if (s) next[identity] = s;
      }
      // Fallback: vídeos no DOM mesmo se o ref atrasar
      document.querySelectorAll('video[data-stream-video]').forEach((node) => {
        const el = node as HTMLVideoElement;
        const id = el.getAttribute('data-stream-video');
        if (!id || next[id]) return;
        if (!el.videoWidth && !el.videoHeight) return;
        next[id] = {
          width: el.videoWidth,
          height: el.videoHeight,
          fps: 0,
          uploadBps: 0,
          downloadBps: 0,
        };
      });
      if (!alive) return;
      setStreamStats((prev) => {
        const merged: Record<string, StreamStatsLine> = {};
        for (const [id, s] of Object.entries(next)) {
          const old = prev[id];
          merged[id] = {
            width: s.width || old?.width || 0,
            height: s.height || old?.height || 0,
            fps: s.fps > 0.5 ? s.fps : old?.fps || 0,
            uploadBps: s.uploadBps > 0 ? s.uploadBps : old?.uploadBps || 0,
            downloadBps: s.downloadBps > 0 ? s.downloadBps : old?.downloadBps || 0,
          };
        }
        return merged;
      });
      // Espelha no DOM (como Flask) para o overlay não depender só do React
      for (const [id, s] of Object.entries(next)) {
        const line = formatStreamStatsLine({
          width: s.width,
          height: s.height,
          fps: s.fps,
          uploadBps: s.uploadBps,
          downloadBps: s.downloadBps,
        });
        document.querySelectorAll(`[data-stream-stats-for="${CSS.escape(id)}"]`).forEach((el) => {
          el.textContent = line;
        });
      }
    }

    void poll();
    const t = window.setInterval(() => {
      void poll();
    }, 1000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [connected]);

  // Medidores de sinal voz/tela (não dependem de volume de saída)
  useEffect(() => {
    if (!connected) {
      for (const m of audioMetersRef.current.values()) {
        void m.cleanup().catch(() => undefined);
      }
      audioMetersRef.current.clear();
      setAudioSignals({});
      setVoiceDebug(null);
      return;
    }

    type LkAudio = LocalAudioTrack | RemoteAudioTrack;
    const isLkAudio = (t: unknown): t is LkAudio =>
      t instanceof LocalAudioTrack || t instanceof RemoteAudioTrack;

    const ensureMeter = (key: string, track: LkAudio | null | undefined) => {
      if (!track) {
        const old = audioMetersRef.current.get(key);
        if (old) {
          void old.cleanup().catch(() => undefined);
          audioMetersRef.current.delete(key);
        }
        return;
      }
      const sid = track.sid || track.mediaStreamTrack?.id || key;
      const existing = audioMetersRef.current.get(key);
      if (existing && existing.sid === sid) return;
      if (existing) void existing.cleanup().catch(() => undefined);
      try {
        const { calculateVolume, cleanup } = createAudioAnalyser(track, {
          cloneTrack: true,
          fftSize: 256,
          smoothingTimeConstant: 0.55,
        });
        audioMetersRef.current.set(key, { sid, calculateVolume, cleanup });
      } catch {
        audioMetersRef.current.delete(key);
      }
    };

    const syncMeters = () => {
      const room = roomRef.current;
      if (!room) return;
      const liveKeys = new Set<string>();

      const wireParticipant = (identity: string, p: Parameters<typeof splitAudioPubs>[0]) => {
        const bySourceMic = p.getTrackPublication?.(Track.Source.Microphone)?.track;
        const bySourceScreen = p.getTrackPublication?.(Track.Source.ScreenShareAudio)?.track;
        const { mic, screen } = splitAudioPubs(p);
        const micTrack = (isLkAudio(bySourceMic) ? bySourceMic : null) || mic[0]?.track;
        const screenTrack =
          (isLkAudio(bySourceScreen) ? bySourceScreen : null) || screen[0]?.track;
        const micKey = `${identity}:mic`;
        const screenKey = `${identity}:screen`;
        liveKeys.add(micKey);
        liveKeys.add(screenKey);
        ensureMeter(micKey, isLkAudio(micTrack) ? micTrack : null);
        ensureMeter(screenKey, isLkAudio(screenTrack) ? screenTrack : null);
      };

      wireParticipant(room.localParticipant.identity, room.localParticipant);
      for (const p of room.remoteParticipants.values()) {
        wireParticipant(p.identity, p);
      }

      for (const key of [...audioMetersRef.current.keys()]) {
        if (!liveKeys.has(key)) {
          const m = audioMetersRef.current.get(key);
          if (m) void m.cleanup().catch(() => undefined);
          audioMetersRef.current.delete(key);
        }
      }
    };

    let alive = true;
    const tick = () => {
      if (!alive) return;
      syncMeters();
      const room = roomRef.current;
      const next: AudioSignalLevels = {};
      if (room) {
        const ids = new Set<string>([
          room.localParticipant.identity,
          ...[...room.remoteParticipants.keys()],
        ]);
        for (const id of ids) {
          const micM = audioMetersRef.current.get(`${id}:mic`);
          const screenM = audioMetersRef.current.get(`${id}:screen`);
          let mic = 0;
          let screen = 0;
          try {
            mic = micM ? Math.min(1, micM.calculateVolume() * 1.8) : 0;
          } catch {
            mic = 0;
          }
          try {
            screen = screenM ? Math.min(1, screenM.calculateVolume() * 1.8) : 0;
          } catch {
            screen = 0;
          }
          // Local: se o analyser do MediaStreamDestination falhar, usa nível do bridge PCM
          if (
            room.localParticipant.identity === id &&
            hasDesktopGameAudioBridge() &&
            screen < 0.02
          ) {
            screen = Math.max(screen, Math.min(1, getDesktopGameAudioLevel() * 1.4));
          }
          next[id] = {
            mic,
            screen,
            hasMicTrack: !!micM,
            hasScreenTrack: !!screenM || (room.localParticipant.identity === id && hasDesktopGameAudioBridge()),
          };
        }
      }
      setAudioSignals(next);

      if (room) {
        const trackRows: VoiceDebugSnapshot['tracks'] = [];
        const allPs = [
          room.localParticipant,
          ...[...room.remoteParticipants.values()],
        ];
        for (const p of allPs) {
          const id = p.identity;
          const sig = next[id];
          const screenVid = !!p.getTrackPublication?.(Track.Source.ScreenShare)?.track;
          trackRows.push({
            identity: id,
            name: String(p.name || id),
            isLocal: p === room.localParticipant,
            mic: { has: !!sig?.hasMicTrack, level: sig?.mic ?? 0 },
            screenAudio: { has: !!sig?.hasScreenTrack, level: sig?.screen ?? 0 },
            screenVideo: screenVid,
          });
        }
        setVoiceDebug({
          bundle: 'voice-fix-v4',
          canPlayback: !!room.canPlaybackAudio,
          shareLock: shareAudioLockRef.current,
          sharing: sharingRef.current,
          micOn: !!room.localParticipant.isMicrophoneEnabled,
          deafened: deafenedRef.current,
          wasapiBridge: hasDesktopGameAudioBridge(),
          wasapiLevel: getDesktopGameAudioLevel(),
          webAudio: voiceWebAudioStats(),
          webContentsMuted: webContentsMutedRef.current,
          localId: room.localParticipant.identity,
          els: snapAudioEls(audioEls.current),
          tracks: trackRows,
        });
        void window.sfDesktop?.getAudioMuted?.().then((r) => {
          if (r && typeof r.muted === 'boolean') webContentsMutedRef.current = r.muted;
        });
      }
    };

    tick();
    const t = window.setInterval(tick, 100);
    return () => {
      alive = false;
      window.clearInterval(t);
      for (const m of audioMetersRef.current.values()) {
        void m.cleanup().catch(() => undefined);
      }
      audioMetersRef.current.clear();
    };
  }, [connected, sharing]);

  async function switchMicDevice(override?: AudioDevicePrefs | null) {
    const room = roomRef.current;
    if (!room) return;
    const prefs = override ?? prefsRef.current;
    if (override) prefsRef.current = override;
    const prevDispose = deepFilterDisposeRef.current;
    deepFilterDisposeRef.current = null;
    deepFilterSetLevelRef.current = () => undefined;
    if (prevDispose) {
      try {
        await prevDispose();
      } catch {
        /* ignore */
      }
    }
    for (const pub of room.localParticipant.audioTrackPublications.values()) {
      // Só o mic — não despublicar áudio de partilha de ecrã
      if (pub.source === Track.Source.ScreenShareAudio) continue;
      if (pub.track) await room.localParticipant.unpublishTrack(pub.track);
    }
    const mic = await createVoiceMicTrack(prefs);
    deepFilterDisposeRef.current = mic.dispose;
    deepFilterSetLevelRef.current = mic.setNoiseLevel;
    const openedId = mic.track.mediaStreamTrack?.getSettings?.()?.deviceId || '';
    voiceLog('switchMicDevice', {
      want: prefs?.micId || '(default)',
      opened: openedId || '(unknown)',
      deepFilter: mic.deepFilter,
      engine: mic.engine,
    });
    if (mic.deepFilter) {
      voiceLog('DeepFilterMic', { enabled: true, engine: mic.engine, reason: 'switchMic' });
    }
    await room.localParticipant.publishTrack(mic.track);
    if (prefs?.micId && typeof room.switchActiveDevice === 'function') {
      try {
        await room.switchActiveDevice('audioinput', prefs.micId);
      } catch {
        /* ignore */
      }
    }
    setMicOn(true);
    setDeafened(false);
    deafenedRef.current = false;
    applyAllAudioOutput();
  }

  function setNoiseLevel(level: number) {
    deepFilterSetLevelRef.current(level);
  }

  async function toggleMic() {
    const room = roomRef.current;
    if (!room) return;
    if (deafenedRef.current) {
      deafenedRef.current = false;
      setDeafened(false);
      applyAllAudioOutput();
    }
    const next = !micOn;
    await room.localParticipant.setMicrophoneEnabled(next);
    setMicOn(next);
  }

  async function toggleDeafen() {
    const room = roomRef.current;
    if (!room) return;
    const next = !deafenedRef.current;
    deafenedRef.current = next;
    setDeafened(next);
    applyAllAudioOutput();
    if (next) {
      await room.localParticipant.setMicrophoneEnabled(false);
      setMicOn(false);
    } else {
      await room.localParticipant.setMicrophoneEnabled(true);
      setMicOn(true);
    }
  }

  function setParticipantVolume(identity: string, kind: 'mic' | 'screen', value: number) {
    const v = Math.max(0, Math.min(1, value));
    const next = {
      ...volumesRef.current,
      [identity]: {
        mic: kind === 'mic' ? v : volumesRef.current[identity]?.mic ?? 1,
        screen: kind === 'screen' ? v : volumesRef.current[identity]?.screen ?? 0,
      },
    };
    volumesRef.current = next;
    setVolumes(next);
    // Sempre re-sincroniza os dois caminhos (evita vazamento cruzado)
    if (kind === 'screen' && roomRef.current) attachRemoteAudio(roomRef.current);
    applyMicVolume(identity);
    applyScreenVolume(identity);
  }

  function focusParticipant(identity: string | null) {
    if (identity) {
      // Flask watchStream: sobe volume da tela ao assistir
      const screenVol = volumesRef.current[identity]?.screen ?? 0;
      if (screenVol <= 0.001) {
        setParticipantVolume(identity, 'screen', 1);
      } else if (roomRef.current) {
        attachRemoteAudio(roomRef.current);
      }
    }
    setFocusIdentity(identity);
  }

  async function shareScreen(optsShare?: ShareScreenOpts) {
    const room = roomRef.current;
    if (!room) return {};
    if (sharing) {
      stopScreenScaler();
      shareAudioLockRef.current = false;
      if (shareKeepAliveRef.current != null) {
        window.clearInterval(shareKeepAliveRef.current);
        shareKeepAliveRef.current = null;
      }
      try {
        await window.sfDesktop?.setShareActive?.(false);
      } catch {
        /* ignore */
      }
      await stopDesktopGameAudio(room.localParticipant).catch(() => undefined);
      const pubs = Array.from(
        room.localParticipant.trackPublications.values(),
      ) as LocalTrackPublication[];
      for (const pub of pubs) {
        if (
          (pub.source === Track.Source.ScreenShare ||
            pub.source === Track.Source.ScreenShareAudio) &&
          pub.track
        ) {
          await room.localParticipant.unpublishTrack(pub.track);
        }
      }
      setSharing(false);
      if (focusIdentity === room.localParticipant.identity) setFocusIdentity(null);
      refresh(room);
      void resumeRemoteAudio(room, 'share-stop');
      return {};
    }
    const quality = optsShare?.quality || '720';
    const fps = optsShare?.fps || 30;
    const audioMode = optsShare?.audioMode || 'app';
    const bitrateMode = optsShare?.bitrateMode || 'fixed';
    const withAudio = audioMode !== 'off';
    const height =
      quality === 'source' ? 0 : quality === '480' ? 480 : quality === '1080' ? 1080 : 720;
    const width = height ? Math.round((height * 16) / 9) : 0;
    const maxBitrate = shareQualityBitrate(quality, fps);
    const isDesktop = typeof window !== 'undefined' && !!window.sfDesktop;
    const desktop = window.sfDesktop;
    // Resolução escolhida fica fixa: simulcast só em "Fonte" + bitrate automático
    const allowSimulcast = quality === 'source' && bitrateMode === 'auto';
    shareAudioLockRef.current = true;
    voiceLog('shareScreen:start', {
      audioMode,
      withAudio,
      isDesktop,
      quality,
      fps,
      els: snapAudioEls(audioEls.current),
      ...snapRoomAudio(room),
    });
    const diagTimers: number[] = [];
    const scheduleDiag = () => {
      for (const ms of [0, 200, 500, 1000, 2000, 4000, 7000]) {
        diagTimers.push(
          window.setTimeout(() => {
            voiceLog('shareScreen:diag', {
              ms,
              shareLock: shareAudioLockRef.current,
              sharing: sharingRef.current,
              canPlayback: room.canPlaybackAudio,
              els: snapAudioEls(audioEls.current),
              bodyAudioCount: document.querySelectorAll('audio[data-comm-audio]').length,
            });
          }, ms),
        );
      }
    };
    try {
      await desktop?.setShareCapturePrefs?.({
        preferCurrentTab: false,
        audioMode,
        quality,
        fps,
        bitrateMode,
        title: optsShare?.title || '',
        publicWatch: !!optsShare?.publicWatch,
      });
      await desktop?.setShareAudioMode?.(audioMode);
    } catch {
      /* ignore */
    }
    const captureOpts: {
      audio: boolean;
      contentHint: 'detail';
      systemAudio?: 'include' | 'exclude';
      resolution?: { width: number; height: number; frameRate: number };
    } = {
      // Desktop Discord-style: NUNCA áudio no getDisplayMedia (mutava a call no Windows).
      // Áudio da app/sistema = só WASAPI depois. Browser: pode pedir áudio no GDM.
      audio: isDesktop ? false : withAudio,
      contentHint: 'detail',
    };
    if (!isDesktop && withAudio) {
      captureOpts.systemAudio = 'include';
    }
    if (height) {
      captureOpts.resolution = { width, height, frameRate: fps };
    }
    const publishOpts = {
      source: Track.Source.ScreenShare,
      simulcast: allowSimulcast,
      degradationPreference: 'maintain-resolution' as const,
      screenShareEncoding: {
        maxBitrate,
        maxFramerate: fps,
      },
      videoEncoding: {
        maxBitrate,
        maxFramerate: fps,
      },
    };
    let screenAudioPublished = false;
    let audioWarning: string | undefined;
    let pendingBrowserAudio: Awaited<
      ReturnType<Room['localParticipant']['createScreenTracks']>
    >[number] | null = null;
    try {
      voiceLog('shareScreen:createScreenTracks:before', {
        captureAudio: captureOpts.audio,
        els: snapAudioEls(audioEls.current),
      });
      const tracks = await room.localParticipant.createScreenTracks(captureOpts);
      voiceLog('shareScreen:createScreenTracks:after', {
        trackKinds: tracks.map((t) => t.kind),
        els: snapAudioEls(audioEls.current),
        canPlayback: room.canPlaybackAudio,
      });
      scheduleDiag();
      for (const track of tracks) {
        if (track.kind === Track.Kind.Audio) {
          // Só esperado no browser; no desktop GDM é video-only
          if (!isDesktop) pendingBrowserAudio = track;
          else {
            try {
              track.stop();
            } catch {
              /* ignore */
            }
          }
          continue;
        }

        if (height && width) {
          const rawMst = track.mediaStreamTrack;
          try {
            await rawMst.applyConstraints({
              width: { ideal: width, max: width },
              height: { ideal: height, max: height },
              frameRate: { ideal: fps, max: fps },
            });
          } catch {
            /* ignore */
          }
          const settings = rawMst.getSettings?.() || {};
          const needScale =
            !settings.height ||
            Math.abs(Number(settings.height) - height) > 24 ||
            !settings.width ||
            Number(settings.width) > width + 48;
          if (needScale) {
            const scaled = await scaleScreenTrack(rawMst, width, height, fps);
            screenScalerStopRef.current = () => {
              scaled.stop();
              try {
                track.stop();
              } catch {
                /* ignore */
              }
            };
            const localScaled = new LocalVideoTrack(scaled.track, undefined, true);
            await room.localParticipant.publishTrack(localScaled, publishOpts);
          } else {
            await room.localParticipant.publishTrack(track, publishOpts);
          }
        } else {
          try {
            await track.mediaStreamTrack.applyConstraints({
              frameRate: { ideal: fps, max: fps },
            });
          } catch {
            /* ignore */
          }
          await room.localParticipant.publishTrack(track, publishOpts);
        }
      }
    } catch (err) {
      for (const t of diagTimers) window.clearTimeout(t);
      shareAudioLockRef.current = false;
      voiceLog('shareScreen:createScreenTracks:error', {
        err: String((err as Error)?.message || err),
        els: snapAudioEls(audioEls.current),
      });
      stopScreenScaler();
      try {
        pendingBrowserAudio?.stop();
      } catch {
        /* ignore */
      }
      const name = String((err as { name?: string })?.name || '');
      const msg = String((err as Error)?.message || err || '');
      if (name === 'NotAllowedError' || /permission|denied|cancel/i.test(msg)) {
        throw new Error('Compartilhamento cancelado ou sem permissão.');
      }
      if (
        name === 'NotSupportedError' ||
        /not supported|não suportado|getDisplayMedia|display-capture/i.test(msg)
      ) {
        throw new Error(
          'Compartilhar tela não está disponível neste dispositivo. Atualize o app desktop ou use Chrome/Edge.',
        );
      }
      throw err instanceof Error ? err : new Error(String(err));
    }

    // Voz primeiro: NÃO bloquear a call no WASAPI (pode demorar dezenas de segundos).
    setSharing(true);
    refresh(room);
    try {
      await desktop?.setShareActive?.(true);
    } catch {
      /* ignore */
    }
    if (shareKeepAliveRef.current != null) window.clearInterval(shareKeepAliveRef.current);
    shareKeepAliveRef.current = window.setInterval(() => {
      attachRemoteAudio(room, 'patch');
      void resumeRemoteAudio(room, 'share-keepalive');
    }, 1500);
    const restoreCallAudio = async (why: string) => {
      attachRemoteAudio(room, 'patch');
      await resumeRemoteAudio(room, why);
    };
    voiceLog('shareScreen:video-ready', {
      els: snapAudioEls(audioEls.current),
      canPlayback: room.canPlaybackAudio,
    });
    await restoreCallAudio('share-after-video');
    for (const ms of [150, 400, 900, 1800, 3000]) {
      window.setTimeout(() => {
        void restoreCallAudio(`share-retry-${ms}`);
      }, ms);
    }

    // Desktop: WASAPI em background — publica a faixa já (mesmo silenciosa); a call não espera.
    if (isDesktop && withAudio) {
      voiceLog('shareScreen:wasapi:deferred', { audioMode });
      void (async () => {
        try {
          voiceLog('shareScreen:wasapi:start', { audioMode });
          const game = await startDesktopGameAudio(room.localParticipant, {
            publish: true,
            waitForSignalMs: 0,
            mode: audioMode === 'system' ? 'system' : 'app',
          });
          voiceLog('shareScreen:wasapi:result', {
            ok: game.ok,
            audible: game.audible,
            reason: game.reason,
            message: game.message,
            backend: game.backend,
            els: snapAudioEls(audioEls.current),
          });
          if (!game.ok) {
            console.warn('WASAPI screen audio failed:', game.reason, game.message);
          }
          await restoreCallAudio('share-after-wasapi');
        } catch (err) {
          voiceLog('shareScreen:wasapi:error', { err: String((err as Error)?.message || err) });
          console.warn('game audio capture error:', err);
          await restoreCallAudio('share-after-wasapi-err');
        }
      })();
    } else if (!isDesktop && withAudio && pendingBrowserAudio) {
      try {
        await room.localParticipant.publishTrack(pendingBrowserAudio, {
          source: Track.Source.ScreenShareAudio,
          dtx: false,
          red: false,
          forceStereo: true,
          audioPreset: { maxBitrate: 160_000 },
        });
        screenAudioPublished = true;
        pendingBrowserAudio = null;
      } catch (err) {
        console.warn('browser screen audio publish failed', err);
        try {
          pendingBrowserAudio?.stop();
        } catch {
          /* ignore */
        }
        pendingBrowserAudio = null;
        audioWarning = 'Sem áudio de tela — no Chrome marque “Compartilhar áudio” no seletor.';
      }
    } else if (pendingBrowserAudio) {
      try {
        pendingBrowserAudio.stop();
      } catch {
        /* ignore */
      }
      pendingBrowserAudio = null;
    }

    if (isDesktop && withAudio && !screenAudioPublished && !audioWarning) {
      // WASAPI ainda a correr em background — não alertar já
      audioWarning = undefined;
    } else if (withAudio && !screenAudioPublished && !audioWarning) {
      audioWarning = isDesktop
        ? 'Sem áudio de tela (WASAPI). A call de voz continua audível.'
        : 'sem áudio de tela — no Chrome marque “Compartilhar áudio” no seletor';
    }

    voiceLog('shareScreen:published', {
      screenAudioPublished,
      audioWarning: audioWarning || null,
      bundleHint: 'voice-fix-v2',
      els: snapAudioEls(audioEls.current),
      canPlayback: room.canPlaybackAudio,
    });
    window.setTimeout(() => {
      shareAudioLockRef.current = false;
      voiceLog('shareScreen:lock-released', {
        els: snapAudioEls(audioEls.current),
        canPlayback: room.canPlaybackAudio,
      });
    }, 3500);
    return { audioWarning };
  }

  async function leave() {
    connectGen.current += 1;
    await hardDisconnect(opts?.serverId);
  }

  return {
    connected,
    participants,
    micOn,
    deafened,
    sharing,
    focusIdentity,
    setFocusIdentity: focusParticipant,
    volumes,
    audioSignals,
    voiceDebug,
    streamStats,
    setParticipantVolume,
    toggleMic,
    toggleDeafen,
    shareScreen,
    switchMicDevice,
    setNoiseLevel,
    leave,
    error,
  };
}
