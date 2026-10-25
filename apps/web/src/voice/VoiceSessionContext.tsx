import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  loadAudioPrefs,
  normalizeAudioPrefs,
  saveAudioPrefs,
  type AudioDevicePrefs,
} from '../components/AudioSettingsDialog';
import { VoiceFloat } from '../components/VoiceFloat';
import { useLiveKitRoom } from '../hooks/useLiveKitRoom';
import { api } from '../lib/api';
import { getSocket } from '../lib/socket';
import { useAuthStore } from '../store/auth';

type VoiceMeta = { serverName: string; channelName: string };

type JoinVoiceArgs = {
  channelId: number;
  serverId: number;
  serverName: string;
  channelName: string;
};

type VoiceApi = ReturnType<typeof useLiveKitRoom>;

type VoiceSessionValue = {
  voiceChannelId: number | null;
  voiceServerId: number | null;
  voiceMeta: VoiceMeta;
  voice: VoiceApi;
  audioPrefs: AudioDevicePrefs;
  setAudioPrefs: (prefs: AudioDevicePrefs) => void;
  joinVoice: (args: JoinVoiceArgs) => void;
  clearVoiceSession: () => void;
  leaveVoice: () => void;
  /** Desconecta localmente sem limpar a sessão ativa no servidor (takeover). */
  dropVoiceLocal: () => void;
  setVoiceMeta: (meta: VoiceMeta | ((prev: VoiceMeta) => VoiceMeta)) => void;
  immersedInVoiceUi: boolean;
  /** Community voice stage is open for the active voice server */
  setImmersedInVoiceUi: (immersed: boolean) => void;
  /** Incrementado ao clicar no card flutuante — CommunityPage força view=voice. */
  voiceReturnTick: number;
  requestReturnToVoice: () => void;
};

const VoiceSessionContext = createContext<VoiceSessionValue | null>(null);

export function VoiceSessionProvider({ children }: { children: ReactNode }) {
  const user = useAuthStore((s) => s.user);
  const nav = useNavigate();
  const loc = useLocation();
  const [voiceChannelId, setVoiceChannelId] = useState<number | null>(null);
  const [voiceServerId, setVoiceServerId] = useState<number | null>(null);
  const [voiceMeta, setVoiceMeta] = useState<VoiceMeta>({
    serverName: '',
    channelName: '',
  });
  const [audioPrefs, setAudioPrefsState] = useState<AudioDevicePrefs>(() => loadAudioPrefs());
  const setAudioPrefs = useCallback((prefs: AudioDevicePrefs) => {
    const next = normalizeAudioPrefs(prefs);
    saveAudioPrefs(next);
    setAudioPrefsState(next);
  }, []);
  const [immersedInVoiceUi, setImmersedInVoiceUi] = useState(false);
  const [voiceReturnTick, setVoiceReturnTick] = useState(0);

  const voice = useLiveKitRoom(voiceChannelId, !!voiceChannelId && !!voiceServerId, {
    serverId: voiceServerId,
    audioPrefs,
  });

  const clearVoiceSession = useCallback(() => {
    const sid = voiceServerId;
    const ch = voiceChannelId;
    setVoiceChannelId(null);
    setVoiceServerId(null);
    setVoiceMeta({ serverName: '', channelName: '' });
    setImmersedInVoiceUi(false);
    if (sid) {
      void api(`/api/community/servers/${sid}/voice-leave`, {
        method: 'POST',
        body: JSON.stringify({ channel_id: ch ?? undefined }),
      }).catch(() => undefined);
    }
  }, [voiceServerId, voiceChannelId]);

  /** Sai da voz só no cliente (outra sessão tomou o canal) — não apaga active_voice no servidor. */
  const dropVoiceLocal = useCallback(() => {
    setVoiceChannelId(null);
    setVoiceServerId(null);
    setVoiceMeta({ serverName: '', channelName: '' });
    setImmersedInVoiceUi(false);
    void voice.leave().catch(() => undefined);
  }, [voice]);

  const voiceServerIdRef = useRef(voiceServerId);
  voiceServerIdRef.current = voiceServerId;
  const voiceChannelIdRef = useRef(voiceChannelId);
  voiceChannelIdRef.current = voiceChannelId;

  const joinVoice = useCallback((args: JoinVoiceArgs) => {
    if (!args.channelId || !args.serverId) return;
    if (args.channelId === voiceChannelIdRef.current && args.serverId === voiceServerIdRef.current) {
      return;
    }
    setVoiceChannelId(args.channelId);
    setVoiceServerId(args.serverId);
    setVoiceMeta({ serverName: args.serverName, channelName: args.channelName });
  }, []);

  const leaveVoice = useCallback(() => {
    void voice.leave();
    clearVoiceSession();
  }, [voice, clearVoiceSession]);

  const requestReturnToVoice = useCallback(() => {
    const sid = voiceServerIdRef.current;
    const ch = voiceChannelIdRef.current;
    if (!sid || !ch) return;
    setVoiceReturnTick((n) => n + 1);
    const path = `/comunidade/${sid}/${ch}`;
    if (loc.pathname !== path) {
      nav(path);
    }
  }, [loc.pathname, nav]);

  useEffect(() => {
    if (!user?.id) return;
    const sock = getSocket();
    const uid = Number(user.id);
    const onForce = (p: {
      server_id?: number;
      channel_id?: number;
      channel_name?: string;
      user_id?: number;
    }) => {
      if (p.user_id && Number(p.user_id) !== uid) return;
      const sid = Number(p.server_id || 0);
      const cid = Number(p.channel_id || 0);
      if (!sid || !cid) return;
      joinVoice({
        channelId: cid,
        serverId: sid,
        serverName: '',
        channelName: p.channel_name || '',
      });
    };
    const onRestore = (p: { server_id?: number; channel_id?: number; user_id?: number }) => {
      if (p.user_id && Number(p.user_id) !== uid) return;
      const sid = Number(p.server_id || 0);
      const cid = Number(p.channel_id || 0);
      if (cid && sid) {
        joinVoice({
          channelId: cid,
          serverId: sid,
          serverName: '',
          channelName: '',
        });
      } else {
        leaveVoice();
      }
    };
    sock.on('voice.force_join', onForce);
    sock.on('voice.restore', onRestore);
    return () => {
      sock.off('voice.force_join', onForce);
      sock.off('voice.restore', onRestore);
    };
  }, [user?.id, joinVoice, leaveVoice]);

  // Fecha aba/app: limpa Redis (offline) + LiveKit
  useEffect(() => {
    const flushLeave = () => {
      const sid = voiceServerIdRef.current;
      const ch = voiceChannelIdRef.current;
      if (!sid) return;
      setVoiceChannelId(null);
      setVoiceServerId(null);
      setVoiceMeta({ serverName: '', channelName: '' });
      setImmersedInVoiceUi(false);
      try {
        void fetch(`/api/community/servers/${sid}/voice-leave`, {
          method: 'POST',
          credentials: 'include',
          keepalive: true,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ offline: true, channel_id: ch ?? undefined }),
        });
      } catch {
        /* ignore */
      }
      try {
        void voice.leave();
      } catch {
        /* ignore */
      }
    };
    const onPageHide = () => flushLeave();
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('beforeunload', onPageHide);
    const offDesktop = window.sfDesktop?.onLeaving?.(flushLeave);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('beforeunload', onPageHide);
      offDesktop?.();
    };
  }, [voice]);

  useEffect(() => {
    if (!loc.pathname.startsWith('/comunidade')) {
      setImmersedInVoiceUi(false);
    }
  }, [loc.pathname]);

  const meName = user?.label || user?.username || 'Você';
  const meFace = (user?.avatar_url || '').trim();

  const showFloat =
    !!voice.connected &&
    (!loc.pathname.startsWith('/comunidade') || !immersedInVoiceUi);

  const value = useMemo<VoiceSessionValue>(
    () => ({
      voiceChannelId,
      voiceServerId,
      voiceMeta,
      voice,
      audioPrefs,
      setAudioPrefs,
      joinVoice,
      clearVoiceSession,
      leaveVoice,
      dropVoiceLocal,
      setVoiceMeta,
      immersedInVoiceUi,
      setImmersedInVoiceUi,
      voiceReturnTick,
      requestReturnToVoice,
    }),
    [
      voiceChannelId,
      voiceServerId,
      voiceMeta,
      voice,
      audioPrefs,
      joinVoice,
      clearVoiceSession,
      leaveVoice,
      dropVoiceLocal,
      immersedInVoiceUi,
      voiceReturnTick,
      requestReturnToVoice,
    ],
  );

  return (
    <VoiceSessionContext.Provider value={value}>
      {children}
      <VoiceFloat
        visible={showFloat}
        meName={meName}
        meAvatar={meFace}
        serverName={voiceMeta.serverName}
        channelName={voiceMeta.channelName}
        micOn={voice.micOn}
        deafened={voice.deafened}
        onReturn={requestReturnToVoice}
        onToggleMic={() => void voice.toggleMic()}
        onLeave={leaveVoice}
      />
    </VoiceSessionContext.Provider>
  );
}

export function useVoiceSession() {
  const ctx = useContext(VoiceSessionContext);
  if (!ctx) {
    throw new Error('useVoiceSession must be used within VoiceSessionProvider');
  }
  return ctx;
}
