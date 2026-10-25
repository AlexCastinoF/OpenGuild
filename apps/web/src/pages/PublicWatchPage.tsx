import { useEffect, useRef, useState } from 'react';
import { Room, RoomEvent, Track } from 'livekit-client';
import { useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useBrandStore } from '../store/brand';

type WatchInfo = {
  title: string;
  streamer_name: string;
  streamer_avatar: string;
  streamer_identity: string;
  livekit_ready: boolean;
  custom_names_allowed: boolean;
  max_viewers: number;
};

export function PublicWatchPage() {
  const { slug = '' } = useParams();
  const brandName = useBrandStore((s) => s.name);
  const videoRef = useRef<HTMLVideoElement>(null);
  const roomRef = useRef<Room | null>(null);
  const [status, setStatus] = useState('Carregando…');
  const [info, setInfo] = useState<WatchInfo | null>(null);
  const [error, setError] = useState('');
  const [guestName, setGuestName] = useState('');
  const [needName, setNeedName] = useState(false);
  const [started, setStarted] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await api<WatchInfo & { ok: boolean }>(
          `/api/public/watch/${encodeURIComponent(slug)}`,
        );
        if (cancelled) return;
        setInfo(data);
        setNeedName(!!data.custom_names_allowed);
        setStatus('Pronto para assistir');
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Falha ao carregar');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  useEffect(() => {
    return () => {
      void roomRef.current?.disconnect();
      roomRef.current = null;
    };
  }, []);

  async function connect(name: string) {
    setError('');
    setStatus('Conectando…');
    setStarted(true);
    setNeedName(false);
    try {
      const tok = await api<{
        token: string;
        url: string;
        streamer_identity: string;
      }>(`/api/public/watch/${encodeURIComponent(slug)}/token`, {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      const room = new Room();
      roomRef.current = room;
      const attachScreen = () => {
        const video = videoRef.current;
        if (!video) return;
        for (const p of room.remoteParticipants.values()) {
          for (const pub of p.trackPublications.values()) {
            if (pub.source === Track.Source.ScreenShare && pub.track) {
              pub.track.attach(video);
              void video.play?.().catch(() => undefined);
              setStatus('Ao vivo');
              return;
            }
          }
        }
        setStatus('Aguardando compartilhamento de tela…');
      };
      room.on(RoomEvent.TrackSubscribed, () => attachScreen());
      room.on(RoomEvent.TrackUnsubscribed, () => {
        setStatus('Transmissão pausada');
      });
      room.on(RoomEvent.Disconnected, () => setStatus('Desconectado'));
      await room.connect(tok.url, tok.token);
      attachScreen();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao conectar');
      setStatus('Erro');
      setStarted(false);
    }
  }

  return (
    <div className="watch-public" style={{ minHeight: '100vh', padding: '1.5rem', background: '#0b0e14', color: '#e8eaed' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <a href="/" style={{ color: '#c4b5fd', fontWeight: 700, textDecoration: 'none' }}>
          {brandName}
        </a>
        {started && status === 'Ao vivo' ? (
          <span style={{ fontSize: 12, fontWeight: 700, color: '#f87171' }}>AO VIVO</span>
        ) : null}
      </header>
      <div style={{ maxWidth: 960, margin: '0 auto' }}>
        <div style={{ position: 'relative', background: '#111827', borderRadius: 12, overflow: 'hidden', aspectRatio: '16/9' }}>
          <video
            ref={videoRef}
            playsInline
            autoPlay
            controls
            style={{ width: '100%', height: '100%', objectFit: 'contain', background: '#000' }}
          />
          {status !== 'Ao vivo' ? (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                display: 'grid',
                placeItems: 'center',
                background: 'rgba(0,0,0,.55)',
                padding: 24,
                textAlign: 'center',
              }}
            >
              <p>{error || status}</p>
            </div>
          ) : null}
        </div>
        <div style={{ marginTop: 16 }}>
          <h1 style={{ margin: 0, fontSize: '1.25rem' }}>{info?.title || 'Transmissão'}</h1>
          <p style={{ margin: '6px 0 0', opacity: 0.75 }}>{info?.streamer_name || ''}</p>
        </div>
        {needName && !started ? (
          <form
            style={{ marginTop: 20, display: 'flex', gap: 8, flexWrap: 'wrap' }}
            onSubmit={(e) => {
              e.preventDefault();
              void connect(guestName);
            }}
          >
            <input
              value={guestName}
              onChange={(e) => setGuestName(e.target.value)}
              placeholder="Seu nome (opcional)"
              maxLength={40}
              style={{
                flex: '1 1 200px',
                padding: '10px 12px',
                borderRadius: 8,
                border: '1px solid #334155',
                background: '#0f172a',
                color: '#fff',
              }}
            />
            <button type="submit" className="btn btn-primary">
              Assistir
            </button>
          </form>
        ) : null}
        {!needName && !started && info ? (
          <button
            type="button"
            className="btn btn-primary"
            style={{ marginTop: 16 }}
            onClick={() => void connect('')}
          >
            Assistir
          </button>
        ) : null}
        {error && started ? <p style={{ color: '#f87171', marginTop: 12 }}>{error}</p> : null}
      </div>
    </div>
  );
}
