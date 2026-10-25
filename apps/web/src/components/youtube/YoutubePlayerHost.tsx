import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  Heart,
  Pause,
  PictureInPicture2,
  Play,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
  X,
  UserRound,
} from 'lucide-react';
import { api } from '../../lib/api';
import { useYoutubePlayerStore, type YtStage, type YtTrack } from '../../store/youtubePlayer';
import { useVoiceSession } from '../../voice/VoiceSessionContext';

declare global {
  interface Window {
    YT?: {
      Player: new (
        el: HTMLElement | string,
        opts: Record<string, unknown>,
      ) => YtPlayerApi;
      PlayerState?: {
        ENDED: number;
        PLAYING: number;
        PAUSED: number;
        BUFFERING: number;
        CUED: number;
      };
    };
    onYouTubeIframeAPIReady?: () => void;
  }
}

type YtPlayerApi = {
  destroy: () => void;
  loadVideoById: (id: string | { videoId: string; startSeconds?: number }) => void;
  playVideo: () => void;
  pauseVideo: () => void;
  seekTo: (seconds: number, allowSeekAhead: boolean) => void;
  setSize: (width: number, height: number) => void;
  setVolume: (n: number) => void;
  mute: () => void;
  unMute: () => void;
  getPlayerState: () => number;
  getCurrentTime: () => number;
  getDuration: () => number;
};

let ytApiPromise: Promise<NonNullable<typeof window.YT>> | null = null;

function loadYtApi() {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (ytApiPromise) return ytApiPromise;
  ytApiPromise = new Promise((resolve) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      resolve(window.YT!);
    };
    if (!document.getElementById('sf-yt-iframe-api')) {
      const s = document.createElement('script');
      s.id = 'sf-yt-iframe-api';
      s.src = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(s);
    }
  });
  return ytApiPromise;
}

/**
 * Mantém o iframe no mesmo nó (sem appendChild entre stages) e só
 * sincroniza posição/tamanho com o stage ativo — áudio continua sem corte.
 */
function useSyncPlayerFrame(
  wrapRef: RefObject<HTMLDivElement | null>,
  layerRef: RefObject<HTMLDivElement | null>,
  playerRef: RefObject<YtPlayerApi | null>,
  readyRef: RefObject<boolean>,
  mountEpoch: number,
) {
  const stage = useYoutubePlayerStore((s) => s.stage);
  const stageNodes = useYoutubePlayerStore((s) => s.stageNodes);
  const current = useYoutubePlayerStore((s) => s.current);
  const pipPos = useYoutubePlayerStore((s) => s.pipPos);
  const lastSize = useRef({ w: 0, h: 0 });

  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const layer = layerRef.current;
    if (!wrap || !layer) return;
    if (wrap.parentElement !== layer) layer.appendChild(wrap);

    const applySize = (w: number, h: number) => {
      const width = Math.max(1, Math.round(w));
      const height = Math.max(1, Math.round(h));
      wrap.style.width = `${width}px`;
      wrap.style.height = `${height}px`;
      if (
        readyRef.current &&
        playerRef.current &&
        (Math.abs(lastSize.current.w - width) > 1 || Math.abs(lastSize.current.h - height) > 1)
      ) {
        lastSize.current = { w: width, h: height };
        try {
          playerRef.current.setSize(width, height);
        } catch {
          /* ignore */
        }
      }
    };

    const applyDock = () => {
      const dock = stageNodes.nav;
      const r = dock?.getBoundingClientRect();
      wrap.hidden = false;
      wrap.classList.add('is-dock');
      wrap.classList.remove('is-page', 'is-pip');
      wrap.style.position = 'fixed';
      wrap.style.left = `${r?.left ?? 0}px`;
      wrap.style.top = `${r?.top ?? 0}px`;
      applySize(Math.max(160, r?.width ?? 160), Math.max(90, r?.height ?? 90));
      wrap.style.zIndex = '0';
      wrap.style.opacity = '0.001';
      // crítico: nunca deixar o iframe a capturar cliques fora do PiP/page
      wrap.style.pointerEvents = 'none';
      wrap.style.borderRadius = '0';
      wrap.style.overflow = 'hidden';
    };

    const sync = () => {
      if (!current) {
        wrap.hidden = true;
        wrap.classList.remove('is-page', 'is-pip');
        wrap.classList.add('is-dock');
        wrap.style.pointerEvents = 'none';
        wrap.style.opacity = '0.001';
        wrap.style.zIndex = '0';
        return;
      }
      const target = stageNodes[stage] || stageNodes.nav || null;
      if (!target || stage === 'nav' || (stage === 'pip' && !stageNodes.pip)) {
        applyDock();
        return;
      }
      const r = target.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) {
        applyDock();
        return;
      }
      wrap.hidden = false;
      wrap.classList.toggle('is-page', stage === 'page');
      wrap.classList.toggle('is-pip', stage === 'pip');
      wrap.classList.remove('is-dock');
      wrap.style.position = 'fixed';
      wrap.style.left = `${Math.round(r.left)}px`;
      wrap.style.top = `${Math.round(r.top)}px`;
      applySize(r.width, r.height);
      // PiP: vídeo ABAIXO do chrome do card (botões) e sem pointer-events
      // para não “engolir” Fechar/Card/transport.
      if (stage === 'pip') {
        wrap.style.zIndex = '99999';
        wrap.style.pointerEvents = 'none';
      } else {
        wrap.style.zIndex = '45';
        wrap.style.pointerEvents = 'auto';
      }
      wrap.style.opacity = '1';
      wrap.style.borderRadius = stage === 'page' ? '14px' : '0';
      wrap.style.overflow = 'hidden';
    };

    sync();
    const ro = new ResizeObserver(() => sync());
    const observed = new Set<Element>();
    const observe = (el: Element | null | undefined) => {
      if (!el || observed.has(el)) return;
      observed.add(el);
      ro.observe(el);
    };
    observe(stageNodes.page);
    observe(stageNodes.pip);
    observe(stageNodes.nav);
    // observa o card PiP inteiro (arraste muda o frame)
    observe(stageNodes.pip?.parentElement);
    window.addEventListener('resize', sync);
    window.addEventListener('scroll', sync, true);
    let raf = 0;
    const tick = () => {
      if (useYoutubePlayerStore.getState().stage === 'pip') {
        sync();
        raf = window.requestAnimationFrame(tick);
      }
    };
    if (stage === 'pip') raf = window.requestAnimationFrame(tick);

    return () => {
      ro.disconnect();
      window.removeEventListener('resize', sync);
      window.removeEventListener('scroll', sync, true);
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [stage, stageNodes, current, pipPos, wrapRef, layerRef, playerRef, readyRef, mountEpoch]);
}

export function YoutubeStage({
  stage,
  className,
  style,
  children,
}: {
  stage: YtStage;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}) {
  const registerStage = useYoutubePlayerStore((s) => s.registerStage);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    registerStage(stage, ref.current);
    return () => registerStage(stage, null);
  }, [registerStage, stage]);

  return (
    <div ref={ref} className={className} style={style} data-yt-stage={stage}>
      {children}
    </div>
  );
}

export function YoutubeTransport({ compact = false }: { compact?: boolean }) {
  const current = useYoutubePlayerStore((s) => s.current);
  const playing = useYoutubePlayerStore((s) => s.playing);
  const volume = useYoutubePlayerStore((s) => s.volume);
  const muted = useYoutubePlayerStore((s) => s.muted);
  const showOnCard = useYoutubePlayerStore((s) => s.showOnCard);
  const stage = useYoutubePlayerStore((s) => s.stage);
  const favorites = useYoutubePlayerStore((s) => s.favorites);
  const togglePlay = useYoutubePlayerStore((s) => s.togglePlay);
  const next = useYoutubePlayerStore((s) => s.next);
  const prev = useYoutubePlayerStore((s) => s.prev);
  const setVolume = useYoutubePlayerStore((s) => s.setVolume);
  const toggleMute = useYoutubePlayerStore((s) => s.toggleMute);
  const setShowOnCard = useYoutubePlayerStore((s) => s.setShowOnCard);
  const openPip = useYoutubePlayerStore((s) => s.openPip);
  const closePip = useYoutubePlayerStore((s) => s.closePip);
  const stop = useYoutubePlayerStore((s) => s.stop);
  const toggleFavorite = useYoutubePlayerStore((s) => s.toggleFavorite);
  const nav = useNavigate();

  if (!current) return null;

  const isFav = favorites.some((f) => f.id === current.id);

  return (
    <div className={`yt-transport${compact ? ' is-compact' : ''}`}>
      <button type="button" className="yt-t-btn" title="Anterior" onClick={() => prev()}>
        <SkipBack size={compact ? 14 : 16} />
      </button>
      <button
        type="button"
        className="yt-t-btn yt-t-play"
        title={playing ? 'Pausar' : 'Tocar'}
        onClick={() => togglePlay()}
      >
        {playing ? <Pause size={compact ? 14 : 16} /> : <Play size={compact ? 14 : 16} />}
      </button>
      <button type="button" className="yt-t-btn" title="Próximo" onClick={() => next()}>
        <SkipForward size={compact ? 14 : 16} />
      </button>
      <div className="yt-t-vol">
        <button type="button" className="yt-t-btn" title={muted ? 'Som' : 'Mudo'} onClick={() => toggleMute()}>
          {muted || volume === 0 ? <VolumeX size={14} /> : <Volume2 size={14} />}
        </button>
        {!compact ? (
          <input
            type="range"
            min={0}
            max={100}
            value={muted ? 0 : volume}
            aria-label="Volume"
            onChange={(e) => setVolume(Number(e.target.value))}
          />
        ) : null}
      </div>
      <button
        type="button"
        className={`yt-t-btn${showOnCard ? ' is-on' : ''}`}
        title="Exibir no card de membro"
        onClick={() => setShowOnCard(!showOnCard)}
      >
        <UserRound size={14} />
      </button>
      <button
        type="button"
        className={`yt-t-btn${isFav ? ' is-on' : ''}`}
        title={isFav ? 'Remover dos favoritos' : 'Favoritar'}
        onClick={() => toggleFavorite(current)}
      >
        <Heart size={14} fill={isFav ? 'currentColor' : 'none'} />
      </button>
      <button
        type="button"
        className={`yt-t-btn${stage === 'pip' ? ' is-on' : ''}`}
        title={stage === 'pip' ? 'Fechar PiP' : 'Picture-in-picture'}
        onClick={() => {
          if (stage === 'pip') closePip();
          else {
            openPip();
            if (!window.location.pathname.startsWith('/comunidade')) nav('/comunidade');
          }
        }}
      >
        <PictureInPicture2 size={14} />
      </button>
      <button type="button" className="yt-t-btn" title="Parar" onClick={() => stop()}>
        <X size={14} />
      </button>
    </div>
  );
}

/** Card do player no topo — uma linha: nome + comandos (sem vídeo). */
export function YoutubeNavPlayer() {
  const current = useYoutubePlayerStore((s) => s.current);
  const playing = useYoutubePlayerStore((s) => s.playing);
  const stage = useYoutubePlayerStore((s) => s.stage);

  if (!current || stage === 'pip') return null;

  return (
    <div className={`yt-nav-card${playing ? ' is-playing' : ''}`}>
      <Link
        to={`/youtube?v=${current.id}&t=${encodeURIComponent(current.title)}`}
        className="yt-nav-card-meta"
        title={current.title}
      >
        <span className="yt-marquee">
          <span className="yt-marquee-inner">{current.title}</span>
        </span>
      </Link>
      <YoutubeTransport compact />
    </div>
  );
}

function DraggablePip() {
  const current = useYoutubePlayerStore((s) => s.current);
  const pipPos = useYoutubePlayerStore((s) => s.pipPos);
  const setPipPos = useYoutubePlayerStore((s) => s.setPipPos);
  const closePip = useYoutubePlayerStore((s) => s.closePip);
  const stop = useYoutubePlayerStore((s) => s.stop);
  const dragging = useRef<{ dx: number; dy: number; moved: boolean } | null>(null);
  const [pos, setPos] = useState(pipPos);

  useEffect(() => setPos(pipPos), [pipPos]);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      if ((e.target as HTMLElement).closest('button,a,input,.yt-pip-float-frame')) return;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      dragging.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y, moved: false };
    },
    [pos.x, pos.y],
  );

  const onPointerMove = useCallback((e: ReactPointerEvent) => {
    if (!dragging.current) return;
    const x = Math.min(window.innerWidth - 80, Math.max(0, e.clientX - dragging.current.dx));
    const y = Math.min(window.innerHeight - 60, Math.max(0, e.clientY - dragging.current.dy));
    if (Math.abs(x - pos.x) > 2 || Math.abs(y - pos.y) > 2) dragging.current.moved = true;
    setPos({ x, y });
  }, [pos.x, pos.y]);

  const onPointerUp = useCallback(
    (e: ReactPointerEvent) => {
      if (!dragging.current) return;
      const { moved } = dragging.current;
      dragging.current = null;
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      if (moved) setPipPos(pos);
    },
    [pos, setPipPos],
  );

  const leavePip = useCallback(() => {
    closePip();
  }, [closePip]);

  const leaveAndStop = useCallback(() => {
    closePip();
    stop();
  }, [closePip, stop]);

  if (!current) return null;

  return (
    <div
      className="yt-pip-float is-draggable"
      role="dialog"
      aria-label="YouTube PiP"
      style={{ left: pos.x, top: pos.y, right: 'auto', bottom: 'auto' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div className="yt-pip-float-head">
        <strong className="yt-marquee" title={current.title}>
          <span className="yt-marquee-inner">{current.title}</span>
        </strong>
        <div className="yt-pip-float-actions">
          <Link
            className="btn btn-sm"
            to={`/youtube?v=${current.id}&t=${encodeURIComponent(current.title)}`}
            onClick={(e) => {
              e.stopPropagation();
              leavePip();
            }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            Abrir
          </Link>
          <button
            type="button"
            className="btn btn-sm"
            title="Voltar ao card do topo"
            onClick={(e) => {
              e.stopPropagation();
              leavePip();
            }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            Card
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={(e) => {
              e.stopPropagation();
              leaveAndStop();
            }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            Fechar
          </button>
        </div>
      </div>
      <YoutubeStage stage="pip" className="yt-pip-float-frame" />
      <div className="yt-pip-float-controls" onPointerDown={(e) => e.stopPropagation()}>
        <YoutubeTransport compact />
      </div>
    </div>
  );
}

/** Host global: um único player YouTube + sync de atividade. */
export function YoutubePlayerHost() {
  const layerRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YtPlayerApi | null>(null);
  const readyRef = useRef(false);
  const progressRef = useRef(0);
  const [mountEpoch, setMountEpoch] = useState(0);
  const loc = useLocation();
  const { immersedInVoiceUi } = useVoiceSession();
  const current = useYoutubePlayerStore((s) => s.current);
  const playing = useYoutubePlayerStore((s) => s.playing);
  const volume = useYoutubePlayerStore((s) => s.volume);
  const muted = useYoutubePlayerStore((s) => s.muted);
  const showOnCard = useYoutubePlayerStore((s) => s.showOnCard);
  const stage = useYoutubePlayerStore((s) => s.stage);
  const setPlaying = useYoutubePlayerStore((s) => s.setPlaying);
  const videoIdRef = useRef<string | null>(null);
  /** Ignora PAUSED logo após ENDED/troca — senão a próxima faixa é pausada na hora. */
  const ignorePauseUntilRef = useRef(0);
  const lastEndedAtRef = useRef(0);

  // Shell do player antes da API — garante sync de frame no 1º paint
  useLayoutEffect(() => {
    const layer = layerRef.current;
    if (!layer || wrapRef.current) return;
    const wrap = document.createElement('div');
    wrap.className = 'yt-player-mount is-dock';
    wrap.hidden = true;
    wrapRef.current = wrap;
    layer.appendChild(wrap);
    setMountEpoch((n) => n + 1);
    return () => {
      wrap.remove();
      wrapRef.current = null;
    };
  }, []);

  useSyncPlayerFrame(wrapRef, layerRef, playerRef, readyRef, mountEpoch);

  const advanceFromEnded = useCallback(() => {
    const now = Date.now();
    // evita double-fire ENDED + poll
    if (now - lastEndedAtRef.current < 800) return;
    lastEndedAtRef.current = now;
    ignorePauseUntilRef.current = now + 1500;

    const st = useYoutubePlayerStore.getState();
    if (st.queueIndex < st.queue.length - 1) {
      st.next();
    } else {
      setPlaying(false);
    }
  }, [setPlaying]);

  // API YouTube no shell já criado
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || playerRef.current) return;

    let cancelled = false;
    void loadYtApi().then((YT) => {
      if (cancelled || !wrapRef.current) return;
      const mount = document.createElement('div');
      mount.id = 'sf-yt-player';
      wrapRef.current.appendChild(mount);
      playerRef.current = new YT.Player(mount, {
        width: '100%',
        height: '100%',
        playerVars: {
          autoplay: 0,
          rel: 0,
          modestbranding: 1,
          playsinline: 1,
          origin: window.location.origin,
          enablejsapi: 1,
        },
        events: {
          onReady: () => {
            readyRef.current = true;
            const st = useYoutubePlayerStore.getState();
            playerRef.current?.setVolume(st.volume);
            if (st.muted) playerRef.current?.mute();
            if (st.current) {
              videoIdRef.current = st.current.id;
              ignorePauseUntilRef.current = Date.now() + 1500;
              playerRef.current?.loadVideoById(st.current.id);
              if (st.playing) {
                window.setTimeout(() => playerRef.current?.playVideo(), 120);
              }
            }
          },
          onStateChange: (ev: { data: number }) => {
            // ENDED=0 PLAYING=1 PAUSED=2 — fallback numérico se PlayerState falhar
            const ended = window.YT?.PlayerState?.ENDED ?? 0;
            const playingSt = window.YT?.PlayerState?.PLAYING ?? 1;
            const pausedSt = window.YT?.PlayerState?.PAUSED ?? 2;

            if (ev.data === ended) {
              advanceFromEnded();
              return;
            }
            if (ev.data === playingSt) {
              setPlaying(true);
              return;
            }
            if (ev.data === pausedSt) {
              if (Date.now() < ignorePauseUntilRef.current) return;
              setPlaying(false);
            }
          },
        },
      });
    });

    return () => {
      cancelled = true;
      try {
        playerRef.current?.destroy();
      } catch {
        /* ignore */
      }
      playerRef.current = null;
      readyRef.current = false;
    };
  }, [advanceFromEnded, setPlaying, mountEpoch]);

  // Poll de segurança: ENDED às vezes não dispara com player oculto / nocookie
  useEffect(() => {
    if (!current || !playing) return;
    const id = window.setInterval(() => {
      const p = playerRef.current;
      if (!p || !readyRef.current) return;
      try {
        const state = p.getPlayerState();
        const ended = window.YT?.PlayerState?.ENDED ?? 0;
        const dur = p.getDuration();
        const t = p.getCurrentTime();
        if (t > 0.2) progressRef.current = t;
        if (state === ended) {
          advanceFromEnded();
          return;
        }
        // perto do fim + parado/cued
        if (dur > 0 && t > 0 && dur - t < 0.35 && (state === 0 || state === 2 || state === 5)) {
          advanceFromEnded();
        }
      } catch {
        /* ignore */
      }
    }, 800);
    return () => window.clearInterval(id);
  }, [current, playing, advanceFromEnded]);

  // Mantém progresso mesmo pausado (para PiP ↔ card)
  useEffect(() => {
    if (!current) {
      progressRef.current = 0;
      return;
    }
    const id = window.setInterval(() => {
      const p = playerRef.current;
      if (!p || !readyRef.current) return;
      try {
        const t = Number(p.getCurrentTime()) || 0;
        if (t > 0.2) progressRef.current = t;
      } catch {
        /* ignore */
      }
    }, 400);
    return () => window.clearInterval(id);
  }, [current]);

  // Troca de vídeo / play-pause / volume
  useEffect(() => {
    const p = playerRef.current;
    if (!p || !readyRef.current) return;
    if (!current) {
      try {
        p.pauseVideo();
      } catch {
        /* ignore */
      }
      videoIdRef.current = null;
      progressRef.current = 0;
      return;
    }
    if (videoIdRef.current !== current.id) {
      videoIdRef.current = current.id;
      progressRef.current = 0;
      ignorePauseUntilRef.current = Date.now() + 1500;
      try {
        p.loadVideoById({ videoId: current.id, startSeconds: 0 });
        if (playing) {
          window.setTimeout(() => {
            try {
              p.playVideo();
            } catch {
              /* ignore */
            }
          }, 150);
        }
      } catch {
        /* ignore */
      }
    } else if (playing) {
      try {
        p.playVideo();
      } catch {
        /* ignore */
      }
    } else if (Date.now() >= ignorePauseUntilRef.current) {
      try {
        p.pauseVideo();
      } catch {
        /* ignore */
      }
    }
  }, [current, playing]);

  useEffect(() => {
    const p = playerRef.current;
    if (!p || !readyRef.current) return;
    p.setVolume(volume);
    if (muted) p.mute();
    else p.unMute();
  }, [volume, muted]);

  // Activity “ouvindo”
  useEffect(() => {
    if (!current || !showOnCard) {
      void api('/api/community/me/activity', {
        method: 'POST',
        body: JSON.stringify({ activity: null }),
      }).catch(() => undefined);
      return;
    }
    void api('/api/community/me/activity', {
      method: 'POST',
      body: JSON.stringify({
        activity: {
          type: 'listening',
          title: current.title || `YouTube ${current.id}`,
          url: `https://www.youtube.com/watch?v=${current.id}`,
          videoId: current.id,
          startedAt: Date.now(),
        },
      }),
    }).catch(() => undefined);
  }, [current, showOnCard]);

  // Desktop sem top nav: mini bar fixa (fora da página YouTube e fora do canal de voz)
  const isDesktop = typeof window !== 'undefined' && !!window.sfDesktop;
  const onYoutubePage = loc.pathname.startsWith('/youtube');
  const showDesktopDock =
    isDesktop && !!current && stage === 'nav' && !onYoutubePage && !immersedInVoiceUi;

  return (
    <>
      <div ref={layerRef} className="yt-player-layer" aria-hidden />
      {/* Dock invisível: mantém áudio ao sair da página sem PiP (sem vídeo no cabeçalho) */}
      <YoutubeStage stage="nav" className="yt-audio-dock" />
      {stage === 'pip' && current ? <DraggablePip /> : null}
      {showDesktopDock ? (
        <div className="yt-desktop-dock">
          <YoutubeNavPlayer />
        </div>
      ) : null}
    </>
  );
}

export type { YtTrack };
