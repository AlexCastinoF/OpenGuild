import React, { useEffect, useRef, useState } from 'react';
import { Settings, Copy, Hash, Volume2, Monitor, PhoneCall, PhoneOff, Trash2, Check, ExternalLink } from 'lucide-react';

export type ChannelContextMenuData = {
  channel: {
    id: number;
    name: string;
    kind: string;
    icon_url?: string;
  };
  x: number;
  y: number;
};

interface ChannelContextMenuProps {
  data: ChannelContextMenuData | null;
  onClose: () => void;
  onEdit: (channel: any) => void;
  onDelete?: (channel: any) => void;
  onOpen?: (channel: any) => void;
  onJoinVoice?: (channel: any) => void;
  onLeaveVoice?: () => void;
  isCurrentVoice?: boolean;
  canManage?: boolean;
}

export function ChannelContextMenu({
  data,
  onClose,
  onEdit,
  onDelete,
  onOpen,
  onJoinVoice,
  onLeaveVoice,
  isCurrentVoice,
  canManage = true,
}: ChannelContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!data) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    const handleScroll = () => {
      onClose();
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('scroll', handleScroll, true);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('scroll', handleScroll, true);
    };
  }, [data, onClose]);

  if (!data) return null;

  const { channel, x, y } = data;
  const isVoice = channel.kind === 'voice';
  const isScreen = channel.kind === 'screen';
  const isAudioOrScreen = isVoice || isScreen;

  // Viewport clamping to prevent menu from being cut off at bottom/right
  const menuWidth = 220;
  const menuHeight = 240;
  const left = Math.min(x, window.innerWidth - menuWidth - 10);
  const top = Math.min(y, window.innerHeight - menuHeight - 10);

  const handleCopyId = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard?.writeText(String(channel.id));
    setCopied(true);
    setTimeout(() => {
      onClose();
    }, 500);
  };

  return (
    <div
      ref={menuRef}
      className="comm-context-menu"
      style={{
        left: `${Math.max(8, left)}px`,
        top: `${Math.max(8, top)}px`,
      }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      role="menu"
      aria-label={`Opções do canal ${channel.name}`}
    >
      <div className="comm-context-menu-header">
        {isScreen ? <Monitor size={14} /> : isVoice ? <Volume2 size={14} /> : <Hash size={14} />}
        <span className="comm-context-menu-title" title={channel.name}>
          {channel.name}
        </span>
      </div>

      <div className="comm-context-menu-divider" />

      {canManage && (
        <button
          type="button"
          className="comm-context-menu-item"
          onClick={() => {
            onClose();
            onEdit(channel);
          }}
        >
          <Settings size={15} />
          <span>Modificar canal</span>
        </button>
      )}

      {isAudioOrScreen ? (
        isCurrentVoice ? (
          <button
            type="button"
            className="comm-context-menu-item comm-context-danger"
            onClick={() => {
              onClose();
              onLeaveVoice?.();
            }}
          >
            <PhoneOff size={15} />
            <span>Desconectar da chamada</span>
          </button>
        ) : (
          <button
            type="button"
            className="comm-context-menu-item comm-context-primary"
            onClick={() => {
              onClose();
              onJoinVoice?.(channel);
            }}
          >
            <PhoneCall size={15} />
            <span>Entrar na chamada</span>
          </button>
        )
      ) : (
        <button
          type="button"
          className="comm-context-menu-item comm-context-primary"
          onClick={() => {
            onClose();
            onOpen?.(channel);
          }}
        >
          <ExternalLink size={15} />
          <span>Abrir canal</span>
        </button>
      )}

      <button
        type="button"
        className="comm-context-menu-item"
        onClick={handleCopyId}
      >
        {copied ? <Check size={15} color="#3ddc97" /> : <Copy size={15} />}
        <span>{copied ? 'ID Copiado!' : 'Copiar ID do canal'}</span>
      </button>

      {canManage && onDelete && (
        <>
          <div className="comm-context-menu-divider" />
          <button
            type="button"
            className="comm-context-menu-item comm-context-danger"
            onClick={() => {
              onClose();
              onDelete(channel);
            }}
          >
            <Trash2 size={15} />
            <span>Excluir canal</span>
          </button>
        </>
      )}
    </div>
  );
}
