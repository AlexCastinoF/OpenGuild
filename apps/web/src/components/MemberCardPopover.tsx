import React, { useRef, useEffect } from 'react';
import {
  Mail,
  Swords,
  MapPin,
  Wifi,
  Gamepad2,
  Shield,
  Sparkles,
  X,
} from 'lucide-react';
import '../styles/member-popover.css';

export type MemberSkinItem = {
  assetid: string;
  name: string;
  icon?: string;
  icon_large?: string;
  rarity_color?: string;
};

export type PopoverMember = {
  id: number;
  label: string;
  username?: string;
  avatar_url: string;
  ramal?: string;
  work_status?: string;
  role: string;
  steam_linked?: boolean;
  steam_persona?: string;
  showcase_items?: MemberSkinItem[];
  card_color?: string | null;
  custom_roles?: Array<{ id: number; name: string; color: string }>;
};

interface MemberCardPopoverProps {
  member: PopoverMember;
  anchorRect: DOMRect | null;
  isOnline: boolean;
  activity?: string;
  location?: string;
  pingMs?: number;
  onClose: () => void;
  onDm: (userId: number) => void;
  onRallyInvite: (member: PopoverMember) => void;
}

export function MemberCardPopover({
  member,
  anchorRect,
  isOnline,
  activity = 'jogando CS2',
  location = 'São Paulo, BR',
  pingMs = 14,
  onClose,
  onDm,
  onRallyInvite,
}: MemberCardPopoverProps) {
  const cardRef = useRef<HTMLDivElement>(null);

  // Fecha ao clicar fora
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', handleClickOutside, true);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside, true);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  // Calcula posição para não vazar da tela (popover aparece à esquerda da lista de membros)
  let top = 100;
  let left = 200;

  if (anchorRect) {
    const cardWidth = 320;
    const cardHeight = 360;

    // Preferencialmente à esquerda do elemento âncora
    left = anchorRect.left - cardWidth - 12;
    if (left < 16) {
      left = anchorRect.right + 12;
    }

    // Alinhamento vertical centralizado ou ajustado à tela
    top = anchorRect.top - 40;
    if (top + cardHeight > window.innerHeight - 20) {
      top = Math.max(20, window.innerHeight - cardHeight - 20);
    }
    if (top < 20) top = 20;
  }

  const roleName =
    member.role === 'owner'
      ? 'Dono'
      : member.role === 'admin'
        ? 'Admin'
        : member.custom_roles?.[0]?.name || 'Membro';

  const accentColor =
    member.card_color ||
    member.custom_roles?.[0]?.color ||
    'var(--accent, #ff9a3d)';

  const skins = (member.showcase_items || []).slice(0, 4);

  return (
    <div
      ref={cardRef}
      className="member-card-popover"
      style={{
        top: `${top}px`,
        left: `${left}px`,
        ['--member-accent' as string]: accentColor,
      }}
      role="dialog"
      aria-label={`Perfil de ${member.label}`}
    >
      {/* Banner na cor de destaque */}
      <div className="member-popover-banner">
        <button
          type="button"
          className="member-popover-close"
          onClick={onClose}
          aria-label="Fechar"
        >
          <X size={14} />
        </button>
      </div>

      <div className="member-popover-body">
        {/* Avatar com status e anel recortado */}
        <div className="member-popover-avatar-wrap">
          <img
            src={member.avatar_url || '/icon.svg'}
            alt={member.label}
            className="member-popover-avatar"
            onError={(e) => {
              (e.target as HTMLImageElement).src = '/icon.svg';
            }}
          />
          <span
            className={`member-popover-status-dot ${isOnline ? 'online' : 'offline'}`}
            title={isOnline ? 'Online' : 'Offline'}
          />
        </div>

        {/* Identificação */}
        <div className="member-popover-header">
          <div className="member-popover-name-row">
            <h3 className="member-popover-name">{member.label}</h3>
            {member.username && (
              <span className="member-popover-tag">@{member.username}</span>
            )}
          </div>

          <div className="member-popover-badges">
            <span className="member-popover-role-badge">
              <Shield size={12} strokeWidth={2} />
              {roleName}
            </span>
            {member.custom_roles?.slice(1, 3).map((cr) => (
              <span
                key={cr.id}
                className="member-popover-role-badge custom"
                style={{ borderColor: cr.color, color: cr.color }}
              >
                {cr.name}
              </span>
            ))}
          </div>
        </div>

        {/* Atividade, Localização e Ping */}
        <div className="member-popover-details">
          {activity && (
            <div className="member-popover-meta-row">
              <Gamepad2 size={14} className="meta-icon accent" />
              <span className="meta-text">{activity}</span>
            </div>
          )}
          <div className="member-popover-meta-row">
            <MapPin size={14} className="meta-icon" />
            <span className="meta-text">{location}</span>
            <span className="meta-sep">•</span>
            <Wifi size={13} className="meta-icon" />
            <span className="meta-text">{pingMs}ms</span>
          </div>
        </div>

        {/* Skins Equipadas (até 4) */}
        <div className="member-popover-skins-section">
          <div className="member-popover-skins-title">
            <Sparkles size={12} strokeWidth={2} />
            <span>Skins equipadas ({skins.length}/4)</span>
          </div>

          <div className="member-popover-skins-grid">
            {skins.length > 0 ? (
              skins.map((skin, idx) => (
                <div
                  key={skin.assetid || idx}
                  className="member-popover-skin-card"
                  style={{
                    borderColor: skin.rarity_color || 'rgba(255, 255, 255, 0.12)',
                  }}
                  title={skin.name}
                >
                  {skin.icon || skin.icon_large ? (
                    <img
                      src={skin.icon_large || skin.icon}
                      alt={skin.name}
                      className="member-popover-skin-img"
                    />
                  ) : (
                    <div className="member-popover-skin-placeholder">CS</div>
                  )}
                  <span className="member-popover-skin-name">{skin.name}</span>
                </div>
              ))
            ) : (
              <div className="member-popover-no-skins">
                <span>Nenhuma skin equipada em exibição</span>
              </div>
            )}
          </div>
        </div>

        {/* Botões de Ação */}
        <div className="member-popover-actions">
          <button
            type="button"
            className="member-popover-btn-dm"
            onClick={() => {
              onDm(member.id);
              onClose();
            }}
          >
            <Mail size={15} />
            <span>Mensagem</span>
          </button>
          <button
            type="button"
            className="member-popover-btn-rally"
            onClick={() => {
              onRallyInvite(member);
              onClose();
            }}
          >
            <Swords size={15} />
            <span>Chamar p/ Rally</span>
          </button>
        </div>
      </div>
    </div>
  );
}
