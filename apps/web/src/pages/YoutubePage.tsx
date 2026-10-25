import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Folder,
  FolderOpen,
  Heart,
  ListMusic,
  Pencil,
  Plus,
  Search,
  Trash2,
  Play,
  ArrowLeft,
} from 'lucide-react';
import { api } from '../lib/api';
import { WebTopNav } from '../components/WebTopNav';
import { extractYoutubeId } from '../lib/youtube';
import {
  YoutubeStage,
  YoutubeTransport,
} from '../components/youtube/YoutubePlayerHost';
import { useYoutubePlayerStore, type YtTrack } from '../store/youtubePlayer';
import { applyThemeState, type ThemeState } from '../components/ThemeSettingsDialog';
import { useAuthStore } from '../store/auth';
import { useBrandStore } from '../store/brand';

type YtItem = YtTrack & { published?: string };

type Tab = 'search' | 'favorites' | 'playlist';

function AddToPlaylistMenu({ track, onDone }: { track: YtTrack; onDone?: () => void }) {
  const playlists = useYoutubePlayerStore((s) => s.playlists);
  const addToPlaylist = useYoutubePlayerStore((s) => s.addToPlaylist);
  const createPlaylist = useYoutubePlayerStore((s) => s.createPlaylist);
  const [open, setOpen] = useState(false);
  const [newName, setNewName] = useState('');

  if (!open) {
    return (
      <button
        type="button"
        className="yt-icon-btn"
        title="Adicionar à playlist"
        onClick={() => setOpen(true)}
      >
        <Plus size={14} />
      </button>
    );
  }

  return (
    <div className="yt-pl-picker">
      <div className="yt-pl-picker-head">
        <strong>Salvar em…</strong>
        <button type="button" className="yt-icon-btn" onClick={() => setOpen(false)} title="Fechar">
          ×
        </button>
      </div>
      <ul className="yt-pl-picker-list">
        {playlists.map((pl) => {
          const has = pl.tracks.some((t) => t.id === track.id);
          return (
            <li key={pl.id}>
              <button
                type="button"
                disabled={has}
                onClick={() => {
                  addToPlaylist(track, pl.id);
                  setOpen(false);
                  onDone?.();
                }}
              >
                <Folder size={14} />
                <span>{pl.name}</span>
                <em>{has ? 'já tem' : `${pl.tracks.length}`}</em>
              </button>
            </li>
          );
        })}
      </ul>
      <form
        className="yt-pl-picker-new"
        onSubmit={(e) => {
          e.preventDefault();
          const id = createPlaylist(newName.trim() || 'Nova playlist');
          addToPlaylist(track, id);
          setNewName('');
          setOpen(false);
          onDone?.();
        }}
      >
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="Nova pasta…"
          autoFocus
        />
        <button type="submit" className="btn btn-sm btn-primary">
          Criar
        </button>
      </form>
    </div>
  );
}

export function YoutubePage() {
  const user = useAuthStore((s) => s.user);
  const brandShort = useBrandStore((s) => s.short_name);
  const pageRootRef = useRef<HTMLDivElement | null>(null);
  const [themeState, setThemeState] = useState<ThemeState>({ surfaces: {}, chrome: {} });
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') || '');
  const [items, setItems] = useState<YtItem[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>('search');
  const [newPlName, setNewPlName] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const isDesktop = typeof window !== 'undefined' && !!window.sfDesktop;

  const current = useYoutubePlayerStore((s) => s.current);
  const queue = useYoutubePlayerStore((s) => s.queue);
  const queueIndex = useYoutubePlayerStore((s) => s.queueIndex);
  const favorites = useYoutubePlayerStore((s) => s.favorites);
  const playlists = useYoutubePlayerStore((s) => s.playlists);
  const activePlaylistId = useYoutubePlayerStore((s) => s.activePlaylistId);
  const stage = useYoutubePlayerStore((s) => s.stage);
  const playTrack = useYoutubePlayerStore((s) => s.playTrack);
  const playPlaylist = useYoutubePlayerStore((s) => s.playPlaylist);
  const setStage = useYoutubePlayerStore((s) => s.setStage);
  const toggleFavorite = useYoutubePlayerStore((s) => s.toggleFavorite);
  const setActivePlaylist = useYoutubePlayerStore((s) => s.setActivePlaylist);
  const createPlaylist = useYoutubePlayerStore((s) => s.createPlaylist);
  const renamePlaylist = useYoutubePlayerStore((s) => s.renamePlaylist);
  const deletePlaylist = useYoutubePlayerStore((s) => s.deletePlaylist);
  const removeFromPlaylist = useYoutubePlayerStore((s) => s.removeFromPlaylist);
  const clearPlaylist = useYoutubePlayerStore((s) => s.clearPlaylist);
  const importFavoritesToPlaylist = useYoutubePlayerStore((s) => s.importFavoritesToPlaylist);
  const openPip = useYoutubePlayerStore((s) => s.openPip);

  const activePlaylist = useMemo(
    () => playlists.find((p) => p.id === activePlaylistId) || null,
    [playlists, activePlaylistId],
  );

  useEffect(() => {
    document.body.classList.add('page-youtube');
    document.body.classList.remove('page-community');
    if (isDesktop) document.body.classList.add('is-desktop-app');
    if (useYoutubePlayerStore.getState().stage !== 'pip') {
      setStage('page');
    }
    return () => {
      document.body.classList.remove('page-youtube');
      const st = useYoutubePlayerStore.getState();
      if (st.stage === 'page') st.setStage('nav');
    };
  }, [isDesktop, setStage]);

  useEffect(() => {
    if (!user) return;
    api<{ surfaces: ThemeState['surfaces']; chrome: ThemeState['chrome'] }>(
      '/api/community/themes/me',
    )
      .then((d) => setThemeState({ surfaces: d.surfaces || {}, chrome: d.chrome || {} }))
      .catch(() => undefined);
  }, [user]);

  useEffect(() => {
    applyThemeState(pageRootRef.current, themeState);
  }, [themeState]);

  const runSearch = useCallback(
    async (query: string) => {
      const trimmed = query.trim();
      if (!trimmed) return;
      const asId = extractYoutubeId(trimmed);
      if (asId) {
        const track: YtTrack = {
          id: asId,
          title: params.get('t') || `YouTube ${asId}`,
          thumb: `https://i.ytimg.com/vi/${asId}/mqdefault.jpg`,
        };
        playTrack(track, [track], 0);
        setStage('page');
        setParams({ v: asId, t: track.title });
        return;
      }
      setBusy(true);
      setError('');
      setTab('search');
      try {
        const d = await api<{ items: YtItem[] }>(
          `/api/community/youtube/search?q=${encodeURIComponent(trimmed)}`,
        );
        setItems(d.items || []);
        const cur = useYoutubePlayerStore.getState().current;
        setParams(
          cur ? { q: trimmed, v: cur.id, t: cur.title || '' } : { q: trimmed },
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Falha na busca');
        setItems([]);
      } finally {
        setBusy(false);
      }
    },
    [params, playTrack, setParams, setStage],
  );

  useEffect(() => {
    const initialQ = params.get('q');
    const v = params.get('v');
    if (v) {
      const st = useYoutubePlayerStore.getState();
      if (!st.current || st.current.id !== v) {
        playTrack(
          {
            id: v,
            title: params.get('t') || `YouTube ${v}`,
            thumb: `https://i.ytimg.com/vi/${v}/mqdefault.jpg`,
          },
          st.queue.length ? st.queue : undefined,
        );
      }
      if (st.stage !== 'pip') setStage('page');
    } else if (initialQ) {
      void runSearch(initialQ);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void runSearch(q);
  }

  function playFromResults(item: YtItem, list: YtTrack[]) {
    const idx = list.findIndex((x) => x.id === item.id);
    playTrack(item, list, idx >= 0 ? idx : 0);
    setStage('page');
    setParams({
      v: item.id,
      t: item.title,
      ...(q.trim() ? { q: q.trim() } : {}),
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  const listForTab: YtTrack[] =
    tab === 'favorites'
      ? favorites
      : tab === 'playlist'
        ? activePlaylist?.tracks || []
        : items;

  const playlistTrackCount = playlists.reduce((n, p) => n + p.tracks.length, 0);

  return (
    <>
      <WebTopNav />
      {isDesktop ? (
        <header className="yt-desktop-bar" data-theme-surface="header">
          <Link className="yt-desktop-back btn btn-sm" to="/comunidade">
            <ArrowLeft size={14} />
            Comunidade
          </Link>
          <Link className="yt-desktop-brand" to="/youtube" aria-current="page">
            YouTube
          </Link>
          <div className="yt-desktop-bar-spacer" />
          <Link className="btn btn-sm" to="/descobrir">
            Descobrir
          </Link>
        </header>
      ) : null}
      <div
        ref={pageRootRef}
        className={`comm-page yt-page${isDesktop ? ' is-desktop-yt' : ''}`}
        data-theme-surface="chat"
      >
        <header className="yt-hero">
          <div className="yt-hero-top">
            <div className="yt-hero-copy">
              <p className="yt-hero-kicker">{brandShort} · Música & vídeo</p>
              <h1>YouTube</h1>
              <p className="yt-hero-sub">
                Busque, organize pastas de playlist e continue ouvindo na comunidade
                {isDesktop
                  ? ' — use PiP para o vídeo flutuante enquanto conversa.'
                  : ' — no card do topo ou em picture-in-picture arrastável.'}
              </p>
            </div>
            <div className="yt-hero-actions">
              <Link className="btn" to="/comunidade">
                <ArrowLeft size={14} />
                Voltar à comunidade
              </Link>
            </div>
          </div>
          <form className="yt-search" onSubmit={onSubmit}>
            <Search size={18} aria-hidden />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Pesquisar ou colar link do YouTube…"
              autoFocus
            />
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? 'Buscando…' : 'Buscar'}
            </button>
          </form>
        </header>

        {error ? <div className="error">{error}</div> : null}

        {current ? (
          <section className="yt-watch">
            <div className="yt-watch-toolbar">
              <div className="yt-watch-meta">
                <strong>{current.title || 'Reproduzindo'}</strong>
                {current.channel ? <em>{current.channel}</em> : null}
                {queue.length > 1 ? (
                  <em className="yt-queue-pos">
                    {queueIndex + 1} / {queue.length} na fila
                  </em>
                ) : null}
              </div>
              <YoutubeTransport />
            </div>
            <div className={`yt-watch-player-shell${stage === 'pip' ? ' is-pip' : ''}`}>
              <YoutubeStage stage="page" className="yt-watch-player" />
              {stage === 'pip' ? (
                <div className="yt-watch-pip-hint muted">
                  Reproduzindo em picture-in-picture. Arraste o card flutuante pela tela.
                  <button type="button" className="btn btn-sm" onClick={() => setStage('page')}>
                    Trazer para cá
                  </button>
                </div>
              ) : null}
            </div>
          </section>
        ) : (
          <section className="yt-empty-stage">
            <div className="yt-empty-card">
              <Play size={28} />
              <h2>Nada tocando ainda</h2>
              <p className="muted">
                Busque um vídeo, abra um favorito ou toque uma pasta de playlist. O player fica no
                topo enquanto você navega nos servidores.
              </p>
            </div>
          </section>
        )}

        <div className="yt-library">
          <div className="yt-library-tabs" role="tablist">
            {(
              [
                ['search', 'Resultados', items.length],
                ['favorites', 'Favoritos', favorites.length],
                ['playlist', 'Playlists', playlists.length || playlistTrackCount],
              ] as const
            ).map(([id, label, count]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                className={tab === id ? 'is-on' : undefined}
                onClick={() => {
                  setTab(id);
                  if (id === 'playlist') setActivePlaylist(null);
                }}
              >
                {label}
                <span>{count}</span>
              </button>
            ))}
          </div>

          {tab === 'playlist' && !activePlaylist ? (
            <div className="yt-folders">
              <div className="yt-playlist-bar">
                <p className="muted">
                  Cada playlist é uma pasta. Crie quantas quiser, dê um nome e guarde vídeos dentro.
                </p>
                <form
                  className="yt-folder-create"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const id = createPlaylist(newPlName.trim() || 'Nova playlist');
                    setNewPlName('');
                    setActivePlaylist(id);
                  }}
                >
                  <input
                    value={newPlName}
                    onChange={(e) => setNewPlName(e.target.value)}
                    placeholder="Nome da pasta…"
                  />
                  <button type="submit" className="btn btn-primary btn-sm">
                    <Plus size={14} /> Nova playlist
                  </button>
                </form>
              </div>

              {!playlists.length ? (
                <p className="yt-lib-empty muted">Nenhuma pasta ainda — crie a primeira acima.</p>
              ) : (
                <div className="yt-folder-grid">
                  {playlists.map((pl) => (
                    <article key={pl.id} className="yt-folder-card">
                      {renamingId === pl.id ? (
                        <form
                          className="yt-folder-rename"
                          onSubmit={(e) => {
                            e.preventDefault();
                            renamePlaylist(pl.id, renameValue);
                            setRenamingId(null);
                          }}
                        >
                          <input
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            autoFocus
                          />
                          <button type="submit" className="btn btn-sm btn-primary">
                            Salvar
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm"
                            onClick={() => setRenamingId(null)}
                          >
                            Cancelar
                          </button>
                        </form>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="yt-folder-main"
                            onClick={() => setActivePlaylist(pl.id)}
                          >
                            <FolderOpen size={28} />
                            <strong>{pl.name}</strong>
                            <em>
                              {pl.tracks.length}{' '}
                              {pl.tracks.length === 1 ? 'vídeo' : 'vídeos'}
                            </em>
                          </button>
                          <div className="yt-folder-actions">
                            <button
                              type="button"
                              className="btn btn-sm btn-primary"
                              disabled={!pl.tracks.length}
                              onClick={() => {
                                playPlaylist(pl.id);
                                setStage('page');
                              }}
                            >
                              <Play size={14} /> Tocar
                            </button>
                            <button
                              type="button"
                              className="yt-icon-btn"
                              title="Renomear"
                              onClick={() => {
                                setRenamingId(pl.id);
                                setRenameValue(pl.name);
                              }}
                            >
                              <Pencil size={14} />
                            </button>
                            <button
                              type="button"
                              className="yt-icon-btn"
                              title="Excluir pasta"
                              onClick={() => {
                                if (confirm(`Excluir a playlist “${pl.name}”?`)) {
                                  deletePlaylist(pl.id);
                                }
                              }}
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </>
                      )}
                    </article>
                  ))}
                </div>
              )}
            </div>
          ) : null}

          {tab === 'playlist' && activePlaylist ? (
            <div className="yt-playlist-bar">
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setActivePlaylist(null)}
              >
                <ArrowLeft size={14} /> Pastas
              </button>
              <div className="yt-playlist-bar-title">
                <FolderOpen size={16} />
                <strong>{activePlaylist.name}</strong>
                <em className="muted">{activePlaylist.tracks.length} vídeos</em>
              </div>
              <div className="yt-playlist-actions">
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={!activePlaylist.tracks.length}
                  onClick={() => {
                    playPlaylist(activePlaylist.id);
                    setStage('page');
                  }}
                >
                  <ListMusic size={14} /> Tocar pasta
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={!favorites.length}
                  onClick={() => importFavoritesToPlaylist(activePlaylist.id)}
                >
                  <Plus size={14} /> Importar favoritos
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={!activePlaylist.tracks.length}
                  onClick={() => {
                    if (confirm('Limpar os vídeos desta pasta?')) {
                      clearPlaylist(activePlaylist.id);
                    }
                  }}
                >
                  <Trash2 size={14} /> Limpar
                </button>
              </div>
            </div>
          ) : null}

          {tab === 'favorites' && !favorites.length ? (
            <p className="yt-lib-empty muted">
              Toque no coração nos resultados ou no player para salvar favoritos.
            </p>
          ) : null}
          {tab === 'playlist' && activePlaylist && !activePlaylist.tracks.length ? (
            <p className="yt-lib-empty muted">
              Pasta vazia — use “+” nos resultados/favoritos e escolha esta playlist.
            </p>
          ) : null}
          {tab === 'search' && !items.length ? (
            <p className="yt-lib-empty muted">Busque um termo ou cole um link para começar.</p>
          ) : null}

          {(tab !== 'playlist' || activePlaylist) && (
            <div className="yt-grid">
              {listForTab.map((it) => {
                const isOn = current?.id === it.id;
                const isFav = favorites.some((f) => f.id === it.id);
                return (
                  <article key={it.id} className={`yt-card${isOn ? ' is-on' : ''}`}>
                    <button
                      type="button"
                      className="yt-card-main"
                      onClick={() => playFromResults(it, listForTab)}
                    >
                      <span className="yt-card-thumb">
                        {it.thumb || it.id ? (
                          <img
                            src={it.thumb || `https://i.ytimg.com/vi/${it.id}/mqdefault.jpg`}
                            alt=""
                            loading="lazy"
                            referrerPolicy="no-referrer"
                          />
                        ) : null}
                        <span className="yt-card-play">
                          <Play size={18} />
                        </span>
                      </span>
                      <span className="yt-card-meta">
                        <strong>{it.title}</strong>
                        <em>{it.channel || 'YouTube'}</em>
                      </span>
                    </button>
                    <div className="yt-card-actions">
                      <button
                        type="button"
                        className={`yt-icon-btn${isFav ? ' is-on' : ''}`}
                        title={isFav ? 'Remover favorito' : 'Favoritar'}
                        onClick={() => toggleFavorite(it)}
                      >
                        <Heart size={14} fill={isFav ? 'currentColor' : 'none'} />
                      </button>
                      {tab === 'playlist' && activePlaylist ? (
                        <button
                          type="button"
                          className="yt-icon-btn"
                          title="Remover da pasta"
                          onClick={() => removeFromPlaylist(it.id, activePlaylist.id)}
                        >
                          <Trash2 size={14} />
                        </button>
                      ) : (
                        <AddToPlaylistMenu track={it} />
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>

        {current && stage !== 'pip' ? (
          <p className="yt-page-hint muted">
            {isDesktop ? (
              <>
                Dica: use <strong>Voltar à comunidade</strong> na barra acima. O áudio continua; abra
                PiP para o vídeo flutuante.
              </>
            ) : (
              <>
                Dica: ao sair desta página o áudio continua no card do topo (só nome + comandos). Use
                PiP para o vídeo flutuante.
              </>
            )}
            <button type="button" className="btn btn-sm" onClick={() => openPip()}>
              Abrir PiP
            </button>
          </p>
        ) : null}
      </div>
    </>
  );
}
