import { FormEvent, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeftRight,
  AudioLines,
  ChevronDown,
  ChevronUp,
  Compass,
  Hash,
  Headphones,
  HeadphoneOff,
  House,
  Link2,
  LogOut,
  Mail,
  MessagesSquare,
  Mic,
  MicOff,
  Monitor,
  MoreVertical,
  MessageCircle,
  Pencil,
  Phone,
  PhoneOff,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  Search,
  Send,
  Settings,
  Shield,
  Table2,
  Trash2,
  UserCheck,
  UserPlus,
  UserRoundCog,
  Users,
  Volume2,
  Palette,
  CirclePlay,
} from 'lucide-react';
import { WORK_STATUS_OPTIONS, type AuthUser, type MessageDto, type ServerSummary, userIdFromIdentity } from '@steamfarm/shared';
import { api } from '../lib/api';
import { clearSteamLinkPending, isSteamLinkPending } from '../lib/steamLink';
import { StatusElapsed } from '../lib/statusElapsed';
import { getSocket } from '../lib/socket';
import {
  absIcon,
  bootNotifyPermissionPrompt,
  commChannelKey,
  commDmKey,
  formatCommTextTitle,
  formatDmTitle,
  markScreenShareNotified,
  pushNotify,
  resetScreenShareNotified,
  setViewingThread,
} from '../lib/commNotify';
import { useAuthStore } from '../store/auth';
import { useBrandStore } from '../store/brand';
import {
  CreateChannelDialog,
  CreateServerDialog,
  InviteDialog,
  JoinInviteDialog,
  JoinRequestsDialog,
  ProfileDialog,
  type ProfileTab,
  ServerSettingsDialog,
  SettingsAudioDialog,
  ChannelSettingsDialog,
  ShareScreenDialog,
  MemberProfileDialog,
} from '../components/CommunityDialogs';
import { RemoteActiveBanner, RemoteRequestModal } from '../components/RemoteAccessDialogs';
import {
  MatchConsoleKeyDialog,
  MatchConnectPrompt,
  MatchCreateDialog,
  MatchInviteModal,
  MatchSessionBanner,
} from '../components/PrivateMatchDialogs';
import { Cs2PartidasHub } from '../components/Cs2PartidasHub';
import {
  PartidasSteamGateDialog,
  fetchSteamMe,
} from '../components/PartidasSteamGateDialog';
import { Cs2MemberLiveChip, cs2LiveFromSnap } from '../components/Cs2GsiPanel';
import { useCs2Gsi, useCs2ValveAutoEnrich } from '../lib/cs2Gsi';
import { useRemoteAccess } from '../lib/remoteAccess';
import { usePrivateMatch } from '../lib/privateMatch';
import { VoiceStage } from '../components/VoiceStage';
import { VoiceDebugBalloon } from '../components/VoiceDebugBalloon';
import { useVoiceSession } from '../voice/VoiceSessionContext';
import {
  ThemeSettingsDialog,
  applyThemeState,
  type ThemeState,
} from '../components/ThemeSettingsDialog';
import { MembersManageDialog } from '../components/MembersManageDialog';
import {
  SteamSetupDialog,
  TradesListDialog,
  TradeComposerDialog,
} from '../components/SteamDialogs';
import { ShowcaseBadges, type SkinItem } from '../components/SkinPickItem';
import { ItemDetailDialog } from '../components/ItemDetailDialog';
import { WebTopNav } from '../components/WebTopNav';
import {
  WelcomeTourDialog,
  shouldAutoOpenWelcome,
} from '../components/WelcomeTourDialog';
import { WaChatPane, WaHub, WaSidePanel, useWaHub } from '../components/wa';

const DEFAULT_AVATAR = '/icon.svg';
const GEO = { lat: null as number | null, lon: null as number | null, asked: false };
let lastPingMs: number | null = null;

type Channel = {
  id: number;
  name: string;
  kind: string;
  position: number;
  icon_url: string;
  match_id?: string;
  match_team?: string;
};
type Member = {
  id: number;
  label: string;
  username: string;
  avatar_url: string;
  ramal: string;
  work_status: string;
  role: string;
  steam_linked?: boolean;
  steam_persona?: string;
  showcase_items?: Array<{
    assetid: string;
    name: string;
    icon?: string;
    icon_large?: string;
    rarity_color?: string;
  }>;
  card_color?: string | null;
  custom_roles?: Array<{
    id: number;
    name: string;
    color: string;
    position?: number;
    member_card_color?: string | null;
    border_color?: string | null;
    border_effect?: string | null;
    border_motion?: string | null;
  }>;
};
type ServerRole = {
  id: number;
  name: string;
  color: string;
  position: number;
  hoist?: boolean;
  member_card_color?: string | null;
  border_color?: string | null;
  border_effect?: string | null;
  border_motion?: string | null;
};
type PresencePayload = {
  online_users: number[];
  work_statuses: Record<string, string>;
  work_status_since?: Record<string, number>;
  online_calls: Array<{
    status?: string;
    origem?: string;
    destino?: string;
    duracao?: number;
    origem_members?: { id: number; label: string }[];
    destino_members?: { id: number; label: string }[];
  }>;
  on_call: Record<string, { origem: string; destino: string; status: string; duracao: number }>;
  pabx: { configured: boolean; ok: boolean; error: string };
  active_voice?: { server_id: number; channel_id: number } | null;
  voice_revoked?: boolean;
  presence_info: Record<
    string,
    {
      location: string;
      ping_ms: number;
      location_source?: string;
      activity?: {
        type: string;
        title?: string;
        url?: string;
        videoId?: string;
        startedAt?: number;
      } | null;
      cs2_live?: {
        at: number;
        map: string;
        scoreCt: number;
        scoreT: number;
        team: string;
        kills: number;
        deaths: number;
        health: number;
        kind?: 'match' | 'lobby';
        mode?: string;
        modeLabel?: string;
        phase?: string;
      } | null;
    }
  >;
      presence: Record<
    string,
    Array<{
      identity: string;
      name: string;
      user_id: number;
      avatar_url: string;
      ramal?: string;
      work_status?: string;
      location?: string;
      location_source?: string;
      ping_ms?: number | null;
    }>
  >;
};

type ServerDetail = {
  id: number;
  name: string;
  icon_url: string;
  banner_url: string;
  description: string;
  is_listed: boolean;
  channels: Channel[];
  members: Member[];
  roles?: ServerRole[];
  livekit: boolean;
  role: string;
  /** Permissões efetivas (cargos + papel + @everyone), as mesmas que a API aplica */
  permissions?: string[];
};

/** Qualquer uma destas abre a UI de moderação; a API valida cada ação de verdade. */
const MODERATION_PERMISSIONS = [
  'server.manage',
  'server.delete',
  'roles.manage',
  'members.kick',
  'members.assign_roles',
  'invites.manage',
  'join_requests.handle',
  'channels.create',
  'channels.edit',
  'channels.delete',
  'channels.reorder',
  'messages.delete_any',
];

const MEMBERS_PANEL_PREFS_KEY = 'steamfarm.membersPanel';

function loadMembersPanelPrefs() {
  try {
    const raw = localStorage.getItem(MEMBERS_PANEL_PREFS_KEY);
    if (!raw) return { sortByRole: false, hideOffline: false, panelOpen: true };
    const p = JSON.parse(raw) as {
      sortByRole?: boolean;
      hideOffline?: boolean;
      panelOpen?: boolean;
    };
    return {
      sortByRole: !!p.sortByRole,
      hideOffline: !!p.hideOffline,
      panelOpen: p.panelOpen !== false,
    };
  } catch {
    return { sortByRole: false, hideOffline: false, panelOpen: true };
  }
}

function memberSortedCustoms(m: Member, rolesById?: Map<number, ServerRole>) {
  return [...(m.custom_roles || [])].sort((a, b) => {
    const pa = rolesById?.get(a.id)?.position ?? a.position ?? 0;
    const pb = rolesById?.get(b.id)?.position ?? b.position ?? 0;
    return pb - pa;
  });
}

function memberCardAccent(m: Member, rolesById?: Map<number, ServerRole>) {
  if (m.card_color) return m.card_color;
  const top = memberSortedCustoms(m, rolesById)[0];
  if (top?.member_card_color) return top.member_card_color;
  if (top?.color) return top.color;
  if (m.role === 'owner') return '#f0b232';
  if (m.role === 'admin') return '#5865f2';
  return '';
}

function memberPrimaryCargo(m: Member, rolesById?: Map<number, ServerRole>) {
  const top = memberSortedCustoms(m, rolesById)[0];
  if (top) {
    const full = rolesById?.get(top.id);
    return {
      name: top.name,
      color: top.color || '#949ba4',
      border_color: full?.border_color || top.border_color || top.color || '#949ba4',
      border_effect: full?.border_effect || top.border_effect || 'solid',
      border_motion: full?.border_motion || top.border_motion || 'none',
    };
  }
  if (m.role === 'owner') {
    return {
      name: 'Dono',
      color: '#f0b232',
      border_color: '#f0b232',
      border_effect: 'glow',
      border_motion: 'none',
    };
  }
  if (m.role === 'admin') {
    return {
      name: 'Admin',
      color: '#5865f2',
      border_color: '#5865f2',
      border_effect: 'solid',
      border_motion: 'none',
    };
  }
  return {
    name: 'Membro',
    color: '#949ba4',
    border_color: '#949ba4',
    border_effect: 'solid',
    border_motion: 'none',
  };
}

function memberRoleGroupMeta(m: Member, rolesById: Map<number, ServerRole>) {
  const top = memberSortedCustoms(m, rolesById)[0];
  if (top) {
    const full = rolesById.get(top.id);
    return {
      key: `role:${top.id}`,
      label: top.name,
      color: top.color || '#949ba4',
      sort: full?.position ?? top.position ?? 0,
    };
  }
  if (m.role === 'owner') {
    return { key: 'builtin:owner', label: 'Dono', color: '#f0b232', sort: 1_000_000 };
  }
  if (m.role === 'admin') {
    return { key: 'builtin:admin', label: 'Admin', color: '#5865f2', sort: 999_999 };
  }
  return { key: 'builtin:member', label: 'Membro', color: '#949ba4', sort: -1 };
}

function statusLabel(id: string) {
  if (id === 'em_chamada') return 'Em chamada';
  return WORK_STATUS_OPTIONS.find((o) => o.id === id)?.label || 'Disponível';
}

function pingQuality(ms: number) {
  const n = Math.round(Number(ms) || 0);
  if (n <= 80) return 'good';
  if (n <= 150) return 'ok';
  if (n <= 250) return 'fair';
  return 'bad';
}

type DmThread = {
  other_user: { id: number; label: string; username: string; avatar_url: string };
  server_id: number | null;
  server_name: string;
  last_message: string;
  unread: boolean;
};

type DmMessage = {
  id: number;
  body: string;
  mine: boolean;
  user: { id: number; label: string; avatar_url: string };
};

function Avatar({ name, url }: { name: string; url?: string }) {
  const src = (url || '').trim() || DEFAULT_AVATAR;
  return (
    <img
      className="comm-avatar"
      src={src}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={(e) => {
        (e.target as HTMLImageElement).src = DEFAULT_AVATAR;
      }}
    />
  );
}

function ChannelIcon({ channel }: { channel: Channel }) {
  const [failed, setFailed] = useState(false);
  const custom = (channel.icon_url || '').trim();
  if (custom && !failed) {
    return (
      <img
        className="comm-ch-icon-img"
        src={custom}
        alt=""
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    );
  }
  if (channel.kind === 'screen') return <Monitor size={16} />;
  if (channel.kind === 'voice') return <Volume2 size={16} />;
  return <Hash size={16} />;
}

export function CommunityPage() {
  const { serverId: sidParam, channelId: cidParam } = useParams();
  const serverId = sidParam ? Number(sidParam) : null;
  const channelId = cidParam ? Number(cidParam) : null;
  const nav = useNavigate();
  const qc = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const brandName = useBrandStore((s) => s.name);
  const remote = useRemoteAccess({
    userId: user?.id,
    serverId: serverId || undefined,
    enabled: !!user,
  });
  const privateMatch = usePrivateMatch({
    userId: user?.id,
    serverId: serverId || undefined,
    enabled: !!user,
  });
  const [matchCreateOpen, setMatchCreateOpen] = useState(false);
  const [matchConsoleKeyOpen, setMatchConsoleKeyOpen] = useState(false);
  const cs2Gsi = useCs2Gsi();
  useCs2ValveAutoEnrich(!!user);

  const matchVoiceIds = useMemo(() => {
    const ids = new Set<number>();
    for (const r of privateMatch.serverRooms || []) {
      for (const n of Object.values(r.voiceChannels || {})) {
        if (n) ids.add(Number(n));
      }
    }
    for (const n of Object.values(privateMatch.active?.voiceChannels || {})) {
      if (n) ids.add(Number(n));
    }
    return ids;
  }, [privateMatch.serverRooms, privateMatch.active?.voiceChannels]);

  const [view, setView] = useState<'empty' | 'chat' | 'voice' | 'dm' | 'match'>('empty');

  const [partidasSteamGateOpen, setPartidasSteamGateOpen] = useState(false);
  const [partidasLobbyFocus, setPartidasLobbyFocus] = useState(0);

  async function ensurePartidasSteam(): Promise<boolean> {
    try {
      const m = await fetchSteamMe();
      if (m.steam_linked && m.steam_id64) {
        return true;
      }
    } catch {
      /* fall through */
    }
    setPartidasSteamGateOpen(true);
    return false;
  }

  function openPartidasChannel(opts?: {
    requireSteam?: boolean;
    focusLobby?: boolean;
    serverId?: number;
  }) {
    const sid = opts?.serverId || serverId;
    if (!sid) return;
    const go = () => {
      setIsWaHub(false);
      setView('match');
      nav(`/comunidade/${sid}`);
      if (opts?.focusLobby) {
        setPartidasLobbyFocus((n) => n + 1);
      }
    };
    // Aceitar convite: entra já no canal Partidas; Steam gate não bloqueia a navegação
    if (opts?.requireSteam === false) {
      go();
      void ensurePartidasSteam();
      return;
    }
    void ensurePartidasSteam().then((ok) => {
      if (!ok) return;
      go();
    });
  }
  const [createOpen, setCreateOpen] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [workStatus, setWorkStatus] = useState('');
  const statusBarRef = useRef<HTMLDivElement | null>(null);
  const [channelOpen, setChannelOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'appearance' | 'roles'>('appearance');
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileTab, setProfileTab] = useState<ProfileTab>('appearance');
  const [steamOpen, setSteamOpen] = useState(false);
  const [itemDetail, setItemDetail] = useState<SkinItem | null>(null);
  const [tradesOpen, setTradesOpen] = useState(false);
  const [tradePartner, setTradePartner] = useState<{ id: number; label: string } | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [audioOpen, setAudioOpen] = useState(false);
  const [requestsOpen, setRequestsOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [publicWatch, setPublicWatch] = useState<{ url: string; sessionId: number } | null>(null);
  const [channelEdit, setChannelEdit] = useState<Channel | null>(null);
  const [memberProfile, setMemberProfile] = useState<Member | null>(null);
  const [membersManageOpen, setMembersManageOpen] = useState(false);
  const {
    voiceChannelId,
    voiceServerId,
    voiceMeta,
    voice,
    audioPrefs,
    setAudioPrefs,
    joinVoice,
    leaveVoice,
    dropVoiceLocal,
    setVoiceMeta,
    setImmersedInVoiceUi,
    voiceReturnTick,
  } = useVoiceSession();
  const [inviteInfo, setInviteInfo] = useState({ url: '', code: '' });
  const [dmUserId, setDmUserId] = useState<number | null>(null);
  const [dmServerId, setDmServerId] = useState<number | null>(null);
  const [dmUnread, setDmUnread] = useState(0);
  const [dmThreads, setDmThreads] = useState<DmThread[]>([]);
  const [dmMessages, setDmMessages] = useState<DmMessage[]>([]);
  const [dmDraft, setDmDraft] = useState('');
  const [draft, setDraft] = useState('');
  const [messages, setMessages] = useState<MessageDto[]>([]);
  /** Aviso de sistema do servidor (ex.: Partida Privada) — visível em Partidas e chat. */
  const [serverSystemNotice, setServerSystemNotice] = useState<string | null>(null);
  const [memberGroupsOpen, setMemberGroupsOpen] = useState({ online: true, offline: true });
  const [roleGroupsOpen, setRoleGroupsOpen] = useState<Record<string, boolean>>({});
  const [membersSortByRole, setMembersSortByRole] = useState(
    () => loadMembersPanelPrefs().sortByRole,
  );
  const [membersHideOffline, setMembersHideOffline] = useState(
    () => loadMembersPanelPrefs().hideOffline,
  );
  const [membersPanelOpen, setMembersPanelOpen] = useState(
    () => loadMembersPanelPrefs().panelOpen,
  );
  const [welcomeOpen, setWelcomeOpen] = useState(false);
  const [isWaHub, setIsWaHub] = useState(false);
  const wa = useWaHub(isWaHub);
  const [desktopUpdate, setDesktopUpdate] = useState<{
    ready?: boolean;
    downloading?: boolean;
    version?: string;
  } | null>(null);
  const [desktopUpdateDismissed, setDesktopUpdateDismissed] = useState(false);
  const [profileRamal, setProfileRamal] = useState('');
  const [requestsCount, setRequestsCount] = useState(0);
  const [themeOpen, setThemeOpen] = useState(false);
  const [themeState, setThemeState] = useState<ThemeState>({ surfaces: {}, chrome: {} });
  const commRootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!user) return;
    api<{ surfaces: ThemeState['surfaces']; chrome: ThemeState['chrome'] }>(
      '/api/community/themes/me',
    )
      .then((d) => setThemeState({ surfaces: d.surfaces || {}, chrome: d.chrome || {} }))
      .catch(() => undefined);
  }, [user]);

  useEffect(() => {
    if (!user) return;
    if (!shouldAutoOpenWelcome()) return;
    const t = window.setTimeout(() => setWelcomeOpen(true), 800);
    return () => window.clearTimeout(t);
  }, [user]);

  useEffect(() => {
    localStorage.setItem(
      MEMBERS_PANEL_PREFS_KEY,
      JSON.stringify({
        sortByRole: membersSortByRole,
        hideOffline: membersHideOffline,
        panelOpen: membersPanelOpen,
      }),
    );
  }, [membersSortByRole, membersHideOffline, membersPanelOpen]);

  useEffect(() => {
    document.body.classList.add('page-community');
    return () => document.body.classList.remove('page-community');
  }, []);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const steam = q.get('steam');
    if (steam === 'linked' || steam === 'error') {
      setSteamOpen(true);
      const err = q.get('steam_err');
      if (err) sessionStorage.setItem('sf_steam_link_err', err);
      else if (steam === 'linked') {
        sessionStorage.removeItem('sf_steam_link_err');
        clearSteamLinkPending();
      }
      q.delete('steam');
      q.delete('steam_err');
      const next = `${window.location.pathname}${q.toString() ? `?${q}` : ''}${window.location.hash}`;
      window.history.replaceState({}, '', next);
    }
  }, []);

  /** Desktop: após OpenID no browser externo, detetar vínculo e avisar a UI. */
  useEffect(() => {
    if (!user) return;
    let stopped = false;
    const tick = async () => {
      if (!isSteamLinkPending()) return;
      try {
        const m = await api<{ steam_linked?: boolean }>('/api/steam/me');
        if (stopped) return;
        if (m.steam_linked) {
          clearSteamLinkPending();
          window.dispatchEvent(new Event('sf-steam-linked'));
          setSteamOpen(true);
        }
      } catch {
        /* ignore */
      }
    };
    void tick();
    const t = window.setInterval(() => void tick(), 2000);
    const onVis = () => {
      if (document.visibilityState === 'visible') void tick();
    };
    window.addEventListener('focus', onVis);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      stopped = true;
      window.clearInterval(t);
      window.removeEventListener('focus', onVis);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [user]);

  useEffect(() => {
    api<{ user: AuthUser | null; needs_setup?: boolean }>('/api/auth/status')
      .then((s) => {
        if (s.needs_setup) nav('/setup');
        else if (!s.user) nav('/login');
        else setUser(s.user);
      })
      .catch(() => nav('/login'));
  }, [nav, setUser]);

  const serversQ = useQuery({
    queryKey: ['servers'],
    queryFn: () => api<{ servers: ServerSummary[] }>('/api/community/servers'),
    enabled: !!user,
  });

  useEffect(() => {
    if (!serverId && serversQ.data?.servers?.[0]) {
      nav(`/comunidade/${serversQ.data.servers[0].id}`, { replace: true });
    }
  }, [serverId, serversQ.data, nav]);

  const serverQ = useQuery({
    queryKey: ['server', serverId],
    queryFn: () => api<{ server: ServerDetail }>(`/api/community/servers/${serverId}`),
    enabled: !!serverId && !!user,
  });

  const server = serverQ.data?.server;
  const hasServer = !!server;
  // Dono/admin sempre; membro comum só se algum cargo der permissão de moderação
  const canModerate =
    !!server &&
    (server.role !== 'member' ||
      (server.permissions || []).some((p) => MODERATION_PERMISSIONS.includes(p)));
  const activeChannel = useMemo(
    () => server?.channels.find((c) => c.id === channelId) || null,
    [server, channelId],
  );

  useEffect(() => {
    if (!activeChannel) {
      if (view !== 'dm' && view !== 'match') setView('empty');
      return;
    }
    // Não sobrescrever DM / Partidas: openPartidas/enterDm mudam a view antes da URL
    // limpar o canal; sem este return a view voltava à voz no mesmo tick.
    if (view === 'dm' || view === 'match') return;
    if (activeChannel.kind === 'text') setView('chat');
    else {
      setView('voice');
      if (serverId) {
        joinVoice({
          channelId: activeChannel.id,
          serverId,
          serverName: server?.name || voiceMeta.serverName,
          channelName: activeChannel.name,
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChannel, view, serverId]);

  // Card flutuante: só reage ao clique (tick). Não re-correr quando Partidas limpa a URL,
  // senão voiceReturnTick antigo forçava regresso à voz.
  const voiceReturnHandled = useRef(0);
  useEffect(() => {
    if (!voiceReturnTick || voiceReturnTick === voiceReturnHandled.current) return;
    voiceReturnHandled.current = voiceReturnTick;
    if (!voiceServerId || !voiceChannelId) return;
    setIsWaHub(false);
    setView('voice');
    nav(`/comunidade/${voiceServerId}/${voiceChannelId}`);
  }, [voiceReturnTick, voiceServerId, voiceChannelId, nav]);

  useEffect(() => {
    if (!user) return;
    const t = setInterval(() => {
      void api<{ count: number }>('/api/community/dm/unread')
        .then((d) => setDmUnread(d.count))
        .catch(() => undefined);
    }, 30000);
    void api<{ count: number }>('/api/community/dm/unread')
      .then((d) => setDmUnread(d.count))
      .catch(() => undefined);
    return () => clearInterval(t);
  }, [user]);

  useEffect(() => {
    if (view !== 'dm' || !user) return;
    let stop = false;
    async function loadThreads() {
      const d = await api<{ threads: DmThread[] }>('/api/community/dm');
      if (stop) return;
      setDmThreads(d.threads || []);
      if (!dmUserId && d.threads?.length) {
        const first = d.threads[0];
        setDmUserId(first.other_user.id);
        setDmServerId(first.server_id);
      }
      void api<{ count: number }>('/api/community/dm/unread')
        .then((u) => setDmUnread(u.count))
        .catch(() => undefined);
    }
    void loadThreads().catch(() => undefined);
    const t = setInterval(() => void loadThreads().catch(() => undefined), 15000);
    return () => {
      stop = true;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, user]);

  useEffect(() => {
    if (view !== 'dm' || !dmUserId) {
      setDmMessages([]);
      return;
    }
    let stop = false;
    async function loadMsgs() {
      const q = dmServerId ? `?server_id=${dmServerId}` : '';
      const d = await api<{ messages: DmMessage[] }>(`/api/community/dm/${dmUserId}${q}`);
      if (stop) return;
      setDmMessages(d.messages || []);
      void api<{ count: number }>('/api/community/dm/unread')
        .then((u) => setDmUnread(u.count))
        .catch(() => undefined);
    }
    void loadMsgs().catch(() => undefined);
    const t = setInterval(() => void loadMsgs().catch(() => undefined), 4000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [view, dmUserId, dmServerId]);

  useEffect(() => {
    if (!user) return;
    void api<{ user: { ramal: string; label: string; avatar_url: string } }>(
      '/api/community/me/profile',
    )
      .then((d) => setProfileRamal(d.user.ramal || ''))
      .catch(() => undefined);
  }, [user]);

  useEffect(() => {
    if (!user) return;
    const load = () =>
      api<{ requests: unknown[] }>('/api/community/join-requests')
        .then((d) => setRequestsCount(d.requests?.length || 0))
        .catch(() => undefined);
    void load();
    const t = setInterval(() => void load(), 30000);
    return () => clearInterval(t);
  }, [user, serverId]);

  useEffect(() => {
    bootNotifyPermissionPrompt();
  }, []);

  useEffect(() => {
    const desk = window.sfDesktop;
    if (!desk?.getUpdateStatus) return;
    let unsub: (() => void) | undefined;
    void desk.getUpdateStatus().then((s) => setDesktopUpdate(s || null)).catch(() => undefined);
    if (desk.onUpdateStatus) {
      unsub = desk.onUpdateStatus((s) => setDesktopUpdate(s || null));
    }
    return () => unsub?.();
  }, []);

  useEffect(() => {
    if (view === 'chat' && channelId) {
      setViewingThread(commChannelKey(channelId), true);
      return () => setViewingThread(commChannelKey(channelId), false);
    }
    if (view === 'dm' && dmUserId) {
      setViewingThread(commDmKey(dmUserId, dmServerId), true);
      return () => setViewingThread(commDmKey(dmUserId, dmServerId), false);
    }
    return undefined;
  }, [view, channelId, dmUserId, dmServerId]);

  // Socket do servidor: mensagens (UI + notify) mesmo fora do chat de texto
  useEffect(() => {
    setServerSystemNotice(null);
  }, [serverId]);

  useEffect(() => {
    const sys = privateMatch.active?.feed?.find((f) => f.type === 'system');
    if (sys?.text) setServerSystemNotice(sys.text);
  }, [privateMatch.active?.id, privateMatch.active?.feed]);

  useEffect(() => {
    if (!serverId || !user) return;
    const sock = getSocket();
    sock.emit('join_server', { serverId });
    const onMsg = (msg: MessageDto) => {
      const isSystem =
        !!msg.system ||
        /^\s*⚙️/.test(msg.body || '') ||
        /Partida Privada Castino\.Tech/i.test(msg.body || '');
      const mine = Number(msg.user?.id) === user.id;
      const onOpenChat = msg.channel_id === channelId && view === 'chat';

      // Mensagens de sistema: sempre entram no canal aberto (mesmo sendo tuas).
      if (isSystem) {
        if (onOpenChat) {
          setMessages((prev) =>
            prev.some((m) => m.id === msg.id) ? prev : [...prev, { ...msg, system: true }],
          );
        }
        setServerSystemNotice(
          String(msg.body || '')
            .replace(/^\s*⚙️\s*/, '')
            .trim() || 'Partida Privada Castino.Tech',
        );
        return;
      }

      if (mine) {
        if (onOpenChat) {
          setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
        }
        return;
      }
      if (onOpenChat) {
        setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
      }
      const shouldNotify = !onOpenChat || document.visibilityState === 'hidden';
      if (!shouldNotify) return;
      const chName =
        (server?.channels || []).find((c) => c.id === msg.channel_id)?.name || 'Canal';
      const sender = msg.user?.label || msg.user?.username || 'Alguém';
      pushNotify({
        kind: 'community.text_message',
        threadKey: commChannelKey(msg.channel_id),
        title: formatCommTextTitle(server?.name || 'Servidor', chName, sender),
        body: msg.body || '',
        icon: absIcon(msg.user?.avatar_url),
        onClick: () => {
          nav(`/comunidade/${serverId}/${msg.channel_id}`);
          setView('chat');
        },
      });
    };
    const onSystemNotice = (payload: { body?: string }) => {
      const text = String(payload?.body || '').trim();
      if (text) setServerSystemNotice(text);
    };
    sock.on('message:new', onMsg);
    sock.on('server:system_notice', onSystemNotice);
    // Entrada/saída de voz ou desconexão: refaz o roster na hora (o polling é só fallback)
    const onPresence = (payload: { server_id?: number }) => {
      if (Number(payload?.server_id) !== Number(serverId)) return;
      void qc.invalidateQueries({ queryKey: ['presence', serverId] });
    };
    sock.on('presence:changed', onPresence);
    return () => {
      sock.off('message:new', onMsg);
      sock.off('server:system_notice', onSystemNotice);
      sock.off('presence:changed', onPresence);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId, user?.id, channelId, view, server?.name, server?.channels]);

  useEffect(() => {
    if (!user) return;
    const sock = getSocket();
    const onForce = (p: {
      server_id?: number;
      channel_id?: number;
      channel_name?: string;
      user_id?: number;
    }) => {
      if (p.user_id && user?.id && Number(p.user_id) !== Number(user.id)) return;
      const sid = Number(p.server_id || 0);
      const cid = Number(p.channel_id || 0);
      if (!sid || !cid) return;
      joinVoice({
        channelId: cid,
        serverId: sid,
        serverName: server?.name || '',
        channelName: p.channel_name || '',
      });
      void qc.invalidateQueries({ queryKey: ['server', sid] });
    };
    const onRestore = (p: { server_id?: number; channel_id?: number; user_id?: number }) => {
      if (p.user_id && user?.id && Number(p.user_id) !== Number(user.id)) return;
      const sid = Number(p.server_id || serverId || 0);
      const cid = Number(p.channel_id || 0);
      void (async () => {
        if (sid) await qc.invalidateQueries({ queryKey: ['server', sid] });
        await new Promise((r) => setTimeout(r, 450));
        if (cid && sid) {
          const latest = qc.getQueryData<{ channels?: Array<{ id: number; name?: string }> }>([
            'server',
            sid,
          ]);
          const ch =
            latest?.channels?.find((c) => c.id === cid) ||
            server?.channels.find((c) => c.id === cid);
          joinVoice({
            channelId: cid,
            serverId: sid,
            serverName: server?.name || '',
            channelName: ch?.name || '',
          });
        } else {
          leaveVoice();
        }
      })();
    };
    const onChannels = (p: { matchId?: string }) => {
      if (serverId) void qc.invalidateQueries({ queryKey: ['server', serverId] });
      void p;
    };
    sock.on('voice.force_join', onForce);
    sock.on('voice.restore', onRestore);
    sock.on('server.channels', onChannels);
    const onServerUpdated = () => {
      if (serverId) void qc.invalidateQueries({ queryKey: ['server', serverId] });
    };
    sock.on('server.updated', onServerUpdated);
    return () => {
      sock.off('voice.force_join', onForce);
      sock.off('voice.restore', onRestore);
      sock.off('server.channels', onChannels);
      sock.off('server.updated', onServerUpdated);
    };
  }, [user, serverId, server?.name, server?.channels, joinVoice, leaveVoice, qc]);

  useEffect(() => {
    const m = privateMatch.active;
    if (!m?.voiceChannels) return;
    if (m.status !== 'host_booting' && m.status !== 'connecting' && m.status !== 'live') return;
    const me = m.players.find((p) => p.userId === user?.id);
    if (!me || me.inviteStatus === 'pending' || me.inviteStatus === 'declined') return;
    const ch = m.voiceChannels;
    const cid =
      me.team === 'T' ? ch.T : me.team === 'SPEC' ? ch.SPEC : me.team === 'CT' ? ch.CT : 0;
    if (!cid) return;
    joinVoice({
      channelId: cid,
      serverId: m.serverId,
      serverName: server?.name || '',
      channelName: me.team === 'T' ? '🥷 TR' : me.team === 'SPEC' ? '👁 Assistir' : '👮‍♂️ CT',
    });
  }, [
    privateMatch.active?.id,
    privateMatch.active?.status,
    privateMatch.active?.voiceChannels?.CT,
    privateMatch.active?.voiceChannels?.T,
    privateMatch.active?.voiceChannels?.SPEC,
    privateMatch.active?.players,
    user?.id,
    server?.name,
    joinVoice,
  ]);

  const gsiIngestAt = useRef(0);
  const gameoverEndedRef = useRef('');
  useEffect(() => {
    const m = privateMatch.active;
    const snap = cs2Gsi.snap;
    if (!m || !snap) return;
    // Qualquer jogador na partida pode publicar o seu GSI (dedicated raramente manda allplayers)
    const me = m.players?.find((p) => p.userId === user?.id);
    if (!me || me.inviteStatus === 'declined') return;
    if (m.status !== 'live' && m.status !== 'connecting') return;
    const now = Date.now();
    if (now - gsiIngestAt.current < 2000) return;
    gsiIngestAt.current = now;
    void privateMatch.ingestGsi(m.id, snap);
  }, [cs2Gsi.snap, privateMatch.active, user?.id, privateMatch]);

  // Host: gameover GSI → ingest final + Encerrar (para dedicated + métricas)
  useEffect(() => {
    const m = privateMatch.active;
    const snap = cs2Gsi.snap;
    if (!m || !snap || !user?.id) return;
    if (m.hostUserId !== user.id) return;
    if (m.status !== 'live' && m.status !== 'connecting') return;
    if (String(snap.map?.phase || '').toLowerCase() !== 'gameover') return;
    if (gameoverEndedRef.current === m.id) return;
    gameoverEndedRef.current = m.id;
    void (async () => {
      try {
        await privateMatch.ingestGsi(m.id, snap);
      } catch {
        /* ignore */
      }
      try {
        await privateMatch.end(m.id);
      } catch {
        /* ignore */
      }
    })();
  }, [cs2Gsi.snap, privateMatch.active, user?.id, privateMatch]);

  // DMs: socket por usuário (sala user:id) — notifica mesmo fora do hub
  useEffect(() => {
    if (!user) return;
    const sock = getSocket();
    type DmSocketMsg = {
      id: number;
      body: string;
      from_user_id: number;
      to_user_id: number;
      server_id: number | null;
      user?: { id: number; label?: string; username?: string; avatar_url?: string };
    };
    const onDm = (msg: DmSocketMsg) => {
      if (Number(msg.to_user_id) !== user.id) return;
      if (Number(msg.from_user_id) === user.id) return;

      const peerId = Number(msg.from_user_id);
      const srvId = msg.server_id ?? null;
      const onOpenDm =
        view === 'dm' &&
        dmUserId === peerId &&
        (dmServerId || null) === (srvId || null);

      if (onOpenDm) {
        setDmMessages((prev) =>
          prev.some((m) => m.id === msg.id)
            ? prev
            : [
                ...prev,
                {
                  id: msg.id,
                  body: msg.body,
                  mine: false,
                  user: {
                    id: peerId,
                    label: msg.user?.label || msg.user?.username || `Usuário #${peerId}`,
                    avatar_url: msg.user?.avatar_url || '',
                  },
                },
              ],
        );
      } else {
        setDmUnread((n) => n + 1);
      }

      // Atualiza lista de threads se o hub estiver aberto
      if (view === 'dm') {
        void api<{ threads: DmThread[] }>('/api/community/dm')
          .then((d) => setDmThreads(d.threads || []))
          .catch(() => undefined);
      }

      const shouldNotify = !onOpenDm || document.visibilityState === 'hidden';
      if (!shouldNotify) return;

      const sender = msg.user?.label || msg.user?.username || 'Alguém';
      pushNotify({
        kind: 'community.dm',
        threadKey: commDmKey(peerId, srvId),
        title: formatDmTitle(sender),
        body: msg.body || '',
        icon: absIcon(msg.user?.avatar_url),
        onClick: () => {
          setView('dm');
          setDmUserId(peerId);
          setDmServerId(srvId);
        },
      });
    };
    sock.on('dm:new', onDm);
    // Expulso, servidor bloqueado ou excluído: sai da voz e da tela desse servidor
    const onRemoved = (payload: { server_id?: number; reason?: string }) => {
      const sid = Number(payload?.server_id);
      if (!sid) return;
      if (voiceServerId === sid) leaveVoice();
      void qc.invalidateQueries({ queryKey: ['servers'] });
      qc.removeQueries({ queryKey: ['server', sid] });
      if (Number(serverId) === sid) nav('/comunidade', { replace: true });
    };
    sock.on('server:removed', onRemoved);
    return () => {
      sock.off('dm:new', onDm);
      sock.off('server:removed', onRemoved);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, view, dmUserId, dmServerId, serverId, voiceServerId]);

  useEffect(() => {
    if (!serverId || view !== 'chat' || !channelId) return;
    let stop = false;
    async function load(after?: number) {
      const q = after ? `?after=${after}` : '';
      const d = await api<{ messages: MessageDto[] }>(
        `/api/community/channels/${channelId}/messages${q}`,
      );
      if (stop) return;
      if (!after) setMessages(d.messages);
      else if (d.messages.length) {
        setMessages((prev) => {
          const known = new Set(prev.map((m) => m.id));
          for (const m of d.messages) {
            const isSys =
              !!m.system ||
              /^\s*⚙️/.test(m.body || '') ||
              /Partida Privada Castino\.Tech/i.test(m.body || '');
            if (known.has(m.id) || (Number(m.user?.id) === user?.id && !isSys)) continue;
            // Poll só notifica se não estamos no thread (viewingThread já cobre)
            const chName =
              (server?.channels || []).find((c) => c.id === m.channel_id)?.name || 'Canal';
            pushNotify({
              kind: 'community.text_message',
              threadKey: commChannelKey(m.channel_id),
              title: formatCommTextTitle(
                server?.name || 'Servidor',
                chName,
                m.user?.label || m.user?.username || 'Alguém',
              ),
              body: m.body || '',
              icon: absIcon(m.user?.avatar_url),
              onClick: () => {
                nav(`/comunidade/${serverId}/${m.channel_id}`);
                setView('chat');
              },
            });
          }
          return [...prev, ...d.messages.filter((m) => !known.has(m.id))];
        });
      }
    }
    void load();
    // O socket (`message:new`) entrega na hora; o polling é só rede de segurança
    const t = setInterval(() => {
      setMessages((prev) => {
        void load(prev[prev.length - 1]?.id);
        return prev;
      });
    }, 15000);
    return () => {
      stop = true;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId, channelId, view]);

  const presenceQ = useQuery({
    queryKey: ['presence', serverId],
    queryFn: async () => {
      if (!GEO.asked && typeof navigator !== 'undefined' && navigator.geolocation) {
        GEO.asked = true;
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            GEO.lat = pos.coords.latitude;
            GEO.lon = pos.coords.longitude;
          },
          () => undefined,
          { enableHighAccuracy: false, maximumAge: 300_000, timeout: 12_000 },
        );
        try {
          navigator.geolocation.watchPosition(
            (pos) => {
              GEO.lat = pos.coords.latitude;
              GEO.lon = pos.coords.longitude;
            },
            () => undefined,
            { enableHighAccuracy: false, maximumAge: 120_000, timeout: 15_000 },
          );
        } catch {
          /* ignore */
        }
      }
      const qs = new URLSearchParams();
      // Só reforça canal no heartbeat depois de ligado ao LiveKit.
      // Enviar o id durante o connect (antes do token) causava voice_revoked falso
      // e derrubava a sessão — palco vazio / falha ao trocar de canal.
      qs.set(
        'voice_channel_id',
        voice.connected && voiceChannelId && voiceServerId === serverId
          ? String(voiceChannelId)
          : '',
      );
      if (lastPingMs != null && Number.isFinite(lastPingMs)) {
        qs.set('ping_ms', String(Math.round(lastPingMs)));
      }
      if (GEO.lat != null && GEO.lon != null) {
        qs.set('lat', String(GEO.lat));
        qs.set('lon', String(GEO.lon));
      }
      const q = qs.toString() ? `?${qs}` : '';
      const t0 = performance.now();
      const data = await api<PresencePayload>(
        `/api/community/servers/${serverId}/voice-presence${q}`,
      );
      const rtt = Math.round(performance.now() - t0);
      lastPingMs = rtt;
      const meKey = user ? String(user.id) : '';
      if (meKey) {
        const prev = data.presence_info?.[meKey] || {
          location: '',
          location_source: '',
        };
        const serverLoc = prev.location || '';
        data.presence_info = {
          ...(data.presence_info || {}),
          [meKey]: {
            ...prev,
            ping_ms: rtt,
            location: serverLoc,
            // preservar cs2_live do servidor (não apagar no merge local)
            cs2_live: prev.cs2_live ?? null,
          },
        };
      }
      return data;
    },
    enabled: !!serverId && !!user,
    // Heartbeat + roster. Mudanças de voz chegam por `presence:changed` (refetch imediato);
    // o intervalo só mantém o TTL e cobre socket caído.
    refetchInterval: 10000,
    // Crítico: sem isso a aba em segundo plano para o heartbeat e a pessoa fica "offline"
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    if (voiceServerId && serverId === voiceServerId && server?.name) {
      setVoiceMeta((m) =>
        m.serverName === server.name ? m : { ...m, serverName: server.name },
      );
    }
  }, [server?.name, serverId, voiceServerId, setVoiceMeta]);

  useEffect(() => {
    setImmersedInVoiceUi(view === 'voice' && voiceServerId === serverId);
  }, [view, voiceServerId, serverId, setImmersedInVoiceUi]);

  useEffect(() => {
    if (window.sfDesktop) document.body.classList.add('is-desktop-app');
  }, []);

  // Partilha placar CS2 (GSI) com a lista de membros via Redis presence
  const cs2ShareRef = useRef<{
    lastAt: number;
    published: boolean;
    sig: string;
    mode: string;
    modeLabel: string;
  }>({
    lastAt: 0,
    published: false,
    sig: '',
    mode: '',
    modeLabel: '',
  });
  useEffect(() => {
    if (!user?.id) return;
    const snap = cs2Gsi.snap;
    const pm = privateMatch.active;
    const inPrivateLive =
      !!pm &&
      (pm.status === 'live' || pm.status === 'connecting') &&
      !!pm.players?.some((p) => p.userId === user.id && p.inviteStatus !== 'declined');

    const payload =
      snap && Date.now() - (snap.at || 0) < 30000
        ? cs2LiveFromSnap(snap, {
            mode: cs2ShareRef.current.mode,
            modeLabel: cs2ShareRef.current.modeLabel,
          })
        : null;

    // Em scrim privada: se o GSI falhar/pausar, NÃO limpar o badge — a API republica via partida
    if (!payload) {
      if (inPrivateLive) return;
      if (!cs2ShareRef.current.published) return;
      cs2ShareRef.current = {
        lastAt: 0,
        published: false,
        sig: '',
        mode: cs2ShareRef.current.mode,
        modeLabel: cs2ShareRef.current.modeLabel,
      };
      void api('/api/community/me/cs2-live', {
        method: 'POST',
        body: JSON.stringify({ cs2_live: null }),
      }).catch(() => undefined);
      return;
    }
    if (payload.modeLabel && payload.modeLabel !== 'Lobby CS2') {
      cs2ShareRef.current.mode = payload.mode || cs2ShareRef.current.mode;
      cs2ShareRef.current.modeLabel = payload.modeLabel;
    }
    // Em partida privada força kind=match mesmo em warmup
    if (inPrivateLive && payload.kind === 'lobby') {
      payload.kind = 'match';
      payload.map =
        payload.map ||
        String(pm?.votedMap || pm?.connect?.map || 'CS2').replace(/^de_/, '') ||
        'CS2';
      payload.modeLabel = payload.modeLabel || 'Partida privada';
    }
    const sig = [
      payload.kind,
      payload.map,
      payload.scoreCt,
      payload.scoreT,
      payload.kills,
      payload.deaths,
      payload.health,
      payload.team,
      payload.modeLabel,
    ].join('|');
    const now = Date.now();
    if (
      sig === cs2ShareRef.current.sig &&
      now - cs2ShareRef.current.lastAt < 2000 &&
      cs2ShareRef.current.published
    ) {
      return;
    }
    cs2ShareRef.current.lastAt = now;
    cs2ShareRef.current.published = true;
    cs2ShareRef.current.sig = sig;
    void api('/api/community/me/cs2-live', {
      method: 'POST',
      body: JSON.stringify({ cs2_live: payload }),
    }).catch(() => undefined);
  }, [user?.id, cs2Gsi.snap, privateMatch.active]);

  useEffect(() => {
    void presenceQ.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice.connected, voice.participants.length, voiceChannelId, voiceServerId]);

  const voiceJoinAtRef = useRef(0);
  useEffect(() => {
    if (voiceChannelId) voiceJoinAtRef.current = Date.now();
  }, [voiceChannelId]);

  // Outra aba/app tomou a voz → desconecta só localmente
  useEffect(() => {
    const active = presenceQ.data?.active_voice;
    const revoked = presenceQ.data?.voice_revoked;
    if (!voiceChannelId || !voiceServerId) return;
    // Ainda a ligar ao LiveKit — não interpretar mismatch/revoke transitório
    if (!voice.connected) return;
    // Troca de canal da partida: presence antigo ainda aponta para o canal anterior.
    if (Date.now() - voiceJoinAtRef.current < 12000) return;
    if (revoked) {
      dropVoiceLocal();
      return;
    }
    if (!active) return;
    if (active.server_id !== voiceServerId || active.channel_id !== voiceChannelId) {
      dropVoiceLocal();
    }
  }, [
    presenceQ.data?.active_voice,
    presenceQ.data?.voice_revoked,
    voiceChannelId,
    voiceServerId,
    voice.connected,
    dropVoiceLocal,
  ]);

  // Fecha aba/app neste servidor → some da lista online na hora
  useEffect(() => {
    if (!serverId) return;
    const flushOffline = () => {
      try {
        void fetch(`/api/community/servers/${serverId}/presence-offline`, {
          method: 'POST',
          credentials: 'include',
          keepalive: true,
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
      } catch {
        /* ignore */
      }
    };
    window.addEventListener('pagehide', flushOffline);
    window.addEventListener('beforeunload', flushOffline);
    const offDesktop = window.sfDesktop?.onLeaving?.(flushOffline);
    return () => {
      window.removeEventListener('pagehide', flushOffline);
      window.removeEventListener('beforeunload', flushOffline);
      offDesktop?.();
    };
  }, [serverId]);

  // Membro novo no servidor → notify
  const knownMembersRef = useRef<Set<number>>(new Set());
  useEffect(() => {
    if (!serverId || !server?.members || !user) return;
    const list = server.members;
    const ids = new Set(list.map((m) => Number(m.id)));
    if (knownMembersRef.current.size) {
      for (const m of list) {
        const id = Number(m.id);
        if (knownMembersRef.current.has(id) || id === user.id) continue;
        pushNotify({
          kind: 'community.member_join',
          threadKey: `comm:srv:${serverId}:events`,
          title: server.name,
          body: `${m.label || m.username || 'Alguém'} entrou no servidor`,
          icon: absIcon(m.avatar_url),
        });
      }
    }
    knownMembersRef.current = ids;
  }, [serverId, server?.members, server?.name, user]);

  // Transmissão de tela → notify (uma vez por share)
  const prevScreenRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!voice.connected || !voiceChannelId || !server) {
      prevScreenRef.current = new Set();
      return;
    }
    const next = new Set<string>();
    for (const p of voice.participants) {
      if (!p.hasScreen || p.isLocal) continue;
      next.add(p.id);
      if (prevScreenRef.current.has(p.id)) continue;
      const key = `comm:share:${voiceChannelId}:${p.id}`;
      if (markScreenShareNotified(key)) continue;
      const uid = userIdFromIdentity(p.id);
      const member = (server.members || []).find((m) => m.id === uid);
      pushNotify({
        kind: 'community.screen_share',
        threadKey: key,
        title: `${server.name} · ${voiceMeta.channelName || 'Voz'}`,
        body: `${p.name || member?.label || 'Alguém'} está transmitindo a tela`,
        icon: absIcon(member?.avatar_url),
        onClick: () => {
          if (voiceServerId && voiceChannelId) {
            nav(`/comunidade/${voiceServerId}/${voiceChannelId}`);
            setView('voice');
          }
        },
      });
    }
    prevScreenRef.current = next;
  }, [
    voice.connected,
    voice.participants,
    voiceChannelId,
    voiceServerId,
    server,
    voiceMeta.channelName,
    nav,
  ]);

  useEffect(() => {
    if (!voiceChannelId) resetScreenShareNotified();
  }, [voiceChannelId]);

  // Heartbeat extra com aba oculta (timers do browser freiam no background)
  useEffect(() => {
    if (!serverId || !user) return;
    const beat = () => {
      if (document.visibilityState !== 'hidden') return;
      void presenceQ.refetch();
    };
    const t = window.setInterval(beat, 20000);
    const onVis = () => {
      if (document.visibilityState === 'visible') void presenceQ.refetch();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.clearInterval(t);
      document.removeEventListener('visibilitychange', onVis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId, user?.id]);

  useEffect(() => {
    if (!voice.sharing && publicWatch) {
      void stopPublicWatch(publicWatch.sessionId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice.sharing]);

  useEffect(() => {
    if (voice.connected) void voice.switchMicDevice(audioPrefs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    audioPrefs.micId,
    audioPrefs.noiseEngine,
    audioPrefs.noiseFilter,
    audioPrefs.echoCancellation,
  ]);

  useEffect(() => {
    if (voice.connected) voice.setNoiseLevel?.(audioPrefs.noiseLevel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioPrefs.noiseLevel]);

  useEffect(() => {
    if (!user) return;
    const fromPresence = presenceQ.data?.work_statuses?.[String(user.id)];
    if (fromPresence != null) setWorkStatus(String(fromPresence || ''));
  }, [presenceQ.data?.work_statuses, user]);

  useEffect(() => {
    if (!statusOpen) return;
    function onDoc(ev: MouseEvent) {
      const t = ev.target as Node | null;
      if (statusBarRef.current && t && !statusBarRef.current.contains(t)) {
        setStatusOpen(false);
      }
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [statusOpen]);

  const myStatus = useMemo(() => {
    if (!user) return '';
    if (presenceQ.data?.on_call?.[String(user.id)]) return 'em_chamada';
    return workStatus;
  }, [presenceQ.data?.on_call, user, workStatus]);

  async function sendDm(e: FormEvent) {
    e.preventDefault();
    if (!dmUserId || !dmDraft.trim()) return;
    const body = dmDraft.trim();
    setDmDraft('');
    const d = await api<{ message: DmMessage }>(`/api/community/dm/${dmUserId}`, {
      method: 'POST',
      body: JSON.stringify({
        body,
        ...(dmServerId ? { server_id: dmServerId } : {}),
      }),
    });
    setDmMessages((prev) => (prev.some((m) => m.id === d.message.id) ? prev : [...prev, d.message]));
    const threads = await api<{ threads: DmThread[] }>('/api/community/dm');
    setDmThreads(threads.threads || []);
  }

  function enterDmHub(preferUserId?: number, preferLabel?: string) {
    setIsWaHub(false);
    setView('dm');
    // Sai da URL do canal de voz sem desconectar o LiveKit
    if (serverId) nav(`/comunidade/${serverId}`);
    if (preferUserId) {
      setDmUserId(preferUserId);
      setDmServerId(serverId);
      if (preferLabel) {
        setDmThreads((prev) => {
          if (prev.some((t) => t.other_user.id === preferUserId)) return prev;
          return [
            {
              other_user: {
                id: preferUserId,
                label: preferLabel,
                username: preferLabel,
                avatar_url: '',
              },
              server_id: serverId,
              server_name: server?.name || '',
              last_message: '',
              unread: false,
            },
            ...prev,
          ];
        });
      }
    } else {
      setDmUserId(null);
      setDmServerId(null);
    }
  }

  function enterWaHub() {
    setIsWaHub(true);
    setView('empty');
    setDmUserId(null);
    setDmServerId(null);
    // Mantém voz conectada; só troca o layout (como no ASF)
    if (serverId) nav(`/comunidade/${serverId}`);
  }

  function exitWaHub() {
    setIsWaHub(false);
  }

  function exitDmHub() {
    setView('empty');
    setDmUserId(null);
    setDmServerId(null);
  }

  async function createServer(name: string) {
    const d = await api<{ server: { id: number } }>('/api/community/servers', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    await qc.invalidateQueries({ queryKey: ['servers'] });
    nav(`/comunidade/${d.server.id}`);
  }

  async function joinServer(code: string) {
    const d = await api<{ server_id: number }>('/api/community/join', {
      method: 'POST',
      body: JSON.stringify({ code: code.trim() }),
    });
    await qc.invalidateQueries({ queryKey: ['servers'] });
    nav(`/comunidade/${d.server_id}`);
  }

  async function sendMessage(e: FormEvent) {
    e.preventDefault();
    if (!channelId || !draft.trim()) return;
    const body = draft.trim();
    setDraft('');
    const d = await api<{ message: MessageDto }>(`/api/community/channels/${channelId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    });
    setMessages((prev) => (prev.some((m) => m.id === d.message.id) ? prev : [...prev, d.message]));
  }

  async function changeStatus(status: string) {
    setStatusOpen(false);
    if (status === 'em_chamada') return;
    const prev = workStatus;
    setWorkStatus(status);
    try {
      const data = await api<{ work_status: string; work_status_since?: number }>(
        '/api/community/me/work-status',
        {
          method: 'POST',
          body: JSON.stringify({ status }),
        },
      );
      setWorkStatus(String(data.work_status ?? status));
      void presenceQ.refetch();
      if (serverId) void qc.invalidateQueries({ queryKey: ['server', serverId] });
    } catch (err) {
      setWorkStatus(prev);
      window.alert(err instanceof Error ? err.message : 'Falha ao alterar status.');
    }
  }

  async function stopPublicWatch(sessionId?: number) {
    try {
      await api('/api/community/live/stop', {
        method: 'POST',
        body: JSON.stringify({ session_id: sessionId || publicWatch?.sessionId }),
      });
    } catch {
      /* ignore */
    }
    setPublicWatch(null);
  }

  async function startShareWithOpts(opts: {
    quality: string;
    fps: number;
    audioMode: 'off' | 'app' | 'system';
    bitrateMode: 'auto' | 'fixed';
    title: string;
    publicWatch: boolean;
    publicWatchMax: number;
    publicWatchCustomNames: boolean;
    publicWatchChat: boolean;
    publicWatchChatPost: boolean;
  }) {
    try {
      const result = await voice.shareScreen(opts);
      if (result?.audioWarning) {
        window.alert(result.audioWarning);
      }
    } catch (err) {
      window.alert(
        err instanceof Error
          ? err.message
          : 'Não foi possível iniciar o compartilhamento de tela.',
      );
      return;
    }
    if (!opts.publicWatch || !serverId || !voiceChannelId) {
      setPublicWatch(null);
      return;
    }
    try {
      const data = await api<{
        id: number;
        watch_url: string;
        public_watch_enabled?: boolean;
      }>('/api/community/live/start', {
        method: 'POST',
        body: JSON.stringify({
          server_id: serverId,
          channel_id: voiceChannelId,
          title: opts.title || undefined,
          public_watch: true,
          public_watch_max: opts.publicWatchMax,
          public_watch_custom_names: opts.publicWatchCustomNames,
          public_watch_chat_enabled: opts.publicWatchChat,
          public_watch_chat_guest_post: opts.publicWatchChatPost,
        }),
      });
      if (data.watch_url) {
        setPublicWatch({ url: data.watch_url, sessionId: data.id });
      }
    } catch (err) {
      window.alert(
        err instanceof Error
          ? err.message
          : 'Compartilhamento iniciado, mas o link público falhou.',
      );
    }
  }

  async function logout() {
    await api('/api/auth/logout', { method: 'POST', body: '{}' });
    setUser(null);
    nav('/login');
  }

  async function createInvite() {
    if (!serverId) return;
    const d = await api<{ invite: { code: string; url: string } }>(
      `/api/community/servers/${serverId}/invites`,
      { method: 'POST', body: '{}' },
    );
    setInviteInfo({ url: d.invite.url, code: d.invite.code });
    setInviteOpen(true);
  }

  async function deleteMsg(mid: number) {
    if (!channelId) return;
    if (!confirm('Excluir esta mensagem?')) return;
    await api(`/api/community/channels/${channelId}/messages/${mid}`, { method: 'DELETE' });
    setMessages((prev) => prev.filter((m) => m.id !== mid));
  }

  async function deleteChannel(chId: number, name: string) {
    if (!confirm(`Excluir canal #${name}?`)) return;
    await api(`/api/community/channels/${chId}`, { method: 'DELETE' });
    await qc.invalidateQueries({ queryKey: ['server', serverId] });
    if (channelId === chId) nav(`/comunidade/${serverId}`);
  }

  async function kickMember(targetId: number, label: string) {
    if (!serverId) return;
    if (!confirm(`Expulsar ${label}?`)) return;
    await api(`/api/community/servers/${serverId}/members/${targetId}/kick`, {
      method: 'POST',
      body: '{}',
    });
    await qc.invalidateQueries({ queryKey: ['server', serverId] });
  }

  async function moveChannel(chId: number, dir: -1 | 1) {
    if (!serverId || !server) return;
    const list = [...server.channels].sort(
      (a, b) => a.position - b.position || a.id - b.id,
    );
    const ch = list.find((c) => c.id === chId);
    if (!ch) return;
    const isText = ch.kind === 'text';
    const group = list.filter((c) => (isText ? c.kind === 'text' : c.kind !== 'text'));
    const gIdx = group.findIndex((c) => c.id === chId);
    const swap = gIdx + dir;
    if (gIdx < 0 || swap < 0 || swap >= group.length) return;
    const nextGroup = [...group];
    [nextGroup[gIdx], nextGroup[swap]] = [nextGroup[swap], nextGroup[gIdx]];
    const groupIds = new Set(nextGroup.map((c) => c.id));
    let gi = 0;
    const order = list.map((c) => (groupIds.has(c.id) ? nextGroup[gi++].id : c.id));
    await api(`/api/community/servers/${serverId}/channels/reorder`, {
      method: 'POST',
      body: JSON.stringify({ order }),
    });
    await qc.invalidateQueries({ queryKey: ['server', serverId] });
  }

  function joinVoiceChannel(ch: Channel) {
    if (!serverId) return;
    setIsWaHub(false);
    joinVoice({
      channelId: ch.id,
      serverId,
      serverName: server?.name || '',
      channelName: ch.name,
    });
    setView('voice');
    nav(`/comunidade/${serverId}/${ch.id}`);
  }

  const onlineIds = presenceQ.data?.online_users || [];
  // Paridade Flask memberOnlineSet: heartbeat + quem está na voz (LiveKit)
  const online = useMemo(() => {
    const set = new Set(onlineIds.map((id) => Number(id)));
    const presence = presenceQ.data?.presence || {};
    for (const rows of Object.values(presence)) {
      for (const p of rows || []) {
        if (p.user_id) set.add(Number(p.user_id));
      }
    }
    if (voice.connected) {
      for (const p of voice.participants) {
        const uid = userIdFromIdentity(p.id);
        if (uid) set.add(uid);
      }
    }
    return set;
  }, [onlineIds, presenceQ.data?.presence, voice.connected, voice.participants]);
  const members = server?.members || [];
  const onlineMembers = members.filter((m) => online.has(m.id));
  const offlineMembers = membersHideOffline
    ? []
    : members.filter((m) => !online.has(m.id));
  const rolesById = useMemo(() => {
    const map = new Map<number, ServerRole>();
    for (const r of server?.roles || []) map.set(r.id, r);
    return map;
  }, [server?.roles]);
  const perms = server?.permissions || [];
  const canManageChannels =
    server?.role === 'owner' ||
    server?.role === 'admin' ||
    perms.includes('channels.edit') ||
    perms.includes('channels.delete') ||
    perms.includes('channels.create') ||
    perms.includes('channels.reorder');
  const canEditChannel =
    server?.role === 'owner' || server?.role === 'admin' || perms.includes('channels.edit');
  const canDeleteChannel =
    server?.role === 'owner' || server?.role === 'admin' || perms.includes('channels.delete');
  const canReorderChannels =
    server?.role === 'owner' || server?.role === 'admin' || perms.includes('channels.reorder');
  const membersByRoleGroups = useMemo(() => {
    const list = membersHideOffline ? members.filter((m) => online.has(m.id)) : members;
    const buckets = new Map<
      string,
      { key: string; label: string; color: string; sort: number; members: Member[] }
    >();
    for (const m of list) {
      const meta = memberRoleGroupMeta(m, rolesById);
      const bucket = buckets.get(meta.key) || {
        key: meta.key,
        label: meta.label,
        color: meta.color,
        sort: meta.sort,
        members: [] as Member[],
      };
      bucket.members.push(m);
      buckets.set(meta.key, bucket);
    }
    const groups = [...buckets.values()].sort((a, b) => b.sort - a.sort || a.label.localeCompare(b.label));
    for (const g of groups) {
      g.members.sort((a, b) => {
        const ao = online.has(a.id) ? 0 : 1;
        const bo = online.has(b.id) ? 0 : 1;
        if (ao !== bo) return ao - bo;
        return a.label.localeCompare(b.label);
      });
    }
    return groups;
  }, [members, membersHideOffline, online, rolesById]);
  const meFace = user?.avatar_url || DEFAULT_AVATAR;
  const meName = user?.label || user?.username || '—';
  const isDmHub = view === 'dm';
  const showSidebar = hasServer || isDmHub || isWaHub;
  const hasWaPeer = isWaHub && !!wa.chatJid && wa.unlocked;

  useEffect(() => {
    applyThemeState(commRootRef.current, themeState);
  }, [themeState, showSidebar, view, serverId]);

  const dmPeer =
    dmThreads.find(
      (t) =>
        t.other_user.id === dmUserId &&
        (dmServerId == null || t.server_id === dmServerId || (!t.server_id && !dmServerId)),
    )?.other_user ||
    (dmUserId
      ? { id: dmUserId, label: `Usuário #${dmUserId}`, username: '', avatar_url: '' }
      : null);
  const voiceChannelByUser = useMemo(() => {
    const map: Record<number, number> = {};
    const presence = presenceQ.data?.presence || {};
    for (const [ch, people] of Object.entries(presence)) {
      for (const p of people) {
        if (p.user_id) map[p.user_id] = Number(ch);
      }
    }
    return map;
  }, [presenceQ.data?.presence]);

  function renderMemberCard(m: Member, isOnline: boolean) {
    const st = presenceQ.data?.on_call?.[String(m.id)]
      ? 'em_chamada'
      : m.id === user?.id
        ? workStatus
        : presenceQ.data?.work_statuses?.[String(m.id)] || m.work_status;
    const info = presenceQ.data?.presence_info?.[String(m.id)];
    const accent = memberCardAccent(m, rolesById);
    const cargo = memberPrimaryCargo(m, rolesById);
    const customs = memberSortedCustoms(m, rolesById);
    const cardStyle = accent
      ? ({ ['--member-card-accent']: accent } as CSSProperties)
      : undefined;
    return (
      <article
        key={m.id}
        className={`comm-member-card${isOnline ? ' is-online' : ' is-offline'}${
          m.role === 'owner' ? ' is-owner-card' : ''
        }`}
        style={cardStyle}
        onClick={() => setMemberProfile(m)}
      >
        <div className="comm-member-av-wrap">
          <Avatar name={m.label} url={m.avatar_url} />
          <span
            className="comm-member-av-dot"
            title={isOnline ? 'online' : 'offline'}
            aria-hidden
          />
        </div>
        <div className="comm-member-body">
          <div className="comm-member-top">
            <div className="comm-member-top-name">
              <strong>{m.label}</strong>
              <span
                className={`comm-member-name-cargo fx-${cargo.border_effect || 'solid'} motion-${cargo.border_motion || 'none'}`}
                style={{
                  ['--cargo-color' as string]: cargo.color,
                  ['--cargo-border-color' as string]: cargo.border_color || cargo.color,
                }}
                title={cargo.name}
              >
                {cargo.name}
              </span>
            </div>
            <button
              type="button"
              className="comm-member-menu"
              aria-label="Opções"
              onClick={(e) => {
                e.stopPropagation();
                setMemberProfile(m);
              }}
            >
              <MoreVertical size={14} />
            </button>
          </div>
          <ShowcaseBadges items={m.showcase_items} size="sm" onOpen={setItemDetail} />
          {customs.length > 1 ? (
            <div className="comm-member-tags">
              {customs.slice(1).map((r) => {
                const full = rolesById?.get(r.id);
                const effect = full?.border_effect || r.border_effect || 'solid';
                const motion = full?.border_motion || r.border_motion || 'none';
                const border = full?.border_color || r.border_color || r.color || '#949ba4';
                return (
                  <span
                    key={r.id}
                    className={`comm-member-tag fx-${effect} motion-${motion}`}
                    style={{
                      ['--tag-color' as string]: r.color || '#949ba4',
                      ['--tag-border-color' as string]: border,
                    }}
                  >
                    {r.name}
                  </span>
                );
              })}
            </div>
          ) : null}
          {isOnline && (m.ramal || (st && st !== 'em_chamada')) ? (
            <div className="comm-badges">
              {m.ramal ? (
                <span
                  className={`comm-ramal-badge${st === 'em_chamada' ? ' is-oncall' : ''}`}
                  title={`Ramal ${m.ramal}`}
                >
                  <Phone size={12} aria-hidden />
                  {m.ramal}
                  {st === 'em_chamada' ? (
                    <em className="comm-ramal-oncall">Em ligação</em>
                  ) : null}
                </span>
              ) : null}
              {st && st !== 'em_chamada' ? (
                <span className="comm-work-status" data-status={st} title={statusLabel(st)}>
                  {statusLabel(st)}
                </span>
              ) : null}
            </div>
          ) : null}
          {(() => {
            const shared = info?.cs2_live;
            const sharedFresh = shared && Date.now() - (shared.at || 0) < 120000;
            const pm = privateMatch.active;
            const inPrivateLive =
              !!pm && (pm.status === 'live' || pm.status === 'connecting');
            const pmLive =
              inPrivateLive &&
              pm.players?.find(
                (p) =>
                  p.userId === m.id &&
                  (p.inviteStatus === 'host' || p.inviteStatus === 'accepted'),
              );
            let localPayload =
              m.id === user?.id &&
              cs2Gsi.snap &&
              Date.now() - (cs2Gsi.snap.at || 0) < 45000
                ? cs2LiveFromSnap(cs2Gsi.snap, {
                    mode: cs2ShareRef.current.mode,
                    modeLabel: cs2ShareRef.current.modeLabel,
                  })
                : null;
            // Em scrim privada o GSI às vezes vem como lobby — força match + mapa da sala
            if (localPayload && pmLive && pmLive.team !== 'SPEC') {
              localPayload = {
                ...localPayload,
                kind: 'match',
                map:
                  localPayload.map ||
                  String(pm.votedMap || pm.connect?.map || 'CS2').replace(/^de_/, '') ||
                  'CS2',
                scoreCt: localPayload.scoreCt ?? pm.scoreCt ?? 0,
                scoreT: localPayload.scoreT ?? pm.scoreT ?? 0,
                mode: pm.mode === 'host_listen' ? 'dedicated' : 'private',
                modeLabel: 'Partida privada',
                phase: localPayload.phase || pm.status,
              };
            }

            const matchChip =
              pmLive && pmLive.team !== 'SPEC'
                ? (() => {
                    const st = (pm.stats || []).find(
                      (s) =>
                        (s.userId && s.userId === m.id) ||
                        (pmLive.steamid &&
                          String(s.steamid || '').replace(/\D/g, '') ===
                            String(pmLive.steamid).replace(/\D/g, '')),
                    );
                    const team = String(pmLive.gameTeam || pmLive.team || '').toUpperCase();
                    const health =
                      typeof pmLive.health === 'number'
                        ? pmLive.health
                        : pmLive.alive === false
                          ? 0
                          : pmLive.alive === true
                            ? 100
                            : 100;
                    // GSI local / Redis tem prioridade nos números; partida só ancora presença
                    const gsiNums =
                      (localPayload?.kind === 'match' && localPayload) ||
                      (sharedFresh && shared?.kind === 'match' ? shared : null);
                    return {
                      at: gsiNums?.at || Date.now(),
                      map: String(
                        gsiNums?.map || pm.votedMap || pm.connect?.map || 'CS2',
                      ).replace(/^de_/, ''),
                      scoreCt: Number.isFinite(Number(gsiNums?.scoreCt ?? pm.scoreCt))
                        ? Number(gsiNums?.scoreCt ?? pm.scoreCt)
                        : 0,
                      scoreT: Number.isFinite(Number(gsiNums?.scoreT ?? pm.scoreT))
                        ? Number(gsiNums?.scoreT ?? pm.scoreT)
                        : 0,
                      team:
                        (gsiNums?.team === 'CT' || gsiNums?.team === 'T'
                          ? gsiNums.team
                          : team === 'CT' || team === 'T'
                            ? team
                            : '') || '',
                      kills: Number(gsiNums?.kills ?? st?.kills) || 0,
                      deaths: Number(gsiNums?.deaths ?? st?.deaths) || 0,
                      health:
                        typeof gsiNums?.health === 'number' ? gsiNums.health : health,
                      kind: 'match' as const,
                      mode: pm.mode === 'host_listen' ? 'dedicated' : 'private',
                      modeLabel: 'Partida privada',
                      phase: gsiNums?.phase || pm.status,
                    };
                  })()
                : null;

            if (localPayload?.kind === 'match') {
              return <Cs2MemberLiveChip live={localPayload} compact />;
            }
            if (matchChip) {
              return <Cs2MemberLiveChip live={matchChip} compact />;
            }
            if (sharedFresh && shared) {
              return <Cs2MemberLiveChip live={shared} compact />;
            }
            if (localPayload) {
              return <Cs2MemberLiveChip live={localPayload} compact />;
            }
            return null;
          })()}
          {isOnline && info?.activity?.type === 'listening' ? (
            <button
              type="button"
              className="comm-listening-chip"
              title={info.activity.title || 'Ouvindo no YouTube'}
              onClick={(e) => {
                e.stopPropagation();
                if (info.activity?.url) window.open(info.activity.url, '_blank', 'noopener');
              }}
            >
              <span className="comm-listening-ico" aria-hidden>
                ♪
              </span>
              <span className="yt-marquee">
                <span className="yt-marquee-inner">
                  {info.activity.title || 'YouTube'}
                </span>
              </span>
            </button>
          ) : null}
          {isOnline && (info?.location || info?.ping_ms != null) ? (
            <div className="comm-net-meta">
              {info?.location ? <span className="comm-net-loc">{info.location}</span> : null}
              {info?.location && info?.ping_ms != null ? (
                <span className="comm-net-sep" aria-hidden>
                  ·
                </span>
              ) : null}
              {info?.ping_ms != null ? (
                <span
                  className={`comm-net-ping is-${pingQuality(info.ping_ms)}`}
                  title={`Ping ${Math.round(info.ping_ms)} ms`}
                >
                  {Math.round(info.ping_ms)} ms
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      </article>
    );
  }

  const showDesktopUpdateBanner =
    !!window.sfDesktop &&
    !desktopUpdateDismissed &&
    !!(desktopUpdate?.ready || desktopUpdate?.downloading);

  return (
    <>
      <WebTopNav />
      <div className="comm-page">
      <div className="comm-top-banners">
        <RemoteActiveBanner
          session={remote.active}
          myUserId={user?.id}
          busy={remote.busy}
          error={remote.error}
          onEnd={() => void remote.endSession()}
        />
        <MatchSessionBanner
          match={privateMatch.active}
          onReconnect={() => void privateMatch.reconnect()}
          onOpen={() => openPartidasChannel()}
        />
        {showDesktopUpdateBanner ? (
          <div className="comm-update-banner" data-comm-update-banner>
            <button
              type="button"
              className="comm-update-banner-main"
              data-comm-update-banner-action
              disabled={!!desktopUpdate?.downloading && !desktopUpdate?.ready}
              onClick={() => {
                if (desktopUpdate?.ready) void window.sfDesktop?.promptInstallUpdate?.();
              }}
            >
              <p data-comm-update-banner-text>
                {desktopUpdate?.ready ? (
                  <>
                    Nova versão do app
                    {desktopUpdate.version ? ` (${desktopUpdate.version})` : ''} pronta —{' '}
                    <strong>clique para atualizar</strong>
                  </>
                ) : (
                  <>
                    Baixando atualização
                    {desktopUpdate?.version ? ` ${desktopUpdate.version}` : ''}…
                  </>
                )}
              </p>
            </button>
            <button
              type="button"
              className="comm-update-banner-close"
              data-comm-update-banner-close
              aria-label="Fechar aviso"
              onClick={() => setDesktopUpdateDismissed(true)}
            >
              ×
            </button>
          </div>
        ) : null}
      </div>
      <div
        ref={commRootRef}
        className={`comm${showSidebar ? ' has-server' : ''}${isDmHub ? ' is-dm-hub' : ''}${
          isWaHub ? ' is-wa-hub' : ''
        }${hasWaPeer ? ' has-wa-peer' : ''}${
          hasServer && !isDmHub && !isWaHub && !membersPanelOpen ? ' is-members-collapsed' : ''
        }`}
        data-community
        data-livekit={server?.livekit ? '1' : '0'}
      >
        <aside className="comm-rail" aria-label="Servidores" data-theme-surface="rail">
          <button
            type="button"
            className="comm-rail-btn comm-rail-home"
            title="Início"
            aria-label="Início"
            onClick={() => {
              exitWaHub();
              exitDmHub();
              nav('/comunidade');
            }}
          >
            <House size={20} />
          </button>
          <div className="comm-rail-sep" />
          <button
            type="button"
            className={`comm-rail-btn comm-rail-dm${isDmHub && !isWaHub ? ' is-on' : ''}`}
            title="Minhas DMs"
            onClick={() => enterDmHub()}
          >
            <Mail size={20} />
            {dmUnread > 0 ? <span className="comm-rail-badge">{dmUnread}</span> : null}
          </button>
          <button
            type="button"
            className={`comm-rail-btn comm-rail-wa${isWaHub ? ' is-on' : ''}`}
            data-comm-wa-open
            title="WhatsApp"
            aria-label="WhatsApp"
            onClick={() => enterWaHub()}
          >
            <MessageCircle size={20} />
            {wa.badge > 0 ? (
              <span className="comm-rail-badge" data-comm-wa-badge>
                {wa.badge}
              </span>
            ) : null}
          </button>
          <div className="comm-rail-sep" />
          <ul className="comm-server-list">
            {(serversQ.data?.servers || []).map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  className={`comm-rail-btn${serverId === s.id && !isDmHub && !isWaHub ? ' is-on' : ''}`}
                  title={s.name}
                  onClick={() => {
                    exitWaHub();
                    setDmUserId(null);
                    setDmServerId(null);
                    setView('empty');
                    nav(`/comunidade/${s.id}`);
                  }}
                >
                  {s.icon_url ? (
                    <img className="comm-rail-icon" src={s.icon_url} alt="" />
                  ) : (
                    s.name.slice(0, 2).toUpperCase()
                  )}
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="comm-rail-btn comm-rail-add"
            title="Criar servidor"
            onClick={() => setCreateOpen(true)}
          >
            <Plus size={20} />
          </button>
          <Link className="comm-rail-btn" to="/descobrir" title="Descobrir servidores">
            <Search size={20} />
          </Link>
          <Link className="comm-rail-btn" to="/youtube" title="YouTube">
            <CirclePlay size={20} />
          </Link>
          <button
            type="button"
            className="comm-rail-btn"
            title="Entrar com convite"
            onClick={() => setJoinOpen(true)}
          >
            <Compass size={20} />
          </button>
          {user?.is_super ? (
            <Link className="comm-rail-btn" to="/admin" title="Admin">
              <Table2 size={20} />
            </Link>
          ) : null}
        </aside>

        <aside
          className="comm-sidebar"
          data-theme-surface="sidebar"
          aria-label="Canais"
          hidden={!showSidebar}
          style={showSidebar ? undefined : { display: 'none' }}
        >
          {!isDmHub && !isWaHub ? (
            server?.banner_url ? (
              <div className="comm-sidebar-banner-wrap">
                <div
                  className="comm-sidebar-banner has-image"
                  style={{ backgroundImage: `url(${server.banner_url})` }}
                />
              </div>
            ) : (
              <div className="comm-sidebar-banner-wrap">
                <div className="comm-sidebar-banner is-default" />
              </div>
            )
          ) : null}
          {isWaHub ? (
            <div className="comm-channel-scroll">
              <WaHub wa={wa} />
            </div>
          ) : (
          <>
          <header className="comm-sidebar-head">
            {!isDmHub ? (
              <div className="comm-sidebar-head-top">
                <div className="comm-sidebar-actions">
                  {canModerate ? (
                    <button
                      type="button"
                      className="comm-icon-btn"
                      title="Aparência do servidor"
                      onClick={() => {
                        setSettingsTab('appearance');
                        setSettingsOpen(true);
                      }}
                    >
                      <Settings size={16} />
                    </button>
                  ) : null}
                  {canModerate ? (
                    <button
                      type="button"
                      className="comm-icon-btn"
                      title="Gestão de membros e cargos"
                      onClick={() => setMembersManageOpen(true)}
                    >
                      <Users size={16} />
                    </button>
                  ) : null}
                  {canModerate ? (
                    <button
                      type="button"
                      className="comm-icon-btn"
                      title="Cargos e permissões"
                      onClick={() => {
                        setSettingsTab('roles');
                        setSettingsOpen(true);
                      }}
                    >
                      <Shield size={16} />
                    </button>
                  ) : null}
                  {canModerate ? (
                    <button
                      type="button"
                      className="comm-icon-btn comm-requests-btn"
                      title="Solicitações de entrada"
                      onClick={() => setRequestsOpen(true)}
                    >
                      <UserCheck size={16} />
                      {requestsCount > 0 ? (
                        <span className="comm-icon-badge">{requestsCount}</span>
                      ) : null}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="comm-icon-btn"
                    title="Convidar"
                    onClick={() => void createInvite()}
                  >
                    <UserPlus size={16} />
                  </button>
                  {canModerate ? (
                    <button
                      type="button"
                      className="comm-icon-btn"
                      title="Novo canal"
                      onClick={() => setChannelOpen(true)}
                    >
                      <Plus size={16} />
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}
            <div className="comm-sidebar-title">
              {!isDmHub && server?.icon_url ? (
                <img
                  className="comm-server-icon"
                  src={server.icon_url}
                  alt=""
                  width={28}
                  height={28}
                />
              ) : null}
              <strong>{isDmHub ? 'Minhas DMs' : server?.name || '—'}</strong>
            </div>
            {!isDmHub ? (
            <div className="comm-status-bar" ref={statusBarRef}>
              <button
                type="button"
                className={`comm-status-btn${myStatus === 'em_chamada' ? ' is-oncall' : ''}`}
                aria-haspopup="menu"
                aria-expanded={statusOpen}
                onClick={() => setStatusOpen((v) => !v)}
              >
                <span className="comm-status-dot" data-status={myStatus} />
                <span className="comm-status-label">
                  {statusLabel(myStatus)}
                  {myStatus && myStatus !== 'em_chamada' && user ? (
                    <>
                      {' '}
                      <StatusElapsed
                        since={presenceQ.data?.work_status_since?.[String(user.id)]}
                      />
                    </>
                  ) : null}
                </span>
                <ChevronDown size={14} aria-hidden />
              </button>
              {statusOpen ? (
                <div className="comm-status-menu" role="menu">
                  {WORK_STATUS_OPTIONS.map((o) => {
                    const selected =
                      myStatus === 'em_chamada'
                        ? false
                        : (o.id || '') === (workStatus || '');
                    return (
                      <button
                        key={o.id || 'disp'}
                        type="button"
                        className={`comm-status-option${selected ? ' is-selected' : ''}`}
                        role="menuitem"
                        onClick={() => void changeStatus(o.id)}
                      >
                        <span className="comm-status-dot" data-status={o.id} />
                        {o.label}
                      </button>
                    );
                  })}
                  <button
                    type="button"
                    className={`comm-status-option is-auto${myStatus === 'em_chamada' ? ' is-selected' : ''}`}
                    disabled
                    role="menuitem"
                    title="Acionado automaticamente pelo PABX"
                  >
                    <span className="comm-status-dot" data-status="em_chamada" />
                    Em chamada <em>auto</em>
                  </button>
                </div>
              ) : null}
            </div>
            ) : null}
          </header>

          <div className="comm-channel-scroll">
            {isDmHub ? (
              <div className="comm-cat">
                <button type="button" className="comm-cat-toggle" disabled>
                  <Mail size={14} /> Mensagens diretas
                </button>
                <ul>
                  {!dmThreads.length ? (
                    <li className="comm-dm-empty-hint muted">
                      Nenhuma conversa ainda.
                      <br />
                      Abra o perfil de alguém e clique em Mensagem.
                    </li>
                  ) : (
                    dmThreads.map((t) => {
                      const u = t.other_user;
                      const on =
                        dmUserId === u.id &&
                        (dmServerId || null) === (t.server_id || null);
                      return (
                        <li className="comm-ch-wrap" key={`${u.id}-${t.server_id ?? 'x'}`}>
                          <div className="comm-ch-row">
                            <button
                              type="button"
                              className={`comm-ch comm-dm-person${on ? ' is-on' : ''}`}
                              onClick={() => {
                                setDmUserId(u.id);
                                setDmServerId(t.server_id);
                              }}
                            >
                              <Avatar name={u.label} url={u.avatar_url} />
                              <span className="comm-dm-person-meta">
                                <strong>{u.label}</strong>
                                <em>
                                  {t.server_name || 'DM'}
                                  {t.unread ? ' · nova' : ''}
                                </em>
                              </span>
                              {t.unread ? (
                                <span className="comm-dot comm-dot-unread" aria-hidden />
                              ) : null}
                            </button>
                          </div>
                        </li>
                      );
                    })
                  )}
                </ul>
              </div>
            ) : (
            <div>
              <div className="comm-cat">
                <button type="button" className="comm-cat-toggle" disabled>
                  <ChevronDown size={14} /> Canais de texto
                </button>
                <ul>
                  {(server?.channels || [])
                    .filter((c) => c.kind === 'text')
                    .sort((a, b) => a.position - b.position || a.id - b.id)
                    .map((c) => (
                      <li className="comm-ch-wrap" key={c.id}>
                        <div className={`comm-ch-row${canManageChannels ? ' is-manageable' : ''}`}>
                          <button
                            type="button"
                            className={`comm-ch${channelId === c.id && view === 'chat' ? ' is-on' : ''}`}
                            onClick={() => {
                              setIsWaHub(false);
                              setView('chat');
                              nav(`/comunidade/${serverId}/${c.id}`);
                            }}
                          >
                            <ChannelIcon channel={c} />
                            <span>{c.name}</span>
                          </button>
                          {canManageChannels ? (
                            <>
                              {canEditChannel ? (
                                <button
                                  type="button"
                                  className="comm-ch-edit"
                                  title="Editar canal"
                                  onClick={() => setChannelEdit(c)}
                                >
                                  <Pencil size={12} />
                                </button>
                              ) : null}
                              {canReorderChannels ? (
                                <>
                                  <button
                                    type="button"
                                    className="comm-ch-edit"
                                    title="Subir"
                                    onClick={() => void moveChannel(c.id, -1)}
                                  >
                                    <ChevronUp size={12} />
                                  </button>
                                  <button
                                    type="button"
                                    className="comm-ch-edit"
                                    title="Descer"
                                    onClick={() => void moveChannel(c.id, 1)}
                                  >
                                    <ChevronDown size={12} />
                                  </button>
                                </>
                              ) : null}
                              {canDeleteChannel ? (
                                <button
                                  type="button"
                                  className="comm-ch-edit"
                                  title="Excluir canal"
                                  onClick={() => void deleteChannel(c.id, c.name)}
                                >
                                  <Trash2 size={12} />
                                </button>
                              ) : null}
                            </>
                          ) : null}
                        </div>
                      </li>
                    ))}
                </ul>
              </div>
              <div className="comm-cat">
                <button type="button" className="comm-cat-toggle" disabled>
                  <ChevronDown size={14} /> Canais de voz
                </button>
                <ul>
                  {(server?.channels || [])
                    .filter((c) => c.kind === 'voice' || c.kind === 'screen')
                    .sort((a, b) => a.position - b.position || a.id - b.id)
                    .map((c) => (
                      <li className="comm-ch-wrap" key={c.id}>
                        <div className={`comm-ch-row${canManageChannels && !matchVoiceIds.has(c.id) ? ' is-manageable' : ''}`}>
                          <button
                            type="button"
                            className={`comm-ch${
                              voiceServerId === serverId && voiceChannelId === c.id
                                ? ' is-on is-connected'
                                : ''
                            }`}
                            onClick={() => joinVoiceChannel(c)}
                          >
                            <ChannelIcon channel={c} />
                            <span>{c.name}</span>
                          </button>
                          {canManageChannels && !matchVoiceIds.has(c.id) ? (
                            <>
                              {canEditChannel ? (
                                <button
                                  type="button"
                                  className="comm-ch-edit"
                                  title="Editar canal"
                                  onClick={() => setChannelEdit(c)}
                                >
                                  <Pencil size={12} />
                                </button>
                              ) : null}
                              {canReorderChannels ? (
                                <>
                                  <button
                                    type="button"
                                    className="comm-ch-edit"
                                    title="Subir"
                                    onClick={() => void moveChannel(c.id, -1)}
                                  >
                                    <ChevronUp size={12} />
                                  </button>
                                  <button
                                    type="button"
                                    className="comm-ch-edit"
                                    title="Descer"
                                    onClick={() => void moveChannel(c.id, 1)}
                                  >
                                    <ChevronDown size={12} />
                                  </button>
                                </>
                              ) : null}
                              {canDeleteChannel ? (
                                <button
                                  type="button"
                                  className="comm-ch-edit"
                                  title="Excluir canal"
                                  onClick={() => void deleteChannel(c.id, c.name)}
                                >
                                  <Trash2 size={12} />
                                </button>
                              ) : null}
                            </>
                          ) : null}
                        </div>
                        <ul className="comm-voice-roster">
                          {((): Array<{
                            identity: string;
                            name: string;
                            user_id: number;
                            avatar_url: string;
                            ramal?: string;
                            work_status?: string;
                            location?: string;
                            ping_ms?: number | null;
                            speaking?: boolean;
                            sharing?: boolean;
                          }> => {
                            const fromApi = (presenceQ.data?.presence?.[String(c.id)] || []).map(
                              (p) => ({
                                ...p,
                                speaking: false,
                                sharing: false,
                              }),
                            );
                            // Canal ativo: LiveKit é mais rápido; mescla com presence da API
                            // para o roster aparecer igual antes/depois de conectar.
                            if (
                              voiceServerId === serverId &&
                              voiceChannelId === c.id &&
                              voice.connected
                            ) {
                              const byKey = new Map<
                                string,
                                {
                                  identity: string;
                                  name: string;
                                  user_id: number;
                                  avatar_url: string;
                                  ramal?: string;
                                  work_status?: string;
                                  location?: string;
                                  ping_ms?: number | null;
                                  speaking?: boolean;
                                  sharing?: boolean;
                                }
                              >();
                              for (const p of fromApi) {
                                byKey.set(p.identity || `u${p.user_id}`, { ...p });
                              }
                              for (const p of voice.participants) {
                                const fromRow = fromApi.find((x) => x.identity === p.id);
                                const uidMatch = p.id.match(/(?:^|-)u(\d+)$/i);
                                const uid =
                                  fromRow?.user_id ||
                                  (uidMatch ? Number(uidMatch[1]) : 0);
                                const member = members.find((m) => m.id === uid);
                                byKey.set(p.id, {
                                  identity: p.id,
                                  name: p.name,
                                  user_id: uid,
                                  avatar_url:
                                    member?.avatar_url ||
                                    fromRow?.avatar_url ||
                                    p.avatarUrl ||
                                    '',
                                  ramal: fromRow?.ramal || member?.ramal || '',
                                  work_status:
                                    fromRow?.work_status ||
                                    presenceQ.data?.work_statuses?.[String(uid)] ||
                                    member?.work_status ||
                                    '',
                                  location: fromRow?.location,
                                  ping_ms: fromRow?.ping_ms,
                                  speaking: p.speaking,
                                  sharing: p.hasScreen,
                                });
                              }
                              return [...byKey.values()];
                            }
                            return fromApi;
                          })().map((p) => {
                            const canKickVoice =
                              canModerate &&
                              !!p.user_id &&
                              p.user_id !== user?.id;
                            const self =
                              p.user_id === user?.id ||
                              (voiceChannelId === c.id &&
                                voice.participants.some((x) => x.isLocal && x.id === p.identity));
                            const st = presenceQ.data?.on_call?.[String(p.user_id)]
                              ? 'em_chamada'
                              : p.user_id === user?.id
                                ? workStatus || p.work_status || ''
                                : presenceQ.data?.work_statuses?.[String(p.user_id)] ||
                                  p.work_status ||
                                  '';
                            return (
                              <li
                                key={p.identity}
                                className={`comm-voice-user${p.speaking ? ' is-speaking' : ''}${self ? ' is-self' : ''}`}
                                data-voice-identity={p.identity}
                              >
                                <div className="comm-voice-user-av">
                                  <Avatar name={p.name} url={p.avatar_url} />
                                  <span className="comm-dot" aria-hidden />
                                </div>
                                <div className="comm-voice-user-meta">
                                  <span className="comm-voice-user-name">
                                    {p.name}
                                    {p.sharing ? (
                                      <span className="comm-voice-rec" title="Transmitindo tela">
                                        <i className="comm-voice-rec-dot" aria-hidden />
                                        <span>REC</span>
                                      </span>
                                    ) : null}
                                  </span>
                                  <ShowcaseBadges
                                    items={
                                      (p.user_id &&
                                        server?.members.find((m) => m.id === p.user_id)?.showcase_items) ||
                                      []
                                    }
                                    size="xs"
                                    onOpen={setItemDetail}
                                  />
                                  {p.ramal || (st && st !== 'em_chamada') ? (
                                    <div className="comm-badges">
                                      {p.ramal ? (
                                        <span
                                          className={`comm-ramal-badge${st === 'em_chamada' ? ' is-oncall' : ''}`}
                                          title={`Ramal ${p.ramal}`}
                                        >
                                          <Phone size={11} aria-hidden />
                                          {p.ramal}
                                          {st === 'em_chamada' ? (
                                            <em className="comm-ramal-oncall">Em ligação</em>
                                          ) : null}
                                        </span>
                                      ) : null}
                                      {st && st !== 'em_chamada' ? (
                                        <span className="comm-work-status" data-status={st} title={statusLabel(st)}>
                                          {statusLabel(st)}
                                        </span>
                                      ) : null}
                                    </div>
                                  ) : null}
                                  {p.location || p.ping_ms != null ? (
                                    <span className="comm-voice-net">
                                      {p.location ? (
                                        <span className="comm-voice-loc">{p.location}</span>
                                      ) : null}
                                      {p.location && p.ping_ms != null ? (
                                        <span className="comm-voice-net-sep" aria-hidden>
                                          ·
                                        </span>
                                      ) : null}
                                      {p.ping_ms != null ? (
                                        <span
                                          className={`comm-voice-ping is-${pingQuality(p.ping_ms)}`}
                                          title={`Ping ${Math.round(p.ping_ms)} ms`}
                                        >
                                          {Math.round(p.ping_ms)} ms
                                        </span>
                                      ) : null}
                                    </span>
                                  ) : null}
                                </div>
                                {canKickVoice ? (
                                  <button
                                    type="button"
                                    className="comm-voice-kick"
                                    title="Desconectar da voz"
                                    onClick={() => {
                                      void api(
                                        `/api/community/servers/${serverId}/members/${p.user_id}/voice-disconnect`,
                                        {
                                          method: 'POST',
                                          body: JSON.stringify({ channel_id: c.id }),
                                        },
                                      ).then(() => presenceQ.refetch());
                                    }}
                                  >
                                    <PhoneOff size={12} />
                                  </button>
                                ) : null}
                              </li>
                            );
                          })}
                        </ul>
                      </li>
                    ))}
                </ul>
              </div>
              <div className="comm-cat">
                <button type="button" className="comm-cat-toggle" disabled>
                  <ChevronDown size={14} /> Competitivo
                </button>
                <ul>
                  <li className="comm-ch-wrap">
                    <div className="comm-ch-row">
                      <button
                        type="button"
                        className={`comm-ch${view === 'match' ? ' is-on' : ''}`}
                        onClick={() => openPartidasChannel()}
                      >
                        <CirclePlay size={16} aria-hidden />
                        <span>Partidas</span>
                        {privateMatch.active?.status === 'live' || cs2Gsi.snap ? (
                          <span className="comm-ch-live-badge" title="Partida / GSI ao vivo">
                            LIVE
                          </span>
                        ) : null}
                      </button>
                    </div>
                  </li>
                  {(privateMatch.serverRooms || []).map((r) => {
                    const live = r.status === 'live' || r.status === 'connecting';
                    return (
                      <li className="comm-ch-wrap" key={r.id}>
                        <div className="comm-ch-row">
                          <button
                            type="button"
                            className={`comm-ch comm-ch-match${privateMatch.active?.id === r.id ? ' is-on' : ''}`}
                            onClick={() => {
                              openPartidasChannel();
                              if (r.youPending) void privateMatch.joinRoom(r.id);
                              else if (r.isMember) void privateMatch.refresh();
                              else if (r.canWatch) void privateMatch.spectate(r.id);
                            }}
                          >
                            <span className="comm-ch-match-dot" aria-hidden />
                            <span>{r.name}</span>
                            {live ? (
                              <span className="comm-ch-live-badge" title="Placar">
                                {r.scoreCt}:{r.scoreT}
                              </span>
                            ) : (
                              <span className="comm-ch-match-status">{r.status}</span>
                            )}
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            </div>
            )}
          </div>
          </>
          )}

          <div className="comm-userbar">
            <div
              className="comm-userbar-persona"
              role="button"
              tabIndex={0}
              title="Editar perfil"
              onClick={() => {
                setProfileTab('appearance');
                setProfileOpen(true);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setProfileTab('appearance');
                  setProfileOpen(true);
                }
              }}
            >
              <Avatar name={meName} url={meFace} />
              <div className="comm-userbar-meta">
                <div className="comm-userbar-name-row">
                  <strong>{meName}</strong>
                  <button
                    type="button"
                    className={`comm-userbar-noise-btn${audioPrefs.noiseEngine !== 'off' ? ' is-on' : ''}`}
                    title={
                      audioPrefs.noiseEngine === 'off'
                        ? 'Filtro de ruído desligado'
                        : audioPrefs.noiseEngine === 'browser'
                          ? 'Filtro browser ligado'
                          : `${
                              audioPrefs.noiseEngine === 'rnnoise'
                                ? 'RNNoise'
                                : audioPrefs.noiseEngine === 'dtln'
                                  ? 'DTLN'
                                  : audioPrefs.noiseEngine === 'krisp'
                                    ? 'Krisp'
                                    : 'DeepFilterNet'
                            } ${audioPrefs.noiseLevel}%`
                    }
                    aria-pressed={audioPrefs.noiseEngine !== 'off'}
                    onClick={(e) => {
                      e.stopPropagation();
                      const nextEngine =
                        audioPrefs.noiseEngine === 'off' ? 'krisp' : 'off';
                      setAudioPrefs({
                        ...audioPrefs,
                        noiseEngine: nextEngine as typeof audioPrefs.noiseEngine,
                        noiseFilter: nextEngine !== 'off',
                      });
                    }}
                  >
                    <AudioLines size={14} />
                  </button>
                  <button
                    type="button"
                    className="comm-userbar-profile-btn"
                    title="Editar perfil"
                    onClick={(e) => {
                      e.stopPropagation();
                      setProfileTab('appearance');
                      setProfileOpen(true);
                    }}
                  >
                    <UserRoundCog size={14} />
                  </button>
                  <button
                    type="button"
                    className="comm-userbar-profile-btn"
                    title="Steam CS2 · Trade URL · insignias"
                    data-comm-steam-setup
                    onClick={(e) => {
                      e.stopPropagation();
                      setSteamOpen(true);
                    }}
                  >
                    <Link2 size={14} />
                  </button>
                  <button
                    type="button"
                    className="comm-userbar-profile-btn"
                    title="Minhas trocas"
                    data-comm-my-trades
                    onClick={(e) => {
                      e.stopPropagation();
                      setTradesOpen(true);
                    }}
                  >
                    <ArrowLeftRight size={14} />
                  </button>
                </div>
                <span className="muted">{voice.connected ? 'Em voz' : 'Pronto'}</span>
              </div>
            </div>
            <ShowcaseBadges
              items={
                (user && server?.members.find((m) => m.id === user.id)?.showcase_items) || []
              }
              size="xs"
              className="comm-userbar-badges"
              onOpen={setItemDetail}
            />
            <div className="comm-userbar-controls">
              <button
                type="button"
                className="comm-ctrl"
                title="Temas premium"
                onClick={() => setThemeOpen(true)}
              >
                <Palette size={16} />
              </button>
              <button
                type="button"
                className="comm-ctrl"
                title="Áudio e voz"
                onClick={() => setAudioOpen(true)}
              >
                <Settings size={16} />
              </button>
              <button
                type="button"
                className={`comm-ctrl${!voice.micOn || voice.deafened ? ' is-off' : ''}`}
                title="Microfone"
                aria-pressed={!voice.micOn || voice.deafened}
                onClick={() => void voice.toggleMic()}
              >
                {voice.micOn && !voice.deafened ? <Mic size={16} /> : <MicOff size={16} />}
              </button>
              <button
                type="button"
                className={`comm-ctrl${voice.deafened ? ' is-off' : ''}`}
                title="Fones / ensurdecer"
                aria-pressed={voice.deafened}
                onClick={() => void voice.toggleDeafen()}
              >
                {voice.deafened ? <HeadphoneOff size={16} /> : <Headphones size={16} />}
              </button>
              <button
                type="button"
                className="comm-ctrl"
                title="Desconectar"
                disabled={!voice.connected}
                onClick={() => {
                  leaveVoice();
                  void presenceQ.refetch();
                }}
              >
                <PhoneOff size={16} />
              </button>
              <button
              type="button"
              className="comm-ctrl"
              title="Sair da conta"
              onClick={() => {
                if (window.sfDesktop?.logout) void window.sfDesktop.logout();
                else void logout();
              }}
            >
              <LogOut size={16} />
            </button>
            </div>
          </div>
        </aside>

        <section className="comm-main" data-theme-surface="chat">
          {isWaHub ? <WaChatPane wa={wa} /> : null}

          {!isWaHub &&
          view !== 'match' &&
          (view === 'empty' || (!activeChannel && view !== 'dm') || (view === 'dm' && !dmUserId)) ? (
            <div className="comm-empty">
              <div className="comm-empty-card">
                <div className="comm-empty-icon">
                  {isDmHub ? <Mail size={32} /> : <MessagesSquare size={32} />}
                </div>
                <h1>{isDmHub ? 'Mensagens diretas' : brandName}</h1>
                <p>
                  {isDmHub
                    ? 'Selecione uma conversa na barra lateral ou abra o perfil de um membro e clique em Mensagem.'
                    : 'Servidores de escritório: chat, voz, reunião e compartilhamento de tela'}
                </p>
                {!isDmHub ? (
                  <div className="comm-empty-actions">
                    <button type="button" className="btn btn-primary" onClick={() => setCreateOpen(true)}>
                      Criar servidor
                    </button>
                    <Link className="btn" to="/descobrir">
                      Descobrir servidores
                    </Link>
                    <button type="button" className="btn" onClick={() => setJoinOpen(true)}>
                      Entrar com convite
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          {!isWaHub && view === 'chat' && activeChannel ? (
            <div className="comm-chat">
              <header className="comm-main-head">
                <ChannelIcon channel={activeChannel} />
                <span>{activeChannel.name}</span>
              </header>
              {serverSystemNotice ? (
                <div className="comm-msg-system comm-msg-system-banner" role="status">
                  ⚙️ {serverSystemNotice}
                </div>
              ) : null}
              <div className="comm-messages">
                {messages.map((m) => {
                  const isSystem =
                    !!m.system ||
                    /^\s*⚙️/.test(m.body || '') ||
                    /Partida Privada Castino\.Tech/i.test(m.body || '');
                  return (
                  <div
                    className={`comm-msg${isSystem ? ' is-system' : ''}`}
                    key={m.id}
                    data-msg-id={m.id}
                  >
                    {isSystem ? (
                      <div className="comm-msg-system" aria-label="Mensagem de sistema">
                        {m.body}
                      </div>
                    ) : (
                      <>
                    <Avatar name={m.user.label} url={m.user.avatar_url} />
                    <div className="comm-msg-body">
                      <div className="comm-msg-head">
                        <strong>{m.user.label}</strong>
                        {user && (m.user.id === user.id || canModerate) ? (
                          <button
                            type="button"
                            className="comm-msg-del"
                            title="Excluir mensagem"
                            onClick={() => void deleteMsg(m.id)}
                          >
                            <Trash2 size={14} />
                          </button>
                        ) : null}
                      </div>
                      <span>{m.body}</span>
                    </div>
                      </>
                    )}
                  </div>
                  );
                })}
              </div>
              <form className="comm-compose" onSubmit={(e) => void sendMessage(e)}>
                <div className="comm-compose-input-wrap">
                  <textarea
                    name="body"
                    maxLength={2000}
                    rows={1}
                    placeholder="Escreva uma mensagem… (Shift+Enter para nova linha)"
                    autoComplete="off"
                    required
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        e.currentTarget.form?.requestSubmit();
                      }
                    }}
                  />
                </div>
                <button type="submit" className="btn btn-primary" title="Enviar">
                  <Send size={16} />
                </button>
              </form>
            </div>
          ) : null}

          {!isWaHub && view === 'match' && hasServer ? (
            <>
              {serverSystemNotice ||
              privateMatch.active?.feed?.some((f) => f.type === 'system') ? (
                <div className="comm-msg-system comm-msg-system-banner" role="status">
                  ⚙️{' '}
                  {serverSystemNotice ||
                    privateMatch.active?.feed?.find((f) => f.type === 'system')?.text ||
                    'Partida Privada Castino.Tech'}
                </div>
              ) : null}
            <Cs2PartidasHub
              match={privateMatch.active}
              serverRooms={privateMatch.serverRooms}
              serverId={serverId ?? undefined}
              userId={user?.id ?? undefined}
              members={members.map((m) => ({
                id: m.id,
                label: m.label,
                display_name: m.label,
                username: m.label,
                online: online.has(m.id),
              }))}
              busy={privateMatch.busy}
              bootInfo={privateMatch.bootInfo}
              hostOpts={privateMatch.hostOpts}
              needsConsoleKey={privateMatch.needsConsoleKey}
              gsiSnap={cs2Gsi.snap}
              gsiEnabled={!!cs2Gsi.status?.enabled}
              focusLobbyToken={partidasLobbyFocus}
              onOpenConsoleKey={() => setMatchConsoleKeyOpen(true)}
              onCreate={() => {
                void ensurePartidasSteam().then((ok) => {
                  if (ok) setMatchCreateOpen(true);
                });
              }}
              onJoinRoom={(id) => {
                void ensurePartidasSteam().then((ok) => {
                  if (ok) void privateMatch.joinRoom(id).then(() => undefined);
                });
              }}
              onSpectateRoom={(id) => {
                void ensurePartidasSteam().then((ok) => {
                  if (ok) void privateMatch.spectate(id).then(() => undefined);
                });
              }}
              onOpenRoom={(id) => {
                if (privateMatch.active?.id === id) return;
                if (privateMatch.serverRooms?.find((r) => r.id === id)?.youPending) {
                  void privateMatch.joinRoom(id);
                }
              }}
              onRefreshRooms={() => void privateMatch.refreshServerRooms()}
              onReady={(ready) => {
                if (privateMatch.active) void privateMatch.setReady(privateMatch.active.id, ready);
              }}
              onInvite={(id) => {
                if (privateMatch.active) void privateMatch.invite(privateMatch.active.id, id);
              }}
              onStartVote={() => {
                if (privateMatch.active) void privateMatch.startVote(privateMatch.active.id);
              }}
              onEndVote={() => {
                if (!privateMatch.active) return;
                void privateMatch.endVote(privateMatch.active.id);
              }}
              onVote={(mapId) => {
                if (privateMatch.active) void privateMatch.castVote(privateMatch.active.id, mapId);
              }}
              onPickSide={(side) => {
                if (privateMatch.active) void privateMatch.pickVetoSide(privateMatch.active.id, side);
              }}
              onHostBoot={() => {
                if (privateMatch.active) void privateMatch.hostBootAndReady(privateMatch.active);
              }}
              onValveStart={() => {
                if (privateMatch.active) void privateMatch.valveStart(privateMatch.active.id);
              }}
              onReconnect={() => void privateMatch.reconnect()}
              onEnd={() => void privateMatch.end()}
            />
            </>
          ) : null}

          {!isWaHub && view === 'voice' && activeChannel && voiceServerId === serverId ? (
            <div className="comm-voice-wrap" data-theme-surface="stage">
              <VoiceStage
                channelName={activeChannel.name}
                kind={activeChannel.kind}
                livekitReady={!!server?.livekit}
                status={voice.error || (voice.connected ? 'Conectado' : 'Conectando…')}
                participants={voice.participants}
                connected={voice.connected}
                sharing={voice.sharing}
                micOn={voice.micOn}
                deafened={voice.deafened}
                focusIdentity={voice.focusIdentity}
                volumes={voice.volumes}
                audioSignals={voice.audioSignals}
                streamStats={voice.streamStats}
                publicWatchUrl={publicWatch?.url}
                onFocus={voice.setFocusIdentity}
                onShare={() => {
                  if (voice.sharing) {
                    void (async () => {
                      await voice.shareScreen();
                      await stopPublicWatch();
                    })();
                  } else setShareOpen(true);
                }}
                onToggleMic={() => void voice.toggleMic()}
                onLeave={() => {
                  void (async () => {
                    if (publicWatch) await stopPublicWatch();
                    leaveVoice();
                    void presenceQ.refetch();
                  })();
                }}
                onVolume={voice.setParticipantVolume}
              />
            </div>
          ) : null}

          {!isWaHub && view === 'dm' && dmUserId ? (
            <div className="comm-chat">
              <header className="comm-main-head">
                <Mail size={18} />
                <span>{dmPeer?.label || 'DM'}</span>
              </header>
              <div className="comm-messages">
                {dmMessages.map((m) => (
                  <div className="comm-msg" key={m.id}>
                    <Avatar
                      name={m.mine ? meName : m.user.label}
                      url={m.mine ? meFace : m.user.avatar_url}
                    />
                    <div className="comm-msg-body">
                      <div className="comm-msg-head">
                        <strong>{m.mine ? meName : m.user.label}</strong>
                      </div>
                      <span>{m.body}</span>
                    </div>
                  </div>
                ))}
                {!dmMessages.length ? (
                  <div className="comm-msg">
                    <div className="comm-msg-body">
                      <span className="muted">Nova conversa — envie a primeira mensagem.</span>
                    </div>
                  </div>
                ) : null}
              </div>
              <form className="comm-compose" onSubmit={(e) => void sendDm(e)}>
                <div className="comm-compose-input-wrap">
                  <textarea
                    name="body"
                    maxLength={2000}
                    rows={1}
                    placeholder="Escreva uma mensagem… (Shift+Enter para nova linha)"
                    autoComplete="off"
                    required
                    value={dmDraft}
                    onChange={(e) => setDmDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        e.currentTarget.form?.requestSubmit();
                      }
                    }}
                  />
                </div>
                <button type="submit" className="btn btn-primary" title="Enviar">
                  <Send size={16} />
                </button>
              </form>
            </div>
          ) : null}

        </section>

        <aside
          className={`comm-members-panel${hasWaPeer ? ' is-wa-members' : ''}${
            !hasWaPeer && !membersPanelOpen ? ' is-collapsed' : ''
          }`}
          data-theme-surface="members"
          hidden={hasWaPeer ? false : !hasServer || isDmHub || isWaHub}
          style={
            hasWaPeer || (hasServer && !isDmHub && !isWaHub)
              ? undefined
              : { display: 'none' }
          }
        >
          {hasWaPeer ? (
            <>
              <div className="comm-members-head">
                <Users size={16} aria-hidden />
                <span className="comm-members-title">
                  {wa.isGroup ? 'Grupo' : 'Contato'}
                </span>
                <button
                  type="button"
                  className="comm-members-collapse"
                  title="Fechar painel"
                  onClick={() => {
                    wa.setChatJid(null);
                    wa.setChatName('');
                    wa.setIsGroup(false);
                  }}
                >
                  <PanelRightClose size={15} />
                </button>
              </div>
              <div data-comm-members>
                <WaSidePanel wa={wa} />
              </div>
            </>
          ) : (
            <>
          <div className="comm-members-head">
            <Users size={16} aria-hidden />
            <span className="comm-members-title">Membros</span>
            {membersPanelOpen ? (
              <span className="comm-members-count">
                {membersHideOffline ? onlineMembers.length : members.length}
              </span>
            ) : null}
            {serverId && !isDmHub && !isWaHub ? (
              <button
                type="button"
                className="btn pm-members-btn"
                title="Abrir canal Partidas"
                onClick={() => {
                  openPartidasChannel();
                  if (!privateMatch.active) setMatchCreateOpen(true);
                }}
              >
                <CirclePlay size={14} aria-hidden />
                <span>Partida</span>
              </button>
            ) : null}
            <button
              type="button"
              className="comm-members-collapse"
              title={membersPanelOpen ? 'Ocultar membros' : 'Mostrar membros'}
              aria-pressed={!membersPanelOpen}
              onClick={() => setMembersPanelOpen((v) => !v)}
            >
              {membersPanelOpen ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
            </button>
          </div>
          {membersPanelOpen ? (
            <div className="comm-members-filters" role="group" aria-label="Filtros da lista">
              <button
                type="button"
                className={`comm-members-filter${membersSortByRole ? ' is-on' : ''}`}
                title={membersSortByRole ? 'Ordenação por status' : 'Ordenar por cargos'}
                aria-pressed={membersSortByRole}
                onClick={() => setMembersSortByRole((v) => !v)}
              >
                <Shield size={14} aria-hidden />
                <span>Cargos</span>
              </button>
              <button
                type="button"
                className={`comm-members-filter${membersHideOffline ? ' is-on' : ''}`}
                title={membersHideOffline ? 'Mostrar offline' : 'Ocultar offline'}
                aria-pressed={membersHideOffline}
                onClick={() => setMembersHideOffline((v) => !v)}
              >
                <UserCheck size={14} aria-hidden />
                <span>Online</span>
              </button>
            </div>
          ) : null}
          {membersPanelOpen ? (
          <div data-comm-members className="comm-scroll">
            {membersSortByRole ? (
              membersByRoleGroups.map((g) => {
                const open = roleGroupsOpen[g.key] !== false;
                return (
                  <section
                    key={g.key}
                    className={`comm-member-group${open ? '' : ' is-collapsed'}`}
                  >
                    <button
                      type="button"
                      className="comm-member-group-head"
                      aria-expanded={open}
                      onClick={() =>
                        setRoleGroupsOpen((s) => ({ ...s, [g.key]: !open }))
                      }
                    >
                      <span
                        className="comm-member-group-dot"
                        style={{ background: g.color }}
                        aria-hidden
                      />
                      <span className="comm-member-group-label">
                        {g.label} — {g.members.length}
                      </span>
                      <ChevronDown size={14} aria-hidden />
                    </button>
                    {open ? (
                      <div className="comm-member-group-body">
                        {g.members.map((m) => renderMemberCard(m, online.has(m.id)))}
                      </div>
                    ) : null}
                  </section>
                );
              })
            ) : (
              <>
                <section
                  className={`comm-member-group${memberGroupsOpen.online ? '' : ' is-collapsed'}`}
                >
                  <button
                    type="button"
                    className="comm-member-group-head"
                    aria-expanded={memberGroupsOpen.online}
                    onClick={() =>
                      setMemberGroupsOpen((s) => ({ ...s, online: !s.online }))
                    }
                  >
                    <span className="comm-member-group-dot is-online" aria-hidden />
                    <span className="comm-member-group-label">
                      Online — {onlineMembers.length}
                    </span>
                    <ChevronDown size={14} aria-hidden />
                  </button>
                  {memberGroupsOpen.online ? (
                    <div className="comm-member-group-body">
                      {onlineMembers.map((m) => renderMemberCard(m, true))}
                    </div>
                  ) : null}
                </section>

                {!membersHideOffline ? (
                  <section
                    className={`comm-member-group${memberGroupsOpen.offline ? '' : ' is-collapsed'}`}
                  >
                    <button
                      type="button"
                      className="comm-member-group-head"
                      aria-expanded={memberGroupsOpen.offline}
                      onClick={() =>
                        setMemberGroupsOpen((s) => ({ ...s, offline: !s.offline }))
                      }
                    >
                      <span className="comm-member-group-dot is-offline" aria-hidden />
                      <span className="comm-member-group-label">
                        Offline — {offlineMembers.length}
                      </span>
                      <ChevronDown size={14} aria-hidden />
                    </button>
                    {memberGroupsOpen.offline ? (
                      <div className="comm-member-group-body">
                        {offlineMembers.map((m) => renderMemberCard(m, false))}
                      </div>
                    ) : null}
                  </section>
                ) : null}
              </>
            )}
          </div>
          ) : null}
            </>
          )}
        </aside>
      </div>

      <WelcomeTourDialog
        open={welcomeOpen}
        onClose={() => setWelcomeOpen(false)}
        onCreateServer={() => setCreateOpen(true)}
        onJoinInvite={() => setJoinOpen(true)}
      />

      <CreateServerDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onSubmit={createServer}
      />

      <JoinInviteDialog
        open={joinOpen}
        onClose={() => setJoinOpen(false)}
        onSubmit={joinServer}
      />

      {serverId ? (
        <CreateChannelDialog
          open={channelOpen}
          onClose={() => setChannelOpen(false)}
          serverId={serverId}
          onDone={() => void qc.invalidateQueries({ queryKey: ['server', serverId] })}
        />
      ) : null}

      <ChannelSettingsDialog
        open={!!channelEdit}
        onClose={() => setChannelEdit(null)}
        channel={channelEdit}
        onDone={() => {
          void qc.invalidateQueries({ queryKey: ['server', serverId] });
          if (channelEdit && channelId === channelEdit.id) {
            /* keep current route; name refresh via invalidate */
          }
        }}
      />

      {server ? (
        <ServerSettingsDialog
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          serverId={server.id}
          canManageRoles={canModerate}
          initialTab={settingsTab}
          members={server.members.map((m) => ({ id: m.id, label: m.label, role: m.role }))}
          initial={{
            name: server.name,
            description: server.description || '',
            is_listed: server.is_listed,
            icon_url: server.icon_url || '',
            banner_url: server.banner_url || '',
          }}
          onDone={() => {
            void qc.invalidateQueries({ queryKey: ['server', serverId] });
            void qc.invalidateQueries({ queryKey: ['servers'] });
          }}
        />
      ) : null}

      {user ? (
        <ProfileDialog
          open={profileOpen}
          onClose={() => setProfileOpen(false)}
          initialTab={profileTab}
          initial={{
            display_name: user.label,
            ramal: profileRamal,
            avatar_url: user.avatar_url || '',
            username: user.username,
          }}
          onOpenSteamShowcase={() => setSteamOpen(true)}
          onDone={(label, avatar, ramal) => {
            setUser({ ...user, label, avatar_url: avatar });
            setProfileRamal(ramal);
            void qc.invalidateQueries({ queryKey: ['server', serverId] });
            void qc.invalidateQueries({ queryKey: ['presence', serverId] });
          }}
        />
      ) : null}

      <SteamSetupDialog
        open={steamOpen}
        onClose={() => setSteamOpen(false)}
        onSaved={() => void qc.invalidateQueries({ queryKey: ['server', serverId] })}
      />

      <PartidasSteamGateDialog
        open={partidasSteamGateOpen}
        onClose={() => setPartidasSteamGateOpen(false)}
        onLinked={() => {
          setPartidasSteamGateOpen(false);
          if (serverId) {
            setIsWaHub(false);
            setView('match');
            nav(`/comunidade/${serverId}`);
          }
        }}
      />

      <ThemeSettingsDialog
        open={themeOpen}
        onClose={() => setThemeOpen(false)}
        premium={!!user?.premium_themes || !!user?.is_super}
        currentTheme={themeState}
        previewRoot={commRootRef.current}
        onSaved={(theme) => setThemeState(theme)}
      />

      {user ? (
        <TradesListDialog
          open={tradesOpen}
          onClose={() => setTradesOpen(false)}
          myUserId={user.id}
        />
      ) : null}
      <TradeComposerDialog
        open={!!tradePartner}
        onClose={() => setTradePartner(null)}
        partner={tradePartner}
        onDone={() => setTradesOpen(true)}
      />

      <InviteDialog
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        url={inviteInfo.url}
        code={inviteInfo.code}
      />

      <JoinRequestsDialog
        open={requestsOpen}
        onClose={() => {
          setRequestsOpen(false);
          void api<{ requests: unknown[] }>('/api/community/join-requests')
            .then((d) => setRequestsCount(d.requests?.length || 0))
            .catch(() => undefined);
        }}
      />

      <SettingsAudioDialog
        open={audioOpen}
        onClose={() => setAudioOpen(false)}
        prefs={audioPrefs}
        onSave={setAudioPrefs}
      />

      <ShareScreenDialog
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        onConfirm={(opts) => void startShareWithOpts(opts)}
      />

      {voice.connected && localStorage.getItem('sf-voice-debug') === '1' ? (
        <VoiceDebugBalloon
          open
          debug={voice.voiceDebug}
          sharing={voice.sharing}
          onShareVideoOnly={() => {
            void startShareWithOpts({
              quality: '720',
              fps: 30,
              audioMode: 'off',
              bitrateMode: 'fixed',
              title: 'teste-so-video',
              publicWatch: false,
              publicWatchMax: 50,
              publicWatchCustomNames: false,
              publicWatchChat: false,
              publicWatchChatPost: false,
            });
          }}
          onShareWithAppAudio={() => {
            void startShareWithOpts({
              quality: '720',
              fps: 30,
              audioMode: 'app',
              bitrateMode: 'fixed',
              title: 'teste-video-app',
              publicWatch: false,
              publicWatchMax: 50,
              publicWatchCustomNames: false,
              publicWatchChat: false,
              publicWatchChatPost: false,
            });
          }}
          onStopShare={() => {
            void voice.shareScreen();
          }}
        />
      ) : null}

      <MemberProfileDialog
        open={!!memberProfile}
        onClose={() => setMemberProfile(null)}
        member={memberProfile}
        serverId={serverId || 0}
        myUserId={user?.id}
        canKick={canModerate && memberProfile?.role !== 'owner'}
        canAssignRoles={canModerate}
        canRemote={!!user?.premium_themes || !!user?.is_super}
        remoteBusy={remote.busy}
        onDm={(id) => enterDmHub(id, memberProfile?.label)}
        onTrade={(id, label) => setTradePartner({ id, label })}
        onKick={(id, label) => void kickMember(id, label)}
        onRemoteControl={(id) => {
          void remote.requestAccess(id, 'control_target').catch((e) => {
            window.alert(e instanceof Error ? e.message : 'Falha no pedido remoto');
          });
        }}
        onRemoteInvite={(id) => {
          void remote.requestAccess(id, 'invite_helper').catch((e) => {
            window.alert(e instanceof Error ? e.message : 'Falha no pedido remoto');
          });
        }}
        onDone={() => void qc.invalidateQueries({ queryKey: ['server', serverId] })}
        onOpenItem={setItemDetail}
      />

      <RemoteRequestModal
        open={!!remote.incoming}
        session={remote.incoming}
        busy={remote.busy}
        error={remote.error}
        onAccept={() => void remote.respond(true)}
        onDeny={() => void remote.respond(false)}
      />

      <MatchInviteModal
        open={!!privateMatch.incoming}
        match={privateMatch.incoming}
        busy={privateMatch.busy}
        onAccept={() => {
          if (!privateMatch.incoming) return;
          const matchId = privateMatch.incoming.id;
          const inviteServerId = privateMatch.incoming.serverId;
          try {
            sessionStorage.setItem('sf_force_partidas_lobby', matchId);
          } catch {
            /* ignore */
          }
          void privateMatch.respond(matchId, true).then(() => {
            openPartidasChannel({
              requireSteam: false,
              focusLobby: true,
              serverId: inviteServerId || serverId || undefined,
            });
          });
        }}
        onDecline={() => {
          if (!privateMatch.incoming) return;
          void privateMatch.respond(privateMatch.incoming.id, false);
        }}
        onClose={() => privateMatch.clearIncoming()}
      />

      <MatchCreateDialog
        open={matchCreateOpen}
        busy={privateMatch.busy}
        error={privateMatch.error}
        members={(server?.members || [])
          .filter((m) => m.id !== user?.id)
          .map((m) => ({
            id: m.id,
            label: m.label,
            username: m.label,
            online: online.has(m.id),
          }))}
        onClose={() => setMatchCreateOpen(false)}
        onCreate={async (input) => {
          const m = await privateMatch.create(input);
          setMatchCreateOpen(false);
          if (!m) throw new Error('A API não devolveu a sala. Tenta outra vez.');
          openPartidasChannel({ requireSteam: false, focusLobby: true });
          try {
            sessionStorage.setItem('sf_force_partidas_lobby', m.id);
          } catch {
            /* ignore */
          }
          setPartidasLobbyFocus((n) => n + 1);
          const ok = await privateMatch.ensureConsoleKey();
          if (!ok) setMatchConsoleKeyOpen(true);
        }}
      />

      <MatchConnectPrompt
        open={!!privateMatch.connectPrompt}
        match={privateMatch.connectPrompt}
        busy={privateMatch.busy}
        onClose={() => privateMatch.dismissConnectPrompt()}
        onYesOpen={() => void privateMatch.confirmConnect(true)}
        onNoLaunch={() => void privateMatch.confirmConnect(false)}
      />

      <MatchConsoleKeyDialog
        open={matchConsoleKeyOpen}
        onClose={() => setMatchConsoleKeyOpen(false)}
        onSaved={() => setMatchConsoleKeyOpen(false)}
        save={(vk) => privateMatch.saveConsoleKey(vk)}
      />

      <ItemDetailDialog
        open={!!itemDetail}
        onClose={() => setItemDetail(null)}
        item={itemDetail}
      />

      {server ? (
        <MembersManageDialog
          open={membersManageOpen}
          onClose={() => setMembersManageOpen(false)}
          serverId={server.id}
          members={server.members}
          canManage={canModerate}
          voiceChannelByUser={voiceChannelByUser}
          onDone={() => void qc.invalidateQueries({ queryKey: ['server', serverId] })}
        />
      ) : null}
    </div>
    </>
  );
}
