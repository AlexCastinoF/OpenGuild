import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import { Mic, MicOff, PhoneOff } from 'lucide-react';

const LS_POS = 'steamfarm-voice-float-pos';
const DEFAULT_AVATAR = '/icon.svg';

type Pos = { x: number; y: number };

function loadPos(): Pos | null {
  try {
    const raw = localStorage.getItem(LS_POS);
    if (!raw) return null;
    const p = JSON.parse(raw) as Pos;
    if (typeof p.x === 'number' && typeof p.y === 'number') return p;
  } catch {
    /* ignore */
  }
  return null;
}

function clampPos(x: number, y: number, el: HTMLElement | null): Pos {
  const w = el?.offsetWidth || 280;
  const h = el?.offsetHeight || 56;
  const maxX = Math.max(8, window.innerWidth - w - 8);
  const maxY = Math.max(8, window.innerHeight - h - 8);
  return {
    x: Math.min(maxX, Math.max(8, x)),
    y: Math.min(maxY, Math.max(8, y)),
  };
}

type Props = {
  visible: boolean;
  meName: string;
  meAvatar: string;
  serverName: string;
  channelName: string;
  micOn: boolean;
  deafened?: boolean;
  onReturn: () => void;
  onToggleMic: () => void;
  onLeave: () => void;
};

export function VoiceFloat({
  visible,
  meName,
  meAvatar,
  serverName,
  channelName,
  micOn,
  deafened = false,
  onReturn,
  onToggleMic,
  onLeave,
}: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    ox: number;
    oy: number;
    startX: number;
    startY: number;
    moved: boolean;
  } | null>(null);
  const [pos, setPos] = useState<Pos | null>(() => loadPos());

  useEffect(() => {
    if (!visible || !pos) return;
    const onResize = () => {
      setPos((p) => (p ? clampPos(p.x, p.y, rootRef.current) : p));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [visible, pos]);

  const onPointerDown = useCallback((e: PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button')) return;
    const el = rootRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    dragRef.current = {
      ox: e.clientX - rect.left,
      oy: e.clientY - rect.top,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
    };
    el.setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e: PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    if (Math.abs(e.clientX - d.startX) + Math.abs(e.clientY - d.startY) > 4) {
      d.moved = true;
    }
    setPos(clampPos(e.clientX - d.ox, e.clientY - d.oy, rootRef.current));
  }, []);

  const onPointerUp = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      const d = dragRef.current;
      dragRef.current = null;
      if (!d) return;
      const el = rootRef.current;
      if (el?.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      if (!d.moved) {
        onReturn();
        return;
      }
      setPos((p) => {
        if (!p) return p;
        const clamped = clampPos(p.x, p.y, rootRef.current);
        try {
          localStorage.setItem(LS_POS, JSON.stringify(clamped));
        } catch {
          /* ignore */
        }
        return clamped;
      });
    },
    [onReturn],
  );

  if (!visible) return null;

  return (
    <div
      ref={rootRef}
      className="comm-voice-float is-draggable"
      style={
        pos
          ? { left: pos.x, top: pos.y, right: 'auto', bottom: 'auto' }
          : undefined
      }
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      role="status"
      title="Arraste para mover · clique para voltar ao canal"
    >
      <img
        className="comm-avatar"
        src={(meAvatar || '').trim() || DEFAULT_AVATAR}
        alt=""
        width={28}
        height={28}
        onError={(ev) => {
          (ev.target as HTMLImageElement).src = DEFAULT_AVATAR;
        }}
      />
      <div className="comm-voice-float-meta">
        <strong>{serverName || '—'}</strong>
        <em>{channelName || 'voz'}</em>
      </div>
      <button
        type="button"
        className={`comm-ctrl${!micOn || deafened ? ' is-off' : ''}`}
        title="Microfone"
        aria-pressed={!micOn || deafened}
        onClick={(e) => {
          e.stopPropagation();
          onToggleMic();
        }}
      >
        {micOn && !deafened ? <Mic size={16} /> : <MicOff size={16} />}
      </button>
      <button
        type="button"
        className="comm-ctrl"
        title="Desconectar"
        onClick={(e) => {
          e.stopPropagation();
          onLeave();
        }}
      >
        <PhoneOff size={16} />
      </button>
      <span className="sr-only">{meName}</span>
    </div>
  );
}
