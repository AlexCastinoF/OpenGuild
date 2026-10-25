import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  ChevronDown,
  Maximize,
  Minimize2,
  MonitorUp,
  Mic,
  MicOff,
  Monitor,
  PhoneOff,
  Volume1,
  Link2,
} from 'lucide-react';
import {
  formatStreamStatsLine,
  type AudioSignalLevels,
  type StageParticipant,
  type StreamStatsLine,
} from '../hooks/useLiveKitRoom';
import { AudioSignalMeter } from './AudioSignalMeter';
import { YoutubeNavPlayer } from './youtube/YoutubePlayerHost';

const DEFAULT_AVATAR = '/icon.svg';

type Props = {
  channelName: string;
  kind: string;
  livekitReady: boolean;
  status: string;
  participants: StageParticipant[];
  connected: boolean;
  sharing: boolean;
  micOn: boolean;
  deafened?: boolean;
  focusIdentity: string | null;
  volumes: Record<string, { mic: number; screen: number }>;
  audioSignals?: AudioSignalLevels;
  streamStats?: Record<string, StreamStatsLine>;
  publicWatchUrl?: string;
  onFocus: (id: string | null) => void;
  onShare: () => void;
  onToggleMic: () => void;
  onLeave: () => void;
  onVolume: (identity: string, kind: 'mic' | 'screen', value: number) => void;
  onCopyPublicWatch?: () => void;
};

export function VoiceStage({
  channelName,
  kind,
  livekitReady,
  status,
  participants,
  connected,
  sharing,
  micOn,
  deafened = false,
  focusIdentity,
  volumes,
  audioSignals = {},
  streamStats = {},
  publicWatchUrl,
  onFocus,
  onShare,
  onToggleMic,
  onLeave,
  onVolume,
  onCopyPublicWatch,
}: Props) {
  const [tileBase, setTileBase] = useState(240);
  const [linkOpen, setLinkOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [isFs, setIsFs] = useState(false);
  const focusRef = useRef<HTMLVideoElement>(null);
  const focusRootRef = useRef<HTMLDivElement>(null);
  const linkDropRef = useRef<HTMLDivElement>(null);
  const detailsDropRef = useRef<HTMLDivElement>(null);
  const focus = useMemo(
    () => participants.find((p) => p.id === focusIdentity && p.hasScreen) || null,
    [participants, focusIdentity],
  );
  const focusId = focus?.id ?? null;
  const focusTrack = focus?.screenTrack;

  useEffect(() => {
    const el = focusRef.current;
    if (!el || !focusTrack) {
      if (el) el.srcObject = null;
      return;
    }
    focusTrack.attach(el);
    el.muted = true;
    el.playsInline = true;
    void el.play?.().catch(() => undefined);
    return () => {
      focusTrack.detach(el);
    };
    // Depende só da track/id — ActiveSpeakers não pode reattach (pisca em tela cheia)
  }, [focusId, focusTrack]);

  useEffect(() => {
    const onFs = () => setIsFs(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  useEffect(() => {
    if (!linkOpen && !detailsOpen) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (linkOpen && linkDropRef.current && !linkDropRef.current.contains(t)) {
        setLinkOpen(false);
      }
      if (detailsOpen && detailsDropRef.current && !detailsDropRef.current.contains(t)) {
        setDetailsOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [linkOpen, detailsOpen]);

  useEffect(() => {
    if (publicWatchUrl) setLinkOpen(true);
    else setLinkOpen(false);
  }, [publicWatchUrl]);

  function preset(size: 'sm' | 'md' | 'lg') {
    setTileBase(size === 'sm' ? 160 : size === 'lg' ? 340 : 240);
  }

  async function toggleFullscreen() {
    const root = focusRootRef.current;
    if (!root) return;
    if (document.fullscreenElement) await document.exitFullscreen();
    else await root.requestFullscreen();
  }

  async function copyLink() {
    if (!publicWatchUrl) return;
    try {
      await navigator.clipboard.writeText(publicWatchUrl);
      setCopied(true);
      onCopyPublicWatch?.();
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* ignore */
    }
  }

  const focusMic = focus ? Math.round((volumes[focus.id]?.mic ?? 1) * 100) : 100;
  const focusScreen = focus ? Math.round((volumes[focus.id]?.screen ?? 0) * 100) : 0;
  const localSelf = useMemo(() => participants.find((p) => p.isLocal) || null, [participants]);
  const localSig = localSelf ? audioSignals[localSelf.id] : undefined;
  const focusSig = focus ? audioSignals[focus.id] : undefined;

  return (
    <div className="comm-voice">
      <header className="comm-main-head">
        <span className="comm-main-head-title">
          {kind === 'screen' ? 'Tela' : 'Voz'} · {channelName}
        </span>
        {typeof window !== 'undefined' && window.sfDesktop ? (
          <div className="comm-voice-yt-slot" aria-label="YouTube">
            <YoutubeNavPlayer />
          </div>
        ) : null}
        {publicWatchUrl ? (
          <div
            ref={linkDropRef}
            className={`comm-public-watch-drop is-in-head${linkOpen ? ' is-open' : ''}`}
          >
            <button
              type="button"
              className="comm-public-watch-drop-btn"
              aria-expanded={linkOpen}
              onClick={() => setLinkOpen((v) => !v)}
            >
              <Link2 size={15} aria-hidden />
              <span>Links</span>
              <span className="comm-public-watch-drop-badge">1</span>
              <ChevronDown size={14} className="comm-public-watch-drop-chevron" aria-hidden />
            </button>
            {linkOpen ? (
              <div className="comm-public-watch-drop-panel" role="dialog" aria-label="Link público">
                <div className="comm-public-watch-mine-bar">
                  <span className="comm-public-watch-label">Sua transmissão</span>
                  <div className="comm-public-watch-mine-row">
                    <input
                      type="text"
                      readOnly
                      value={publicWatchUrl}
                      aria-label="Link público da transmissão"
                      onFocus={(e) => e.currentTarget.select()}
                    />
                    <button type="button" className="btn btn-sm" onClick={() => void copyLink()}>
                      {copied ? 'Copiado' : 'Copiar'}
                    </button>
                  </div>
                  <span className="muted comm-public-watch-meta">
                    Qualquer pessoa com o link pode assistir sem login.
                  </span>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
        <div className="comm-voice-status-wrap">
          <em className="comm-voice-status">
            {status}
            {!livekitReady ? ' · LiveKit não configurado' : ''}
          </em>
          {localSelf && connected ? (
            <div
              ref={detailsDropRef}
              className={`comm-voice-details${detailsOpen ? ' is-open' : ''}`}
            >
              <button
                type="button"
                className="comm-voice-details-btn"
                aria-expanded={detailsOpen}
                aria-haspopup="dialog"
                onClick={() => setDetailsOpen((v) => !v)}
              >
                <span>Detalhes</span>
                <ChevronDown size={14} className="comm-voice-details-chevron" aria-hidden />
              </button>
              {detailsOpen ? (
                <div
                  className="comm-voice-details-panel"
                  role="dialog"
                  aria-label="Sinal de áudio enviado"
                >
                  <span className="comm-audio-meters-caption">Enviando</span>
                  <div className="comm-audio-meters" aria-label="Sinal que você está enviando">
                    <AudioSignalMeter
                      label="Voz"
                      level={localSig?.mic ?? 0}
                      hasTrack={!!localSig?.hasMicTrack}
                      direction="out"
                      title="Microfone: sinal enviado em tempo real"
                    />
                    <AudioSignalMeter
                      label="Tela"
                      level={localSig?.screen ?? 0}
                      hasTrack={!!localSig?.hasScreenTrack}
                      direction="out"
                      title="Áudio da tela/app: sinal enviado em tempo real"
                    />
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </header>
      <div className="comm-voice-body">
        <div className="comm-stage">
          {focus ? (
            <div className="comm-stage-focus" ref={focusRootRef}>
              <div className="comm-focus-bar">
                <span>Transmissão · {focus.name}</span>
                <div className="comm-focus-tools">
                  {focusSig && !focus.isLocal ? (
                    <div className="comm-audio-meters comm-audio-meters--focus" aria-label="Sinal recebido">
                      <AudioSignalMeter
                        label="Voz"
                        level={focusSig.mic}
                        hasTrack={focusSig.hasMicTrack}
                        direction="in"
                        title="Sinal de voz chegando (mesmo sem ouvir)"
                      />
                      <AudioSignalMeter
                        label="Tela"
                        level={focusSig.screen}
                        hasTrack={focusSig.hasScreenTrack}
                        direction="in"
                        title="Sinal de áudio da tela chegando (mesmo sem ouvir)"
                      />
                    </div>
                  ) : null}
                  {!focus.isLocal ? (
                    <>
                      <label className="comm-vol-inline" title="Volume da tela">
                        <Monitor size={14} />
                        <input
                          type="range"
                          min={0}
                          max={100}
                          value={focusScreen}
                          onChange={(e) =>
                            onVolume(focus.id, 'screen', Number(e.target.value) / 100)
                          }
                          aria-label="Volume da tela"
                        />
                      </label>
                      <label className="comm-vol-inline" title="Volume da voz">
                        <Mic size={14} />
                        <input
                          type="range"
                          min={0}
                          max={100}
                          value={focusMic}
                          onChange={(e) =>
                            onVolume(focus.id, 'mic', Number(e.target.value) / 100)
                          }
                          aria-label="Volume da voz"
                        />
                      </label>
                    </>
                  ) : null}
                  <button
                    type="button"
                    className="comm-icon-btn"
                    title={isFs ? 'Sair da tela cheia' : 'Tela cheia'}
                    onClick={() => void toggleFullscreen()}
                  >
                    {isFs ? <Minimize2 size={16} /> : <Maximize size={16} />}
                  </button>
                  <button
                    type="button"
                    className="comm-icon-btn"
                    title="Minimizar"
                    onClick={() => {
                      if (document.fullscreenElement) void document.exitFullscreen();
                      onFocus(null);
                    }}
                  >
                    <Minimize2 size={16} />
                  </button>
                </div>
              </div>
              <div className="comm-focus-frame">
                <video
                  className="comm-focus-video"
                  ref={focusRef}
                  data-stream-video={focus.id}
                  autoPlay
                  playsInline
                  muted
                />
                {formatStreamStatsLine(streamStats[focus.id]) ? (
                  <span className="comm-stage-stats" data-stream-stats-for={focus.id}>
                    {formatStreamStatsLine(streamStats[focus.id])}
                  </span>
                ) : null}
                {!focus.isLocal ? (
                  <div className="comm-focus-fs-vols" aria-label="Volumes da transmissão">
                    <label className="comm-vol-inline" title="Volume da tela">
                      <Monitor size={14} />
                      <span>Tela</span>
                      <input
                        type="range"
                        min={0}
                        max={100}
                        value={focusScreen}
                        onChange={(e) =>
                          onVolume(focus.id, 'screen', Number(e.target.value) / 100)
                        }
                        aria-label="Volume da tela"
                      />
                      <em>{focusScreen}</em>
                    </label>
                    <label className="comm-vol-inline" title="Volume da voz">
                      <Mic size={14} />
                      <span>Voz</span>
                      <input
                        type="range"
                        min={0}
                        max={100}
                        value={focusMic}
                        onChange={(e) =>
                          onVolume(focus.id, 'mic', Number(e.target.value) / 100)
                        }
                        aria-label="Volume da voz"
                      />
                      <em>{focusMic}</em>
                    </label>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          <div className="comm-stage-toolbar" hidden={!!focus}>
            <span className="comm-stage-toolbar-label">Palco</span>
            <label className="comm-tile-size-label">
              Base
              <input
                type="range"
                min={160}
                max={400}
                value={tileBase}
                onChange={(e) => setTileBase(Number(e.target.value))}
              />
            </label>
            <div className="comm-size-group">
              <button
                type="button"
                className={`comm-size-btn${tileBase <= 180 ? ' is-on' : ''}`}
                onClick={() => preset('sm')}
              >
                S
              </button>
              <button
                type="button"
                className={`comm-size-btn${tileBase > 180 && tileBase < 300 ? ' is-on' : ''}`}
                onClick={() => preset('md')}
              >
                M
              </button>
              <button
                type="button"
                className={`comm-size-btn${tileBase >= 300 ? ' is-on' : ''}`}
                onClick={() => preset('lg')}
              >
                L
              </button>
            </div>
          </div>

          <div
            className="comm-stage-grid"
            hidden={!!focus}
            style={
              {
                ['--tile-base' as string]: `${tileBase}px`,
                gridTemplateColumns: `repeat(auto-fill, minmax(${tileBase}px, 1fr))`,
              } as CSSProperties
            }
          >
            {participants.map((p) => (
              <StageTile
                key={p.id}
                p={p}
                watching={focusIdentity === p.id}
                micVol={volumes[p.id]?.mic ?? 1}
                screenVol={volumes[p.id]?.screen ?? 0}
                statsLine={formatStreamStatsLine(streamStats[p.id])}
                onFocus={() => p.hasScreen && onFocus(p.id)}
                onVolume={onVolume}
              />
            ))}
            {!connected && !participants.length ? (
              <div className="comm-stage-empty">
                Ninguém na sala ainda. Você entra ao abrir o canal.
              </div>
            ) : null}
            {connected && !participants.length ? (
              <div className="comm-stage-empty">Só você na sala — aguardando outros.</div>
            ) : null}
          </div>
        </div>
      </div>
      <div className="comm-voice-actions">
        <button type="button" className="btn" onClick={onShare}>
          <MonitorUp size={16} /> {sharing ? 'Parar tela' : 'Compartilhar tela'}
        </button>
        <button
          type="button"
          className={`btn${!micOn || deafened ? ' is-off' : ''}`}
          onClick={onToggleMic}
        >
          {micOn && !deafened ? <Mic size={16} /> : <MicOff size={16} />}{' '}
          {micOn && !deafened ? 'Mute' : 'Unmute'}
        </button>
        <button type="button" className="btn" onClick={onLeave}>
          <PhoneOff size={16} /> Sair
        </button>
      </div>
    </div>
  );
}

function StageTile({
  p,
  watching,
  micVol,
  screenVol,
  statsLine,
  onFocus,
  onVolume,
}: {
  p: StageParticipant;
  watching: boolean;
  micVol: number;
  screenVol: number;
  statsLine: string;
  onFocus: () => void;
  onVolume: (identity: string, kind: 'mic' | 'screen', value: number) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = videoRef.current;
    if (!el || !p.screenTrack) return;
    p.screenTrack.attach(el);
    el.muted = true;
    el.playsInline = true;
    void el.play?.().catch(() => undefined);
    return () => {
      p.screenTrack?.detach(el);
    };
  }, [p.screenTrack]);

  const micPct = Math.round(micVol * 100);
  const screenPct = Math.round(screenVol * 100);
  const micIcon =
    p.muted || micPct <= 0 ? <MicOff size={14} /> : micPct < 40 ? <Volume1 size={14} /> : <Mic size={14} />;

  return (
    <article
      className={`comm-stage-tile${p.speaking && !watching ? ' is-speaking' : ''}${p.muted ? ' is-muted' : ''}${p.hasScreen ? ' has-stream' : ''}${p.isLocal ? ' is-local' : ''}${watching ? ' is-watching' : ''}`}
      data-tile-id={p.id}
    >
      {p.hasScreen ? (
        <div className={`comm-stage-hero comm-stage-hero--stream${watching ? ' is-watching' : ''}`}>
          <video ref={videoRef} data-stream-video={p.id} autoPlay playsInline muted />
          {statsLine ? (
            <span className="comm-stage-stats" data-stream-stats-for={p.id}>
              {statsLine}
            </span>
          ) : null}
        </div>
      ) : (
        <div className="comm-stage-hero comm-stage-hero--voice">
          <div className="comm-stage-hero-avatar">
            <img
              className="comm-avatar"
              src={(p.avatarUrl || '').trim() || DEFAULT_AVATAR}
              alt=""
              onError={(e) => {
                (e.target as HTMLImageElement).src = DEFAULT_AVATAR;
              }}
            />
            <span className="comm-stage-hero-init" aria-hidden>
              {(p.name || '?').slice(0, 1).toUpperCase()}
            </span>
          </div>
        </div>
      )}
      {p.hasScreen ? (
        <button type="button" className="comm-stage-watch btn btn-sm btn-primary" onClick={onFocus}>
          {watching ? 'Assistindo' : 'Assistir'}
        </button>
      ) : null}
      <div className="comm-stage-meta">
        <span className="comm-stage-name">
          {p.name}
          {p.isLocal ? <em className="comm-stage-you"> (você)</em> : null}
        </span>
        <span
          className="comm-stage-mic-state"
          title={p.muted ? 'Microfone desligado' : 'Microfone ligado'}
        >
          {micIcon}
        </span>
      </div>
      <div className="comm-stage-vols">
        <label className="comm-stage-vol" title="Volume da voz">
          <Mic size={12} />
          <span className="comm-stage-vol-label">Voz</span>
          <input
            type="range"
            min={0}
            max={100}
            value={micPct}
            onChange={(e) => onVolume(p.id, 'mic', Number(e.target.value) / 100)}
            aria-label="Volume da voz"
          />
          <span className="comm-stage-vol-val">{micPct}</span>
        </label>
        {p.hasScreen ? (
          <label className="comm-stage-vol" title="Volume da tela / aplicativo">
            <Monitor size={12} />
            <span className="comm-stage-vol-label">Tela</span>
            <input
              type="range"
              min={0}
              max={100}
              value={screenPct}
              disabled={p.isLocal}
              onChange={(e) => onVolume(p.id, 'screen', Number(e.target.value) / 100)}
              aria-label="Volume da tela"
            />
            <span className="comm-stage-vol-val">{screenPct}</span>
          </label>
        ) : null}
      </div>
    </article>
  );
}
