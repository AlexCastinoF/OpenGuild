import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { VoiceDebugSnapshot } from '../hooks/useLiveKitRoom';

type Props = {
  open: boolean;
  debug: VoiceDebugSnapshot | null;
  onShareVideoOnly: () => void;
  onShareWithAppAudio: () => void;
  onStopShare: () => void;
  sharing: boolean;
};

function Bar({
  label,
  level,
  has,
  dir,
  note,
}: {
  label: string;
  level: number;
  has: boolean;
  dir: 'in' | 'out';
  note?: string;
}) {
  const pct = has ? Math.max(0, Math.min(100, Math.round(level * 100))) : 0;
  const live = has && level >= 0.03;
  return (
    <div className={`sf-vdbg-row${live ? ' is-live' : ''}${!has ? ' is-off' : ''}`}>
      <span className="sf-vdbg-lab">
        <em>{dir === 'out' ? '↑' : '↓'}</em> {label}
      </span>
      <span className="sf-vdbg-bar">
        <span style={{ width: `${pct}%` }} />
      </span>
      <span className="sf-vdbg-pct">{has ? `${pct}%` : '—'}</span>
      {note ? <span className="sf-vdbg-note">{note}</span> : null}
    </div>
  );
}

/** Balão flutuante de teste: níveis de todos os streams de voz/tela. */
export function VoiceDebugBalloon({
  open,
  debug,
  onShareVideoOnly,
  onShareWithAppAudio,
  onStopShare,
  sharing,
}: Props) {
  const [hidden, setHidden] = useState(false);
  const [pos, setPos] = useState({ x: 16, y: 72 });
  const drag = useRef<{ dx: number; dy: number } | null>(null);

  useEffect(() => {
    if (!open) setHidden(false);
  }, [open]);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('button') || t.closest('a')) return;
      drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    [pos.x, pos.y],
  );

  const onPointerMove = useCallback((e: ReactPointerEvent) => {
    if (!drag.current) return;
    setPos({
      x: Math.max(0, e.clientX - drag.current.dx),
      y: Math.max(0, e.clientY - drag.current.dy),
    });
  }, []);

  const onPointerUp = useCallback(() => {
    drag.current = null;
  }, []);

  if (!open || hidden || !debug) return null;

  const local = debug.tracks.find((t) => t.isLocal);
  const remotes = debug.tracks.filter((t) => !t.isLocal);
  const elById = (id: string, kind: string) =>
    debug.els.find((e) => e.identity === id && e.kind === kind);

  return (
    <div
      className="sf-vdbg"
      style={{ left: pos.x, top: pos.y }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <header className="sf-vdbg-head">
        <strong>Voice Debug</strong>
        <span className="sf-vdbg-pill">{debug.bundle}</span>
        <button type="button" className="sf-vdbg-x" onClick={() => setHidden(true)} title="Esconder">
          ×
        </button>
      </header>

      <div className="sf-vdbg-status">
        <span className={debug.canPlayback ? 'ok' : 'bad'}>
          playback {debug.canPlayback ? 'OK' : 'OFF'}
        </span>
        <span className={debug.els.length ? 'ok' : 'bad'}>els {debug.els.length}</span>
        <span className={debug.sharing ? 'ok' : ''}>share {debug.sharing ? 'ON' : 'off'}</span>
        <span>lock {debug.shareLock ? 'ON' : 'off'}</span>
        <span className={debug.micOn ? 'ok' : 'bad'}>mic {debug.micOn ? 'ON' : 'MUTE'}</span>
        <span className={debug.wasapiBridge ? 'ok' : ''}>
          wasapi {debug.wasapiBridge ? `${Math.round(debug.wasapiLevel * 100)}%` : 'off'}
        </span>
        <span className={debug.webAudio?.nodes ? 'ok' : 'bad'}>
          webaudio {debug.webAudio?.ctxState || '?'}×{debug.webAudio?.nodes ?? 0}
        </span>
        <span className={debug.webContentsMuted ? 'bad' : 'ok'}>
          wc {debug.webContentsMuted == null ? '?' : debug.webContentsMuted ? 'MUTED!' : 'ok'}
        </span>
      </div>

      {local ? (
        <section className="sf-vdbg-sec">
          <h4>EU · enviar</h4>
          <Bar label="Mic" level={local.mic.level} has={local.mic.has} dir="out" />
          <Bar
            label="Tela áudio"
            level={local.screenAudio.level}
            has={local.screenAudio.has}
            dir="out"
          />
          <div className={`sf-vdbg-flag${local.screenVideo ? ' on' : ''}`}>
            Vídeo tela: {local.screenVideo ? 'ON' : 'off'}
          </div>
        </section>
      ) : null}

      {remotes.map((r) => {
        const micEl = elById(r.identity, 'mic');
        const scrEl = elById(r.identity, 'screen');
        const elNote = micEl
          ? `html ${micEl.paused ? 'PAUSED' : 'play'} ${micEl.muted ? 'MUTED' : 'unmuted'} v=${micEl.volume}`
          : 'html sem elemento';
        return (
          <section key={r.identity} className="sf-vdbg-sec">
            <h4>RX · {r.name || r.identity}</h4>
            <Bar label="Mic" level={r.mic.level} has={r.mic.has} dir="in" note={elNote} />
            <Bar
              label="Tela áudio"
              level={r.screenAudio.level}
              has={r.screenAudio.has}
              dir="in"
              note={
                scrEl
                  ? `html ${scrEl.paused ? 'PAUSED' : 'play'} muted=${scrEl.muted}`
                  : undefined
              }
            />
            <div className={`sf-vdbg-flag${r.screenVideo ? ' on' : ''}`}>
              Vídeo tela: {r.screenVideo ? 'ON' : 'off'}
            </div>
          </section>
        );
      })}

      {!remotes.length ? (
        <section className="sf-vdbg-sec">
          <h4>RX</h4>
          <p className="sf-vdbg-empty">Ninguém remoto na call</p>
        </section>
      ) : null}

      <div className="sf-vdbg-actions">
        {sharing ? (
          <button type="button" onClick={onStopShare}>
            Parar tela
          </button>
        ) : (
          <>
            <button type="button" className="primary" onClick={onShareVideoOnly}>
              Teste: só vídeo
            </button>
            <button type="button" onClick={onShareWithAppAudio}>
              Vídeo + áudio app
            </button>
          </>
        )}
      </div>
      <p className="sf-vdbg-hint">
        Arrasta o balão. &quot;Só vídeo&quot; = sem WASAPI — se a voz cortar, é o getDisplayMedia/Windows.
      </p>
    </div>
  );
}
