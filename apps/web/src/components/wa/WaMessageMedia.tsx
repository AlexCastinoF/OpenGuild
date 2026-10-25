import { useCallback, useEffect, useState } from 'react';
import { Maximize2 } from 'lucide-react';
import { getWaMediaBlob, isWaMediaCached } from './waMediaCache';
import { WaAudioPlayer } from './WaAudioPlayer';
import type { WaMessage } from './waTypes';

function mediaKind(m: WaMessage): string {
  const t = String(m.type || m.mediaType || '').toLowerCase();
  if (t.includes('image') || t === 'sticker') return t === 'sticker' ? 'sticker' : 'image';
  if (t.includes('video')) return 'video';
  if (t.includes('audio') || t === 'ptt' || t === 'voice') return 'audio';
  if (t.includes('document') || t === 'file') return 'document';
  if (m.hasMedia) return 'document';
  return '';
}

function mediaLabel(type: string) {
  if (type === 'image') return 'Imagem';
  if (type === 'video') return 'Vídeo';
  if (type === 'audio') return 'Áudio';
  if (type === 'sticker') return 'Figurinha';
  return 'Documento';
}

export function mediaUrlFor(slot: number, m: WaMessage, chatJid: string) {
  return `/api/community/wa/${slot}/media?messageId=${encodeURIComponent(m.id)}&chatJid=${encodeURIComponent(chatJid)}`;
}

export function messageHasMedia(m: WaMessage) {
  return Boolean(
    m.hasMedia ||
      ['image', 'video', 'audio', 'document', 'sticker', 'ptt', 'voice'].includes(
        String(m.type || m.mediaType || '').toLowerCase(),
      ) ||
      String(m.mediaType || '')
        .toLowerCase()
        .match(/image|video|audio|document|sticker/),
  );
}

/**
 * Mídia on-demand: não baixa até o clique (ou se já estiver no Cache API do browser).
 * O servidor/gateway não persiste a mídia em disco — só o cache local do usuário.
 */
export function WaMessageMedia({
  slot,
  chatJid,
  msg,
}: {
  slot: number;
  chatJid: string;
  msg: WaMessage;
}) {
  const type = mediaKind(msg);
  const url = mediaUrlFor(slot, msg, chatJid);
  const [phase, setPhase] = useState<'card' | 'loading' | 'ready' | 'error'>('card');
  const [blobUrl, setBlobUrl] = useState('');
  const [lightbox, setLightbox] = useState(false);

  const hydrate = useCallback(async () => {
    setPhase('loading');
    try {
      const blob = await getWaMediaBlob(url);
      setBlobUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return URL.createObjectURL(blob);
      });
      setPhase('ready');
    } catch {
      setPhase('error');
    }
  }, [url]);

  // Se já estiver no cache do browser, exibe sem pedir clique de novo
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!type) return;
      const hit = await isWaMediaCached(url);
      if (cancelled || !hit) return;
      try {
        const blob = await getWaMediaBlob(url);
        if (cancelled) return;
        setBlobUrl(URL.createObjectURL(blob));
        setPhase('ready');
      } catch {
        /* keep card */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [type, url]);

  useEffect(() => {
    return () => {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [blobUrl]);

  if (!type) return null;

  if (phase === 'ready' && blobUrl) {
    if (type === 'image' || type === 'sticker') {
      return (
        <>
          <img
            className={`comm-wa-media${type === 'sticker' ? ' comm-wa-sticker' : ' is-zoomable'}`}
            src={blobUrl}
            alt={type === 'sticker' ? 'sticker' : ''}
            title={type === 'image' ? 'Clique para ampliar' : undefined}
            onClick={() => type === 'image' && setLightbox(true)}
          />
          {lightbox ? (
            <div className="comm-wa-lightbox" role="dialog" onClick={() => setLightbox(false)}>
              <img src={blobUrl} alt="" />
            </div>
          ) : null}
        </>
      );
    }
    if (type === 'video') {
      return (
        <div className="comm-wa-media-shell">
          <video
            className="comm-wa-media is-zoomable"
            src={blobUrl}
            controls
            playsInline
            preload="metadata"
            onDoubleClick={(e) => {
              const v = e.currentTarget;
              if (document.pictureInPictureElement === v) {
                void document.exitPictureInPicture().catch(() => undefined);
              } else if (v.requestPictureInPicture) {
                void v.requestPictureInPicture().catch(() => undefined);
              }
            }}
          />
          <button
            type="button"
            className="comm-wa-media-expand"
            title="Picture-in-Picture"
            onClick={() => {
              const v = document.querySelector(
                `.comm-msg[data-wa-id="${msg.id}"] video`,
              ) as HTMLVideoElement | null;
              if (!v?.requestPictureInPicture) return;
              void v.requestPictureInPicture().catch(() => undefined);
            }}
          >
            <Maximize2 size={14} />
          </button>
        </div>
      );
    }
    if (type === 'audio') {
      return <WaAudioPlayer src={blobUrl} fileName={msg.fileName || 'audio.ogg'} />;
    }
    return (
      <a
        className="comm-wa-doc"
        href={blobUrl}
        download={msg.fileName || 'documento'}
        target="_blank"
        rel="noreferrer"
      >
        {msg.fileName || 'Documento'}
      </a>
    );
  }

  const ico =
    type === 'image' ? '▣' : type === 'video' ? '▶' : type === 'audio' ? '♪' : type === 'sticker' ? '✿' : '📄';
  const hint =
    phase === 'loading'
      ? 'Baixando do WhatsApp…'
      : phase === 'error'
        ? 'Falha — toque para tentar de novo'
        : type === 'audio'
          ? 'Toque para baixar e ouvir'
          : type === 'video'
            ? 'Toque para baixar e reproduzir'
            : 'Toque para carregar';

  return (
    <button
      type="button"
      className={`comm-wa-media-card${phase === 'loading' ? ' is-loading' : ''}${
        type === 'audio' ? ' is-audio' : ''
      }`}
      onClick={() => void hydrate()}
    >
      <span className="comm-wa-media-ico" aria-hidden>
        {ico}
      </span>
      <span className="comm-wa-media-card-text">
        <strong>{msg.fileName || mediaLabel(type)}</strong>
        <em>{hint}</em>
      </span>
    </button>
  );
}
