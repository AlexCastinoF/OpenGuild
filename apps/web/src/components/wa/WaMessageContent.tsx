import { useRef, useState } from 'react';
import { Maximize2 } from 'lucide-react';
import type { WaMessage } from './waTypes';

function parseVcardName(vcard: string) {
  const fn = /FN:([^\n\r]+)/i.exec(vcard || '');
  return fn?.[1]?.trim() || '';
}

function parseVcardTel(vcard: string) {
  const tel = /TEL[^:]*:([^\n\r]+)/i.exec(vcard || '');
  return tel?.[1]?.trim() || '';
}

function firstUrl(text: string, fallback = '') {
  return (
    fallback ||
    text.match(/https?:\/\/[^\s<>"']+/i)?.[0] ||
    ''
  );
}

/** Extrai id de vídeo YouTube (watch, youtu.be, shorts, embed). */
export function youtubeVideoId(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    if (host === 'youtu.be') {
      const id = u.pathname.split('/').filter(Boolean)[0];
      return id || null;
    }
    if (host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
      if (u.pathname.startsWith('/embed/')) return u.pathname.split('/')[2] || null;
      if (u.pathname.startsWith('/shorts/')) return u.pathname.split('/')[2] || null;
      const v = u.searchParams.get('v');
      if (v) return v;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function vimeoId(url: string): string | null {
  try {
    const u = new URL(url);
    if (!u.hostname.replace(/^www\./, '').endsWith('vimeo.com')) return null;
    const parts = u.pathname.split('/').filter(Boolean);
    const id = parts.find((p) => /^\d+$/.test(p));
    return id || null;
  } catch {
    return null;
  }
}

function MediaEmbed({
  kind,
  src,
  title,
}: {
  kind: 'youtube' | 'vimeo';
  src: string;
  title?: string;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [pipHint, setPipHint] = useState('');

  async function openPip() {
    const iframe = iframeRef.current;
    if (!iframe) return;
    // Electron: Document PiP costuma fechar mal e deixar a UI presa
    const isDesktop = !!(window as Window & { sfDesktop?: unknown }).sfDesktop;
    if (!isDesktop) {
      try {
        const docPip = (window as unknown as {
          documentPictureInPicture?: {
            requestWindow: (opts?: { width?: number; height?: number }) => Promise<Window>;
          };
        }).documentPictureInPicture;
        if (docPip?.requestWindow) {
          const win = await docPip.requestWindow({ width: 480, height: 270 });
          const clone = document.createElement('iframe');
          clone.src = src;
          clone.allow =
            'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen';
          clone.allowFullscreen = true;
          clone.style.cssText = 'width:100%;height:100%;border:0;background:#000';
          win.document.body.style.margin = '0';
          win.document.body.style.background = '#000';
          win.document.body.appendChild(clone);
          setPipHint('');
          return;
        }
      } catch {
        /* fall through */
      }
    }
    try {
      await iframe.requestFullscreen?.();
      setPipHint('');
    } catch {
      setPipHint(
        isDesktop
          ? 'No app Desktop use o player YouTube com PiP flutuante.'
          : 'PiP indisponível neste navegador — use o player do vídeo.',
      );
    }
  }

  return (
    <div className={`comm-wa-embed is-${kind}`}>
      <div className="comm-wa-embed-frame">
        <iframe
          ref={iframeRef}
          src={src}
          title={title || kind}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
          allowFullScreen
          loading="lazy"
          referrerPolicy="strict-origin-when-cross-origin"
        />
      </div>
      <div className="comm-wa-embed-actions">
        <button type="button" className="comm-wa-embed-pip" onClick={() => void openPip()}>
          <Maximize2 size={14} />
          Picture-in-Picture
        </button>
        {pipHint ? <em className="muted">{pipHint}</em> : null}
      </div>
    </div>
  );
}

function LinkPreviewCard({
  preview,
  text,
}: {
  preview?: { url?: string; title?: string; description?: string };
  text: string;
}) {
  const url = firstUrl(text, preview?.url || '');
  if (!url && !preview?.title) return null;

  const yt = url ? youtubeVideoId(url) : null;
  if (yt) {
    return (
      <div className="comm-wa-link-preview is-embed">
        {preview?.title ? <strong>{preview.title}</strong> : null}
        <MediaEmbed
          kind="youtube"
          title={preview?.title || 'YouTube'}
          src={`https://www.youtube-nocookie.com/embed/${yt}?rel=0&modestbranding=1`}
        />
        <span className="comm-wa-link-url">{url}</span>
      </div>
    );
  }

  const vim = url ? vimeoId(url) : null;
  if (vim) {
    return (
      <div className="comm-wa-link-preview is-embed">
        {preview?.title ? <strong>{preview.title}</strong> : null}
        <MediaEmbed
          kind="vimeo"
          title={preview?.title || 'Vimeo'}
          src={`https://player.vimeo.com/video/${vim}`}
        />
        <span className="comm-wa-link-url">{url}</span>
      </div>
    );
  }

  const href = url || '#';
  return (
    <a
      className="comm-wa-link-preview"
      href={href}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => e.stopPropagation()}
    >
      {preview?.title ? <strong>{preview.title}</strong> : null}
      {preview?.description ? <em>{preview.description}</em> : null}
      <span>{url || preview?.title}</span>
    </a>
  );
}

/** Corpo tipado da bolha (contato, local, enquete, payload debug, etc.). */
export function WaMessageContent({ msg }: { msg: WaMessage }) {
  const type = String(msg.type || '').toLowerCase();
  const text = (msg.text || msg.body || msg.caption || '').trim();

  if (type === 'contact' || type === 'vcard') {
    const name = msg.contact?.displayName || parseVcardName(msg.contact?.vcard || '') || text || 'Contato';
    const tel = parseVcardTel(msg.contact?.vcard || '');
    return (
      <div className="comm-wa-card is-contact">
        <strong>{name}</strong>
        {tel ? <em>{tel}</em> : null}
        <span className="muted">Contato</span>
      </div>
    );
  }

  if (type === 'contact_array') {
    const list = msg.contacts || [];
    return (
      <div className="comm-wa-card is-contact">
        <strong>{msg.contactTitle || `${list.length} contatos`}</strong>
        <ul>
          {list.slice(0, 8).map((c, i) => (
            <li key={i}>{c.displayName || parseVcardName(c.vcard || '') || 'Contato'}</li>
          ))}
        </ul>
      </div>
    );
  }

  if (type === 'location' || type === 'live_location') {
    const loc = msg.location;
    const maps =
      loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng)
        ? `https://maps.google.com/?q=${loc.lat},${loc.lng}`
        : '';
    return (
      <div className="comm-wa-card is-location">
        <strong>{loc?.isLive ? 'Localização ao vivo' : loc?.name || 'Localização'}</strong>
        {loc?.address ? <em>{loc.address}</em> : null}
        {maps ? (
          <a href={maps} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
            Abrir no Maps
          </a>
        ) : null}
      </div>
    );
  }

  if (type === 'poll') {
    return (
      <div className="comm-wa-card is-poll">
        <strong>{msg.poll?.name || text || 'Enquete'}</strong>
        <ul>
          {(msg.poll?.options || []).map((o, i) => (
            <li key={i}>{o}</li>
          ))}
        </ul>
      </div>
    );
  }

  if (type === 'reaction') {
    return <span className="comm-wa-bubble-text">{msg.reaction?.text || text || '❤️'}</span>;
  }

  if (msg.payloadDebug) {
    return (
      <div className="comm-wa-card is-debug">
        <strong>Tipo não mapeado ({type || 'other'})</strong>
        <pre>{msg.payloadDebug}</pre>
      </div>
    );
  }

  return (
    <>
      {text ? <span className="comm-wa-bubble-text">{text}</span> : null}
      {(msg.linkPreview || /https?:\/\//i.test(text)) && (type === 'text' || !type) ? (
        <LinkPreviewCard preview={msg.linkPreview} text={text} />
      ) : null}
    </>
  );
}
