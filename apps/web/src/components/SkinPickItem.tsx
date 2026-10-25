export type SkinItem = {
  assetid: string;
  name: string;
  market_hash_name?: string;
  icon?: string;
  icon_large?: string;
  rarity?: string;
  rarity_color?: string;
  exterior?: string;
  type?: string;
  quality?: string;
  weapon?: string;
  market_url?: string;
  inspect_url?: string;
  provenance?: string[];
  acquired_hint?: string;
  float_value?: string | number;
};

function rarityTier(color?: string): string {
  const c = (color || '').toLowerCase();
  if (c.includes('e4ae39')) return 'mythic';
  if (c.includes('eb4b4b')) return 'legendary';
  if (c.includes('d32ce6')) return 'epic';
  if (c.includes('8847ff')) return 'rare';
  if (c.includes('4b69ff')) return 'uncommon';
  return 'normal';
}

/** Chip pequeno abaixo do nome (userbar / membros / voz). */
export function SkinChip({
  item,
  size = 'xs',
  onOpen,
}: {
  item: SkinItem;
  size?: 'xs' | 'sm' | 'md';
  onOpen?: (item: SkinItem) => void;
}) {
  const accent = item.rarity_color || '#8b9bb4';
  const tier = rarityTier(accent);
  return (
    <button
      type="button"
      className={`comm-skin-chip size-${size} tier-${tier}`}
      style={{ ['--skin-accent' as string]: accent }}
      title={item.name}
      onClick={(e) => {
        e.stopPropagation();
        onOpen?.(item);
      }}
    >
      <span className="comm-skin-ring" aria-hidden />
      <span className="comm-skin-face">
        <span className="comm-skin-glow" aria-hidden />
        <img
          src={item.icon || item.icon_large || '/icon.svg'}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
        />
      </span>
    </button>
  );
}

export function ShowcaseBadges({
  items,
  size = 'xs',
  className = 'comm-badges',
  onOpen,
}: {
  items?: SkinItem[] | null;
  size?: 'xs' | 'sm' | 'md';
  className?: string;
  onOpen?: (item: SkinItem) => void;
}) {
  const list = (items || []).slice(0, 5);
  if (!list.length) return null;
  return (
    <div className={className}>
      {list.map((it) => (
        <SkinChip key={it.assetid} item={it} size={size} onOpen={onOpen} />
      ))}
    </div>
  );
}

/** Tile de inventário/vitrine — mesma markup/CSS do ASF (`.comm-pick-item`). */
export function SkinPickItem({
  item,
  selected,
  selectedIndex,
  onToggle,
  staticView,
}: {
  item: SkinItem;
  selected?: boolean;
  /** 0-based order among selected (shows 1–5 badge). */
  selectedIndex?: number;
  onToggle?: () => void;
  staticView?: boolean;
}) {
  const accent = item.rarity_color || '#8b9bb4';
  const tier = rarityTier(accent);
  const on = !!selected;
  const cls = `comm-pick-item tier-${tier}${on ? ' is-on' : ''}${staticView ? ' is-static' : ''}`;
  const title = item.market_hash_name || item.name;
  const badge =
    on && selectedIndex != null && selectedIndex >= 0 ? (
      <span className="comm-pick-sel" aria-hidden>
        {selectedIndex + 1}
      </span>
    ) : on ? (
      <span className="comm-pick-sel comm-pick-sel-check" aria-hidden>
        ✓
      </span>
    ) : null;

  if (staticView) {
    return (
      <div className={cls} title={title} style={{ ['--skin-accent' as string]: accent }}>
        {badge}
        <img
          src={item.icon || item.icon_large || '/icon.svg'}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
        />
        <span>{item.name}</span>
      </div>
    );
  }

  return (
    <button
      type="button"
      className={cls}
      title={title}
      aria-pressed={on}
      style={{ ['--skin-accent' as string]: accent }}
      onClick={onToggle}
    >
      {badge}
      <img
        src={item.icon || item.icon_large || '/icon.svg'}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
      />
      <span>{item.name}</span>
    </button>
  );
}
