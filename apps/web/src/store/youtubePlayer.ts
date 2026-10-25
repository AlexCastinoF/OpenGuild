import { create } from 'zustand';

export type YtTrack = {
  id: string;
  title: string;
  channel?: string;
  thumb?: string;
};

export type YtPlaylist = {
  id: string;
  name: string;
  tracks: YtTrack[];
  createdAt: number;
};

export type YtStage = 'page' | 'nav' | 'pip';

const FAV_KEY = 'sf-yt-favorites';
const PL_KEY = 'sf-yt-playlists';
const PL_LEGACY_KEY = 'sf-yt-playlist';
const ACTIVE_PL_KEY = 'sf-yt-active-playlist';
const VOL_KEY = 'sf-yt-volume';
const CARD_KEY = 'sf-yt-show-card';
const PIP_POS_KEY = 'sf-yt-pip-pos';

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function saveJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

function uid() {
  return `pl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function migratePlaylists(): YtPlaylist[] {
  const existing = loadJson<YtPlaylist[]>(PL_KEY, []);
  if (existing.length) return existing;
  const legacy = loadJson<YtTrack[]>(PL_LEGACY_KEY, []);
  if (!legacy.length) return [];
  const migrated: YtPlaylist[] = [
    {
      id: uid(),
      name: 'Minha playlist',
      tracks: legacy,
      createdAt: Date.now(),
    },
  ];
  saveJson(PL_KEY, migrated);
  try {
    localStorage.removeItem(PL_LEGACY_KEY);
  } catch {
    /* ignore */
  }
  return migrated;
}

type YoutubePlayerState = {
  current: YtTrack | null;
  queue: YtTrack[];
  queueIndex: number;
  playing: boolean;
  volume: number;
  muted: boolean;
  showOnCard: boolean;
  stage: YtStage;
  favorites: YtTrack[];
  playlists: YtPlaylist[];
  activePlaylistId: string | null;
  pipPos: { x: number; y: number };
  stageNodes: Partial<Record<YtStage, HTMLElement | null>>;

  registerStage: (stage: YtStage, el: HTMLElement | null) => void;
  playTrack: (track: YtTrack, queue?: YtTrack[], index?: number) => void;
  playPlaylist: (playlistId?: string) => void;
  setPlaying: (v: boolean) => void;
  togglePlay: () => void;
  next: () => void;
  prev: () => void;
  setVolume: (v: number) => void;
  toggleMute: () => void;
  setShowOnCard: (v: boolean) => void;
  setStage: (s: YtStage) => void;
  stop: () => void;
  toggleFavorite: (t: YtTrack) => void;
  isFavorite: (id: string) => boolean;
  createPlaylist: (name: string) => string;
  renamePlaylist: (id: string, name: string) => void;
  deletePlaylist: (id: string) => void;
  setActivePlaylist: (id: string | null) => void;
  addToPlaylist: (t: YtTrack, playlistId?: string) => void;
  removeFromPlaylist: (trackId: string, playlistId?: string) => void;
  clearPlaylist: (playlistId?: string) => void;
  importFavoritesToPlaylist: (playlistId?: string) => void;
  openPip: () => void;
  closePip: () => void;
  setPipPos: (pos: { x: number; y: number }) => void;
};

function persistPlaylists(playlists: YtPlaylist[]) {
  saveJson(PL_KEY, playlists);
}

export const useYoutubePlayerStore = create<YoutubePlayerState>((set, get) => {
  const playlists = migratePlaylists();
  const savedActive = localStorage.getItem(ACTIVE_PL_KEY);
  const activePlaylistId =
    savedActive && playlists.some((p) => p.id === savedActive)
      ? savedActive
      : playlists[0]?.id || null;

  return {
    current: null,
    queue: [],
    queueIndex: -1,
    playing: false,
    volume: (() => {
      const n = Number(localStorage.getItem(VOL_KEY));
      return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 80;
    })(),
    muted: false,
    showOnCard: localStorage.getItem(CARD_KEY) !== '0',
    stage: 'nav',
    favorites: loadJson<YtTrack[]>(FAV_KEY, []),
    playlists,
    activePlaylistId,
    pipPos: loadJson(PIP_POS_KEY, {
      x: typeof window !== 'undefined' ? Math.max(16, window.innerWidth - 400) : 16,
      y: typeof window !== 'undefined' ? Math.max(16, window.innerHeight - 280) : 16,
    }),
    stageNodes: {},

    registerStage: (stage, el) =>
      set((s) => ({ stageNodes: { ...s.stageNodes, [stage]: el } })),

    playTrack: (track, queue, index) => {
      const q = queue && queue.length ? queue : [track];
      const i =
        index != null && index >= 0 ? index : Math.max(0, q.findIndex((t) => t.id === track.id));
      const current = q[i] || track;
      set({
        current,
        queue: q,
        queueIndex: i >= 0 ? i : 0,
        playing: true,
      });
    },

    playPlaylist: (playlistId) => {
      const id = playlistId || get().activePlaylistId;
      const pl = get().playlists.find((p) => p.id === id);
      if (!pl?.tracks.length) return;
      if (id) {
        localStorage.setItem(ACTIVE_PL_KEY, id);
        set({ activePlaylistId: id });
      }
      get().playTrack(pl.tracks[0], pl.tracks, 0);
    },

    setPlaying: (v) => set({ playing: v }),

    togglePlay: () => set((s) => ({ playing: !s.playing })),

    next: () => {
      const { queue, queueIndex } = get();
      if (!queue.length) return;
      if (queueIndex >= queue.length - 1) return;
      const i = queueIndex + 1;
      const track = queue[i];
      if (!track) return;
      set({ current: track, queueIndex: i, playing: true });
    },

    prev: () => {
      const { queue, queueIndex } = get();
      if (!queue.length) return;
      const i = Math.max(0, queueIndex - 1);
      const track = queue[i];
      if (!track) return;
      set({ current: track, queueIndex: i, playing: true });
    },

    setVolume: (v) => {
      const volume = Math.min(100, Math.max(0, Math.round(v)));
      localStorage.setItem(VOL_KEY, String(volume));
      set({ volume, muted: volume === 0 ? true : get().muted && volume === 0 });
    },

    toggleMute: () => set((s) => ({ muted: !s.muted })),

    setShowOnCard: (v) => {
      localStorage.setItem(CARD_KEY, v ? '1' : '0');
      set({ showOnCard: v });
    },

    setStage: (stage) => set({ stage }),

    stop: () =>
      set({
        current: null,
        queue: [],
        queueIndex: -1,
        playing: false,
        stage: 'nav',
      }),

    toggleFavorite: (t) => {
      const favs = get().favorites;
      const exists = favs.some((f) => f.id === t.id);
      const next = exists ? favs.filter((f) => f.id !== t.id) : [...favs, t];
      saveJson(FAV_KEY, next);
      set({ favorites: next });
    },

    isFavorite: (id) => get().favorites.some((f) => f.id === id),

    createPlaylist: (name) => {
      const trimmed = name.trim() || 'Nova playlist';
      const pl: YtPlaylist = {
        id: uid(),
        name: trimmed,
        tracks: [],
        createdAt: Date.now(),
      };
      const playlists = [...get().playlists, pl];
      persistPlaylists(playlists);
      localStorage.setItem(ACTIVE_PL_KEY, pl.id);
      set({ playlists, activePlaylistId: pl.id });
      return pl.id;
    },

    renamePlaylist: (id, name) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      const playlists = get().playlists.map((p) =>
        p.id === id ? { ...p, name: trimmed } : p,
      );
      persistPlaylists(playlists);
      set({ playlists });
    },

    deletePlaylist: (id) => {
      const playlists = get().playlists.filter((p) => p.id !== id);
      persistPlaylists(playlists);
      const activePlaylistId =
        get().activePlaylistId === id ? playlists[0]?.id || null : get().activePlaylistId;
      if (activePlaylistId) localStorage.setItem(ACTIVE_PL_KEY, activePlaylistId);
      else localStorage.removeItem(ACTIVE_PL_KEY);
      set({ playlists, activePlaylistId });
    },

    setActivePlaylist: (id) => {
      if (id) localStorage.setItem(ACTIVE_PL_KEY, id);
      else localStorage.removeItem(ACTIVE_PL_KEY);
      set({ activePlaylistId: id });
    },

    addToPlaylist: (t, playlistId) => {
      let id = playlistId || get().activePlaylistId;
      if (!id) {
        id = get().createPlaylist('Minha playlist');
      }
      const playlists = get().playlists.map((p) => {
        if (p.id !== id) return p;
        if (p.tracks.some((x) => x.id === t.id)) return p;
        return { ...p, tracks: [...p.tracks, t] };
      });
      persistPlaylists(playlists);
      set({ playlists, activePlaylistId: id });
      localStorage.setItem(ACTIVE_PL_KEY, id);
    },

    removeFromPlaylist: (trackId, playlistId) => {
      const id = playlistId || get().activePlaylistId;
      if (!id) return;
      const playlists = get().playlists.map((p) =>
        p.id === id ? { ...p, tracks: p.tracks.filter((x) => x.id !== trackId) } : p,
      );
      persistPlaylists(playlists);
      set({ playlists });
    },

    clearPlaylist: (playlistId) => {
      const id = playlistId || get().activePlaylistId;
      if (!id) return;
      const playlists = get().playlists.map((p) =>
        p.id === id ? { ...p, tracks: [] } : p,
      );
      persistPlaylists(playlists);
      set({ playlists });
    },

    importFavoritesToPlaylist: (playlistId) => {
      const id = playlistId || get().activePlaylistId;
      if (!id) return;
      const favs = get().favorites;
      const playlists = get().playlists.map((p) => {
        if (p.id !== id) return p;
        const have = new Set(p.tracks.map((t) => t.id));
        const extra = favs.filter((f) => !have.has(f.id));
        return { ...p, tracks: [...p.tracks, ...extra] };
      });
      persistPlaylists(playlists);
      set({ playlists });
    },

    openPip: () => set({ stage: 'pip' }),

    closePip: () => {
      const onYt = typeof window !== 'undefined' && window.location.pathname.startsWith('/youtube');
      set({ stage: onYt ? 'page' : 'nav' });
    },

    setPipPos: (pipPos) => {
      saveJson(PIP_POS_KEY, pipPos);
      set({ pipPos });
    },
  };
});
