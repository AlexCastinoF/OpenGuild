import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { NativeDialog } from './NativeDialog';
import { api } from '../lib/api';
import { useBrandStore } from '../store/brand';

const SURFACES = [
  { key: 'header', label: 'Cabeçalho', tip: 'Barra superior (logo e menus)' },
  { key: 'rail', label: 'Servidores', tip: 'Barra esquerda' },
  { key: 'sidebar', label: 'Canais', tip: 'Menu e usuário' },
  { key: 'chat', label: 'Centro', tip: 'Chat / conteúdo' },
  { key: 'stage', label: 'Palco', tip: 'Voz e live' },
  { key: 'members', label: 'Membros', tip: 'Painel direito' },
] as const;

type SurfaceKey = (typeof SURFACES)[number]['key'];

export type SurfaceCfg = {
  color?: string;
  media_url?: string;
  media_kind?: string;
  blur?: number;
  opacity?: number;
  /** Painel flutuante (cantos arredondados + sombra) */
  floating?: boolean;
};

export type ThemeChrome = {
  accent?: string;
  accent_hover?: string;
  text?: string;
  muted?: string;
  link?: string;
  panel?: string;
  panel_2?: string;
  line?: string;
  line_strong?: string;
  card?: string;
  input?: string;
  input_border?: string;
  danger?: string;
  success?: string;
  font_family?: string;
  font_size?: number;
  contrast?: 'auto' | 'light' | 'dark';
  ui_style?: 'default' | 'floating';
};

export type ThemeState = {
  surfaces: Partial<Record<SurfaceKey, SurfaceCfg>>;
  chrome: ThemeChrome;
};

type Props = {
  open: boolean;
  onClose: () => void;
  premium: boolean;
  /** Tema atualmente aplicado (para restaurar ao cancelar) */
  currentTheme?: ThemeState | null;
  previewRoot?: HTMLElement | null;
  onSaved?: (theme: ThemeState) => void;
};

const FONT_PRESETS = [
  { id: '', label: 'Padrão do app' },
  { id: '"Segoe UI", system-ui, sans-serif', label: 'Segoe UI' },
  { id: 'system-ui, -apple-system, BlinkMacSystemFont, sans-serif', label: 'System UI' },
  { id: 'Georgia, "Times New Roman", serif', label: 'Georgia (serif)' },
  { id: '"Palatino Linotype", Palatino, serif', label: 'Palatino' },
  { id: '"Trebuchet MS", "Segoe UI", sans-serif', label: 'Trebuchet' },
  { id: 'Verdana, Geneva, sans-serif', label: 'Verdana' },
  { id: 'Tahoma, "Segoe UI", sans-serif', label: 'Tahoma' },
  { id: '"Courier New", Courier, monospace', label: 'Courier' },
  { id: '"JetBrains Mono", Consolas, monospace', label: 'JetBrains Mono' },
  { id: 'Consolas, "Lucida Console", monospace', label: 'Consolas' },
  { id: '"Comic Sans MS", "Segoe UI", sans-serif', label: 'Comic Sans' },
];

const BG_SWATCHES = [
  '#0b0d12', '#12151c', '#1a1d24', '#1e2128', '#252932', '#2b2f3a',
  '#0f172a', '#111827', '#1e293b', '#312e81', '#3b0764', '#134e4a',
  '#f8fafc', '#e2e8f0', '#cbd5e1', '#fef3c7', '#fee2e2', '#dbeafe',
];

const ACCENT_SWATCHES = [
  '#5865f2', '#22c55e', '#ef4444', '#f59e0b', '#06b6d4', '#ec4899',
  '#8b5cf6', '#14b8a6', '#f97316', '#3b82f6', '#84cc16', '#e11d48',
];

const BORDER_SWATCHES = [
  '#1f2937', '#2f333d', '#374151', '#4b5563', '#64748b',
  '#94a3b8', '#cbd5e1', '#e5e7eb', '#ffffff22', '#00000033',
];

function hexLum(hex: string): number {
  const h = hex.replace('#', '');
  const full =
    h.length === 3
      ? h
          .split('')
          .map((c) => c + c)
          .join('')
      : h;
  if (full.length < 6) return 0.2;
  const r = parseInt(full.slice(0, 2), 16) / 255;
  const g = parseInt(full.slice(2, 4), 16) / 255;
  const b = parseInt(full.slice(4, 6), 16) / 255;
  const toLin = (c: number) =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  return 0.2126 * toLin(r) + 0.7152 * toLin(g) + 0.0722 * toLin(b);
}

function autoText(bg: string): { text: string; muted: string; link: string } {
  const light = hexLum(bg) > 0.42;
  return light
    ? { text: '#0b1220', muted: '#334155', link: '#1d4ed8' }
    : { text: '#f8fafc', muted: '#aab4c3', link: '#93c5fd' };
}

function resolveChrome(
  chrome: ThemeChrome,
  surfaces: ThemeState['surfaces'],
): ThemeChrome {
  const c: ThemeChrome = { ...chrome };
  const mode = c.contrast || 'auto';
  if (mode === 'light') {
    c.text = '#0f172a';
    c.muted = '#475569';
    c.link = c.link || '#1d4ed8';
  } else if (mode === 'dark') {
    c.text = '#f1f5f9';
    c.muted = '#94a3b8';
    c.link = c.link || '#93c5fd';
  } else {
    const base =
      c.panel ||
      surfaces.chat?.color ||
      surfaces.sidebar?.color ||
      surfaces.rail?.color ||
      '#1a1d24';
    const auto = autoText(base);
    c.text = auto.text;
    c.muted = auto.muted;
    if (!c.link) c.link = auto.link;
  }
  if (c.accent && !c.accent_hover) {
    c.accent_hover = c.accent;
  }
  return c;
}

type Tab = 'areas' | 'colors' | 'type';

const QUICK_PRESETS: { id: string; label: string; tip: string; chrome: ThemeChrome; surfaces?: ThemeState['surfaces'] }[] = [
  {
    id: 'midnight',
    label: 'Meia-noite',
    tip: 'Escuro clássico',
    chrome: {
      contrast: 'auto',
      accent: '#5865f2',
      accent_hover: '#4752c4',
      panel: '#1e2128',
      panel_2: '#161920',
      card: '#252932',
      line: '#2f333d',
      line_strong: '#4b5563',
      input: '#0f1218',
      input_border: '#2f333d',
      danger: '#ef4444',
      success: '#22c55e',
    },
    surfaces: {
      rail: { color: '#111318' },
      sidebar: { color: '#171a21' },
      chat: { color: '#1a1d24' },
      stage: { color: '#12151c' },
      members: { color: '#171a21' },
    },
  },
  {
    id: 'ocean',
    label: 'Oceano',
    tip: 'Azul profundo',
    chrome: {
      contrast: 'auto',
      accent: '#06b6d4',
      accent_hover: '#0891b2',
      panel: '#0f172a',
      panel_2: '#0b1220',
      card: '#1e293b',
      line: '#334155',
      input: '#0b1220',
      input_border: '#334155',
      danger: '#f43f5e',
      success: '#14b8a6',
    },
    surfaces: {
      rail: { color: '#0b1220' },
      sidebar: { color: '#0f172a' },
      chat: { color: '#111827' },
      stage: { color: '#0b1220' },
      members: { color: '#0f172a' },
    },
  },
  {
    id: 'ember',
    label: 'Brasa',
    tip: 'Quente escuro',
    chrome: {
      contrast: 'auto',
      accent: '#f97316',
      accent_hover: '#ea580c',
      panel: '#1c1410',
      panel_2: '#140f0c',
      card: '#2a1d16',
      line: '#3f2a1e',
      input: '#140f0c',
      danger: '#ef4444',
      success: '#84cc16',
    },
    surfaces: {
      rail: { color: '#140f0c' },
      sidebar: { color: '#1c1410' },
      chat: { color: '#221811' },
      stage: { color: '#140f0c' },
      members: { color: '#1c1410' },
    },
  },
  {
    id: 'paper',
    label: 'Papel',
    tip: 'Claro limpo',
    chrome: {
      contrast: 'light',
      accent: '#2563eb',
      accent_hover: '#1d4ed8',
      panel: '#f8fafc',
      panel_2: '#e2e8f0',
      card: '#ffffff',
      line: '#cbd5e1',
      line_strong: '#94a3b8',
      text: '#0b1220',
      muted: '#334155',
      link: '#1d4ed8',
      input: '#ffffff',
      input_border: '#cbd5e1',
      danger: '#dc2626',
      success: '#16a34a',
      ui_style: 'floating',
    },
    surfaces: {
      header: { color: '#f8fafc', floating: true },
      rail: { color: '#e2e8f0', floating: true },
      sidebar: { color: '#f1f5f9', floating: true },
      chat: { color: '#f8fafc', floating: true },
      stage: { color: '#e2e8f0' },
      members: { color: '#f1f5f9', floating: true },
    },
  },
];

function Swatches({
  colors,
  value,
  onPick,
  label,
}: {
  colors: string[];
  value?: string;
  onPick: (c: string) => void;
  label: string;
}) {
  return (
    <div className="theme-swatches" role="listbox" aria-label={label}>
      {colors.map((c) => (
        <button
          key={c}
          type="button"
          className={`theme-swatch${value?.toLowerCase() === c.toLowerCase() ? ' is-on' : ''}`}
          style={{ background: c }}
          title={c}
          aria-label={c}
          onClick={() => onPick(c)}
        />
      ))}
    </div>
  );
}

function ColorField({
  label,
  hint,
  value,
  fallback,
  onChange,
  swatches,
}: {
  label: string;
  hint: string;
  value?: string;
  fallback: string;
  onChange: (v: string) => void;
  swatches?: string[];
}) {
  const hex = value && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value)
    ? value.length === 4
      ? `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`
      : value.slice(0, 7)
    : fallback;
  return (
    <div className="theme-field theme-field-stack">
      <div className="theme-field-row">
        <div className="theme-field-copy">
          <strong>{label}</strong>
          <span>{hint}</span>
        </div>
        <div className="theme-field-control">
          <input type="color" value={hex} onChange={(e) => onChange(e.target.value)} aria-label={label} />
          <code>{hex}</code>
        </div>
      </div>
      {swatches?.length ? <Swatches colors={swatches} value={hex} onPick={onChange} label={label} /> : null}
    </div>
  );
}

function PreviewArea({
  areaKey,
  active,
  surfaces,
  resolved,
  className,
  onPick,
  children,
  label,
}: {
  areaKey: SurfaceKey;
  active: SurfaceKey;
  surfaces: ThemeState['surfaces'];
  resolved: ThemeChrome;
  className: string;
  onPick: (k: SurfaceKey) => void;
  children: ReactNode;
  label: string;
}) {
  const cfg = surfaces[areaKey];
  const sample = cfg?.color || resolved.panel || '#1a1d24';
  const text =
    (resolved.contrast || 'auto') === 'auto'
      ? autoText(sample)
      : { text: resolved.text || '#f1f5f9', muted: resolved.muted || '#94a3b8' };
  const isOn = active === areaKey;

  return (
    <button
      type="button"
      className={`${className}${isOn ? ' is-on' : ''}${cfg?.media_url ? ' has-media' : ''}${cfg?.color ? ' has-color' : ''}`}
      style={{
        backgroundColor: cfg?.color || 'transparent',
        color: text.text,
        ['--pv-local-muted' as string]: text.muted || resolved.muted,
      }}
      onClick={() => onPick(areaKey)}
      title={`Editar ${label}`}
      aria-pressed={isOn}
    >
      {cfg?.media_url ? (
        <span
          className="theme-pv-media"
          aria-hidden
          style={{
            backgroundImage: `url(${cfg.media_url})`,
            opacity: cfg.opacity ?? 0.35,
            filter: `blur(${cfg.blur ?? 12}px)`,
          }}
        />
      ) : null}
      <span className="theme-pv-content">{children}</span>
      {isOn ? <span className="theme-pv-badge">{label}</span> : null}
    </button>
  );
}

function ThemeLivePreview({
  surfaces,
  chrome,
  active,
  onPickArea,
}: {
  surfaces: ThemeState['surfaces'];
  chrome: ThemeChrome;
  active: SurfaceKey;
  onPickArea: (k: SurfaceKey) => void;
}) {
  const brandShort = useBrandStore((s) => s.short_name);
  const brandInitials = (brandShort || 'App')
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  const resolved = resolveChrome(chrome, surfaces);
  const style = {
    ['--pv-accent' as string]: resolved.accent || '#5865f2',
    ['--pv-accent-hover' as string]: resolved.accent_hover || resolved.accent || '#4752c4',
    ['--pv-text' as string]: resolved.text || '#f1f5f9',
    ['--pv-muted' as string]: resolved.muted || '#94a3b8',
    ['--pv-link' as string]: resolved.link || '#93c5fd',
    ['--pv-panel' as string]: resolved.panel || '#1e2128',
    ['--pv-panel-2' as string]: resolved.panel_2 || resolved.panel || '#161920',
    ['--pv-line' as string]: resolved.line || '#2f333d',
    ['--pv-line-strong' as string]: resolved.line_strong || resolved.line || '#4b5563',
    ['--pv-card' as string]: resolved.card || '#252932',
    ['--pv-input' as string]: resolved.input || '#0f1218',
    ['--pv-success' as string]: resolved.success || '#22c55e',
    ['--pv-danger' as string]: resolved.danger || '#ef4444',
    ['--pv-font' as string]: resolved.font_family || 'inherit',
    ['--pv-size' as string]: `${resolved.font_size || 14}px`,
  } as CSSProperties;

  const activeMeta = SURFACES.find((s) => s.key === active)!;

  return (
    <div className="theme-preview" style={style}>
      <div className="theme-preview-bar">
        <div>
          <strong>Prévia ao vivo</strong>
          <span>
            Editando <em>{activeMeta.label}</em> — clique numa coluna para trocar
          </span>
        </div>
        <div className="theme-preview-chips">
          <span className="theme-chip" style={{ background: 'var(--pv-accent)' }}>
            Accent
          </span>
          <span className="theme-chip is-ghost" style={{ borderColor: 'var(--pv-line)', color: 'var(--pv-text)' }}>
            Texto
          </span>
          <span className="theme-chip is-ghost" style={{ borderColor: 'var(--pv-line)', color: 'var(--pv-muted)' }}>
            Muted
          </span>
        </div>
      </div>

      <div
        className="theme-preview-shell"
        style={{ fontFamily: 'var(--pv-font)', fontSize: 'var(--pv-size)', background: 'var(--pv-panel-2)' }}
      >
        <PreviewArea
          areaKey="rail"
          active={active}
          surfaces={surfaces}
          resolved={resolved}
          className="theme-pv-rail"
          onPick={onPickArea}
          label="Servidores"
        >
          <span className="theme-pv-srv is-home" style={{ background: 'var(--pv-accent)' }}>
            {brandInitials}
          </span>
          <i className="theme-pv-sep" style={{ background: 'var(--pv-line)' }} />
          <span className="theme-pv-srv" style={{ background: 'var(--pv-card)' }}>
            A
          </span>
          <span className="theme-pv-srv is-on" style={{ background: 'var(--pv-card)', boxShadow: '0 0 0 2px var(--pv-accent)' }}>
            B
          </span>
          <span className="theme-pv-srv" style={{ background: 'var(--pv-card)' }}>
            +
          </span>
        </PreviewArea>

        <PreviewArea
          areaKey="sidebar"
          active={active}
          surfaces={surfaces}
          resolved={resolved}
          className="theme-pv-side"
          onPick={onPickArea}
          label="Canais"
        >
          <div className="theme-pv-side-head">
            <strong>Escritório</strong>
            <small style={{ color: 'var(--pv-local-muted, var(--pv-muted))' }}>{brandShort}</small>
          </div>
          <div className="theme-pv-ch-list">
            <span className="theme-pv-ch is-cat" style={{ color: 'var(--pv-local-muted, var(--pv-muted))' }}>
              Texto
            </span>
            <span className="theme-pv-ch is-active" style={{ background: 'color-mix(in srgb, var(--pv-accent) 22%, transparent)' }}>
              # geral
            </span>
            <span className="theme-pv-ch" style={{ color: 'var(--pv-local-muted, var(--pv-muted))' }}>
              # avisos
            </span>
            <span className="theme-pv-ch is-cat" style={{ color: 'var(--pv-local-muted, var(--pv-muted))' }}>
              Voz
            </span>
            <span className="theme-pv-ch" style={{ color: 'var(--pv-local-muted, var(--pv-muted))' }}>
              🔊 reunião
            </span>
          </div>
          <div
            className="theme-pv-userbar"
            style={{ background: 'var(--pv-panel)', borderColor: 'var(--pv-line)' }}
          >
            <span className="theme-pv-avatar" style={{ background: 'var(--pv-accent)' }} />
            <div>
              <b>Você</b>
              <small style={{ color: 'var(--pv-success)' }}>Online</small>
            </div>
          </div>
        </PreviewArea>

        <div className="theme-pv-center">
          <PreviewArea
            areaKey="chat"
            active={active}
            surfaces={surfaces}
            resolved={resolved}
            className="theme-pv-chat"
            onPick={onPickArea}
            label="Centro"
          >
            <header className="theme-pv-chat-head" style={{ borderColor: 'var(--pv-line)' }}>
              <strong># geral</strong>
              <em style={{ color: 'var(--pv-local-muted, var(--pv-muted))' }}>Canal de texto</em>
            </header>
            <div className="theme-pv-msgs">
              <div className="theme-pv-msg">
                <span className="theme-pv-avatar sm" style={{ background: 'var(--pv-card)' }} />
                <div>
                  <b>Alex</b>{' '}
                  <time style={{ color: 'var(--pv-local-muted, var(--pv-muted))' }}>agora</time>
                  <p>
                    Olá! Esta é a prévia do tema.{' '}
                    <a href="#preview" style={{ color: 'var(--pv-link)' }} onClick={(e) => e.preventDefault()}>
                      Link
                    </a>
                  </p>
                </div>
              </div>
              <div className="theme-pv-msg">
                <span className="theme-pv-avatar sm" style={{ background: 'var(--pv-accent)' }} />
                <div>
                  <b>Maria</b>{' '}
                  <time style={{ color: 'var(--pv-local-muted, var(--pv-muted))' }}>1m</time>
                  <p style={{ color: 'var(--pv-local-muted, var(--pv-muted))' }}>
                    Cores, bordas e tipografia aparecem aqui.
                  </p>
                </div>
              </div>
            </div>
            <div
              className="theme-pv-composer"
              style={{ background: 'var(--pv-input)', borderColor: 'var(--pv-line)' }}
            >
              Mensagem #geral
            </div>
          </PreviewArea>

          <PreviewArea
            areaKey="stage"
            active={active}
            surfaces={surfaces}
            resolved={resolved}
            className="theme-pv-stage"
            onPick={onPickArea}
            label="Palco"
          >
            <div className="theme-pv-tiles">
              <span style={{ background: 'var(--pv-card)', borderColor: 'var(--pv-line)' }}>Você</span>
              <span style={{ background: 'var(--pv-card)', borderColor: 'var(--pv-line)' }}>Alex</span>
              <span style={{ background: 'color-mix(in srgb, var(--pv-accent) 35%, var(--pv-card))', borderColor: 'var(--pv-accent)' }}>
                Live
              </span>
            </div>
          </PreviewArea>
        </div>

        <PreviewArea
          areaKey="members"
          active={active}
          surfaces={surfaces}
          resolved={resolved}
          className="theme-pv-members"
          onPick={onPickArea}
          label="Membros"
        >
          <strong>Membros — 3</strong>
          <small style={{ color: 'var(--pv-success)' }}>Online</small>
          <div className="theme-pv-member" style={{ background: 'var(--pv-card)', borderColor: 'var(--pv-line)' }}>
            <span className="theme-pv-avatar sm" style={{ background: 'var(--pv-accent)' }} />
            <div>
              <b>Você</b>
              <em style={{ color: 'var(--pv-local-muted, var(--pv-muted))' }}>Admin</em>
            </div>
          </div>
          <div className="theme-pv-member" style={{ background: 'var(--pv-card)', borderColor: 'var(--pv-line)' }}>
            <span className="theme-pv-avatar sm" style={{ background: 'var(--pv-card)' }} />
            <div>
              <b>Alex</b>
              <em style={{ color: 'var(--pv-local-muted, var(--pv-muted))' }}>♪ ouvindo…</em>
            </div>
          </div>
        </PreviewArea>
      </div>
    </div>
  );
}

export function ThemeSettingsDialog({
  open,
  onClose,
  premium,
  currentTheme,
  previewRoot,
  onSaved,
}: Props) {
  const [surfaces, setSurfaces] = useState<Partial<Record<SurfaceKey, SurfaceCfg>>>({});
  const [chrome, setChrome] = useState<ThemeChrome>({ contrast: 'auto' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState<SurfaceKey>('rail');
  const [tab, setTab] = useState<Tab>('areas');
  const [colorGroup, setColorGroup] = useState<'base' | 'surfaces' | 'feedback'>('base');
  const snapRef = useRef<ThemeState | null>(null);

  useEffect(() => {
    if (!open) return;
    setError('');
    setTab('areas');
    api<{ surfaces: ThemeState['surfaces']; chrome: ThemeChrome }>('/api/community/themes/me')
      .then((d) => {
        const next = {
          surfaces: d.surfaces || {},
          chrome: { contrast: 'auto' as const, ...(d.chrome || {}) },
        };
        setSurfaces(next.surfaces);
        setChrome(next.chrome);
        snapRef.current = currentTheme || next;
      })
      .catch((e) => setError(e.message));
  }, [open, currentTheme]);

  const draft = useMemo(
    () => ({ surfaces, chrome: resolveChrome(chrome, surfaces) }),
    [surfaces, chrome],
  );

  // Prévia real na comunidade enquanto edita
  useEffect(() => {
    if (!open || !premium) return;
    const root = previewRoot || (document.querySelector('.comm') as HTMLElement | null);
    applyThemeState(root, draft);
  }, [open, premium, draft, previewRoot]);

  function patchActive(partial: SurfaceCfg) {
    setSurfaces((prev) => ({
      ...prev,
      [active]: { ...(prev[active] || {}), ...partial },
    }));
  }

  function patchChrome(partial: ThemeChrome) {
    setChrome((prev) => {
      const next = { ...prev, ...partial };
      if ((next.contrast || 'auto') === 'auto' && (partial.panel || partial.contrast === 'auto')) {
        const base =
          next.panel ||
          surfaces.chat?.color ||
          surfaces.sidebar?.color ||
          '#1a1d24';
        const auto = autoText(base);
        next.text = auto.text;
        next.muted = auto.muted;
        next.link = auto.link;
      }
      return next;
    });
  }

  function handleClose() {
    const root = previewRoot || (document.querySelector('.comm') as HTMLElement | null);
    applyThemeState(root, snapRef.current || currentTheme || { surfaces: {}, chrome: {} });
    onClose();
  }

  async function upload(file: File) {
    setBusy(true);
    setError('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/community/themes/media', {
        method: 'POST',
        credentials: 'include',
        body: fd,
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        url?: string;
        media_kind?: string;
        error?: string;
        message?: string;
      };
      if (!res.ok || data.ok === false) {
        throw new Error(data.message || data.error || 'upload_failed');
      }
      patchActive({
        media_url: data.url,
        media_kind: data.media_kind || 'image',
        opacity: surfaces[active]?.opacity ?? 0.35,
        blur: surfaces[active]?.blur ?? 12,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha no upload');
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    setError('');
    try {
      const nextChrome = resolveChrome(chrome, surfaces);
      const d = await api<{ surfaces: ThemeState['surfaces']; chrome: ThemeChrome }>(
        '/api/community/themes/me',
        { method: 'PUT', body: JSON.stringify({ surfaces, chrome: nextChrome }) },
      );
      const saved = {
        surfaces: d.surfaces || surfaces,
        chrome: d.chrome || nextChrome,
      };
      snapRef.current = saved;
      onSaved?.(saved);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao salvar');
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    if (!confirm('Restaurar o tema padrão em todas as áreas?')) return;
    setBusy(true);
    setError('');
    try {
      await api('/api/community/themes/me', { method: 'DELETE' });
      const empty = { surfaces: {}, chrome: { contrast: 'auto' as const } };
      setSurfaces({});
      setChrome({ contrast: 'auto' });
      snapRef.current = empty;
      onSaved?.(empty);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao resetar');
    } finally {
      setBusy(false);
    }
  }

  const cur = surfaces[active] || {};
  const activeMeta = SURFACES.find((s) => s.key === active)!;
  const contrastLocked = (chrome.contrast || 'auto') !== 'auto';

  return (
    <NativeDialog open={open} onClose={handleClose} className="comm-dialog comm-theme-dialog">
      <form
        className="comm-dialog-form theme-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (premium) void save();
        }}
      >
        <h2>Personalizar aparência</h2>
        <p className="comm-dialog-hint">
          Prévia em tempo real da comunidade. Clique numa coluna para editar o fundo dela, ou use
          um preset e ajuste os detalhes.
        </p>

        {!premium ? (
          <p className="muted">Peça ao super admin para liberar o recurso premium de temas.</p>
        ) : (
          <div className="theme-layout">
            <div className="theme-layout-preview">
              <ThemeLivePreview
                surfaces={surfaces}
                chrome={chrome}
                active={active}
                onPickArea={(k) => {
                  setActive(k);
                  setTab('areas');
                }}
              />
            </div>

            <div className="theme-layout-controls">
              <div className="theme-presets">
                <span className="theme-presets-label">Começar com</span>
                <div className="theme-presets-row">
                  {QUICK_PRESETS.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className="theme-preset-btn"
                      title={p.tip}
                      onClick={() => {
                        setChrome({ contrast: 'auto', ...p.chrome });
                        if (p.surfaces) setSurfaces(p.surfaces);
                      }}
                    >
                      <span
                        className="theme-preset-dots"
                        aria-hidden
                      >
                        <i style={{ background: p.chrome.accent }} />
                        <i style={{ background: p.chrome.panel }} />
                        <i style={{ background: p.surfaces?.chat?.color || p.chrome.card }} />
                      </span>
                      <strong>{p.label}</strong>
                      <em>{p.tip}</em>
                    </button>
                  ))}
                </div>
              </div>

            <div className="theme-seg" role="tablist">
              {(
                [
                  ['areas', 'Áreas'],
                  ['colors', 'Cores'],
                  ['type', 'Fonte'],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={tab === id}
                  className={tab === id ? 'is-on' : undefined}
                  onClick={() => setTab(id)}
                >
                  {label}
                </button>
              ))}
            </div>

            {tab === 'areas' ? (
              <div className="theme-pane">
                <div className="theme-area-pills">
                  {SURFACES.map((s) => (
                    <button
                      key={s.key}
                      type="button"
                      className={active === s.key ? 'is-on' : undefined}
                      onClick={() => setActive(s.key)}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>

                <div className="theme-area-editor">
                  <div className="theme-area-editor-head">
                    <h3>{activeMeta.label}</h3>
                    <p className="muted">{activeMeta.tip} — mídia fica só nesta coluna</p>
                  </div>

                  <div className="theme-field">
                    <div className="theme-field-copy">
                      <strong>Painel flutuante</strong>
                      <span>Cantos arredondados + sombra nesta área</span>
                    </div>
                    <button
                      type="button"
                      className={`theme-toggle${cur.floating ? ' is-on' : ''}`}
                      aria-pressed={!!cur.floating}
                      onClick={() => {
                        const nextOn = !cur.floating;
                        if (nextOn) {
                          patchActive({ floating: true });
                        } else {
                          // Remove a flag (não deixa floating:false sob ui_style legado)
                          setSurfaces((prev) => {
                            const curCfg = { ...(prev[active] || {}) };
                            delete curCfg.floating;
                            return { ...prev, [active]: curCfg };
                          });
                          if (chrome.ui_style === 'floating') {
                            patchChrome({ ui_style: 'default' });
                          }
                        }
                      }}
                    >
                      {cur.floating ? 'Ligado' : 'Desligado'}
                    </button>
                  </div>

                  <ColorField
                    label="Cor de fundo"
                    hint="Base sólida desta área"
                    value={cur.color}
                    fallback="#1a1d24"
                    swatches={BG_SWATCHES}
                    onChange={(v) => patchActive({ color: v })}
                  />

                  <div className="theme-field theme-field-stack">
                    <div className="theme-field-copy">
                      <strong>Imagem / gif / vídeo</strong>
                      <span>Opcional · até 10 MB · contida nesta área</span>
                    </div>
                    <label className="theme-upload">
                      <input
                        type="file"
                        accept="image/*,video/mp4,video/webm,.gif,.webp"
                        disabled={busy}
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) void upload(f);
                          e.target.value = '';
                        }}
                      />
                      <span>{busy ? 'Enviando…' : 'Escolher arquivo'}</span>
                    </label>
                  </div>

                  <div className="theme-sliders">
                    <div className="theme-field">
                      <div className="theme-field-copy">
                        <strong>Desfoque</strong>
                        <span>{cur.blur ?? 12}px</span>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={40}
                        value={cur.blur ?? 12}
                        onChange={(e) => patchActive({ blur: Number(e.target.value) })}
                      />
                    </div>
                    <div className="theme-field">
                      <div className="theme-field-copy">
                        <strong>Opacidade</strong>
                        <span>{Math.round((cur.opacity ?? 0.35) * 100)}%</span>
                      </div>
                      <input
                        type="range"
                        min={5}
                        max={100}
                        value={Math.round((cur.opacity ?? 0.35) * 100)}
                        onChange={(e) => patchActive({ opacity: Number(e.target.value) / 100 })}
                      />
                    </div>
                  </div>

                  {cur.media_url ? (
                    <div className="theme-media-preview">
                      {cur.media_kind === 'mp4' || cur.media_kind === 'webm' ? (
                        <video src={cur.media_url} muted loop autoPlay playsInline />
                      ) : (
                        <img src={cur.media_url} alt="" />
                      )}
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() =>
                          setSurfaces((prev) => ({
                            ...prev,
                            [active]: { ...prev[active], media_url: '', media_kind: '' },
                          }))
                        }
                      >
                        Remover mídia
                      </button>
                    </div>
                  ) : null}

                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() =>
                      setSurfaces((prev) => {
                        const next = { ...prev };
                        delete next[active];
                        return next;
                      })
                    }
                  >
                    Limpar esta área
                  </button>
                </div>
              </div>
            ) : null}

            {tab === 'colors' ? (
              <div className="theme-pane">
                <div className="theme-field theme-field-stack">
                  <div className="theme-field-copy">
                    <strong>Contraste do texto</strong>
                    <span>Automático ajusta texto em cada área conforme o fundo</span>
                  </div>
                  <div className="theme-contrast-row">
                    {(
                      [
                        ['auto', 'Automático'],
                        ['dark', 'Texto claro'],
                        ['light', 'Texto escuro'],
                      ] as const
                    ).map(([id, label]) => (
                      <button
                        key={id}
                        type="button"
                        className={(chrome.contrast || 'auto') === id ? 'is-on' : undefined}
                        onClick={() => {
                          if (id === 'auto') {
                            const base = chrome.panel || '#1a1d24';
                            const auto = autoText(base);
                            patchChrome({
                              contrast: 'auto',
                              text: auto.text,
                              muted: auto.muted,
                              link: auto.link,
                            });
                          } else if (id === 'dark') {
                            patchChrome({
                              contrast: 'dark',
                              text: '#f1f5f9',
                              muted: '#94a3b8',
                              link: '#93c5fd',
                            });
                          } else {
                            patchChrome({
                              contrast: 'light',
                              text: '#0f172a',
                              muted: '#475569',
                              link: '#1d4ed8',
                            });
                          }
                        }}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="theme-field theme-field-stack">
                  <div className="theme-field-copy">
                    <strong>Atalho: flutuante em todas as barras</strong>
                    <span>Servidores, canais, chat, membros e cabeçalho</span>
                  </div>
                  <div className="theme-contrast-row">
                    <button
                      type="button"
                      className={
                        ['header', 'rail', 'sidebar', 'chat', 'members'].every(
                          (k) => surfaces[k as SurfaceKey]?.floating,
                        )
                          ? 'is-on'
                          : undefined
                      }
                      onClick={() => {
                        setSurfaces((prev) => {
                          const next = { ...prev };
                          for (const k of ['header', 'rail', 'sidebar', 'chat', 'members'] as SurfaceKey[]) {
                            next[k] = { ...(next[k] || {}), floating: true };
                          }
                          return next;
                        });
                        patchChrome({ ui_style: 'floating' });
                      }}
                    >
                      Ativar todas
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setSurfaces((prev) => {
                          const next = { ...prev };
                          for (const k of SURFACES.map((s) => s.key)) {
                            if (next[k]) {
                              const { floating: _f, ...rest } = next[k]!;
                              next[k] = rest;
                            }
                          }
                          return next;
                        });
                        patchChrome({ ui_style: 'default' });
                      }}
                    >
                      Desativar todas
                    </button>
                  </div>
                </div>

                <div className="theme-field theme-field-stack">
                  <div className="theme-field-copy">
                    <strong>Estilo legado (global)</strong>
                    <span>Preferível usar o interruptor por área em “Áreas”</span>
                  </div>
                  <div className="theme-contrast-row">
                    <button
                      type="button"
                      className={(chrome.ui_style || 'default') === 'default' && !['header', 'rail', 'sidebar', 'chat', 'members'].some((k) => surfaces[k as SurfaceKey]?.floating) ? 'is-on' : undefined}
                      onClick={() => {
                        setSurfaces((prev) => {
                          const next = { ...prev };
                          for (const k of SURFACES.map((s) => s.key)) {
                            if (next[k]?.floating) {
                              const { floating: _f, ...rest } = next[k]!;
                              next[k] = rest;
                            }
                          }
                          return next;
                        });
                        patchChrome({ ui_style: 'default' });
                      }}
                    >
                      Padrão
                    </button>
                    <button
                      type="button"
                      className={
                        chrome.ui_style === 'floating' ||
                        ['header', 'rail', 'sidebar', 'chat', 'members'].every(
                          (k) => surfaces[k as SurfaceKey]?.floating,
                        )
                          ? 'is-on'
                          : undefined
                      }
                      onClick={() => {
                        setSurfaces((prev) => {
                          const next = { ...prev };
                          for (const k of ['header', 'rail', 'sidebar', 'chat', 'members'] as SurfaceKey[]) {
                            next[k] = { ...(next[k] || {}), floating: true };
                          }
                          return next;
                        });
                        patchChrome({ ui_style: 'floating' });
                      }}
                    >
                      Todas flutuantes
                    </button>
                  </div>
                </div>

                <div className="theme-color-groups">
                  {(
                    [
                      ['base', 'Essenciais'],
                      ['surfaces', 'Painéis'],
                      ['feedback', 'Texto & status'],
                    ] as const
                  ).map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      className={colorGroup === id ? 'is-on' : undefined}
                      onClick={() => setColorGroup(id)}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                {colorGroup === 'base' ? (
                  <>
                    <ColorField
                      label="Destaque (accent)"
                      hint="Botões e estados ativos"
                      value={chrome.accent}
                      fallback="#5865f2"
                      swatches={ACCENT_SWATCHES}
                      onChange={(v) => patchChrome({ accent: v, accent_hover: v })}
                    />
                    <ColorField
                      label="Hover do destaque"
                      hint="Ao passar o mouse"
                      value={chrome.accent_hover}
                      fallback={chrome.accent || '#4752c4'}
                      swatches={ACCENT_SWATCHES}
                      onChange={(v) => patchChrome({ accent_hover: v })}
                    />
                    <ColorField
                      label="Bordas"
                      hint="Separadores e contornos"
                      value={chrome.line}
                      fallback="#2f333d"
                      swatches={BORDER_SWATCHES}
                      onChange={(v) => patchChrome({ line: v })}
                    />
                    <ColorField
                      label="Bordas fortes"
                      hint="Contornos em destaque"
                      value={chrome.line_strong}
                      fallback="#4b5563"
                      swatches={BORDER_SWATCHES}
                      onChange={(v) => patchChrome({ line_strong: v })}
                    />
                  </>
                ) : null}

                {colorGroup === 'surfaces' ? (
                  <>
                    <ColorField
                      label="Painel principal"
                      hint="Modais e caixas"
                      value={chrome.panel}
                      fallback="#1e2128"
                      swatches={BG_SWATCHES}
                      onChange={(v) => patchChrome({ panel: v })}
                    />
                    <ColorField
                      label="Painel alternativo"
                      hint="Faixas secundárias"
                      value={chrome.panel_2}
                      fallback="#161920"
                      swatches={BG_SWATCHES}
                      onChange={(v) => patchChrome({ panel_2: v })}
                    />
                    <ColorField
                      label="Cards"
                      hint="Servidores e chips"
                      value={chrome.card}
                      fallback="#252932"
                      swatches={BG_SWATCHES}
                      onChange={(v) => patchChrome({ card: v })}
                    />
                    <ColorField
                      label="Campo / input"
                      hint="Fundos de caixas de texto"
                      value={chrome.input}
                      fallback="#0f1218"
                      swatches={BG_SWATCHES}
                      onChange={(v) => patchChrome({ input: v })}
                    />
                    <ColorField
                      label="Borda do input"
                      hint="Contorno dos campos"
                      value={chrome.input_border}
                      fallback="#2f333d"
                      swatches={BORDER_SWATCHES}
                      onChange={(v) => patchChrome({ input_border: v })}
                    />
                  </>
                ) : null}

                {colorGroup === 'feedback' ? (
                  <>
                    <ColorField
                      label="Texto principal"
                      hint={contrastLocked ? 'Manual' : 'Pelo contraste automático'}
                      value={draft.chrome.text}
                      fallback="#f1f5f9"
                      onChange={(v) => patchChrome({ contrast: 'dark', text: v })}
                    />
                    <ColorField
                      label="Texto secundário"
                      hint="Dicas e metadados"
                      value={draft.chrome.muted}
                      fallback="#94a3b8"
                      onChange={(v) =>
                        patchChrome({
                          contrast: chrome.contrast === 'light' ? 'light' : 'dark',
                          muted: v,
                        })
                      }
                    />
                    <ColorField
                      label="Links"
                      hint="Textos clicáveis"
                      value={chrome.link || draft.chrome.link}
                      fallback="#93c5fd"
                      swatches={ACCENT_SWATCHES}
                      onChange={(v) => patchChrome({ link: v })}
                    />
                    <ColorField
                      label="Perigo"
                      hint="Erros e ações destrutivas"
                      value={chrome.danger}
                      fallback="#ef4444"
                      swatches={['#ef4444', '#dc2626', '#f97316', '#e11d48']}
                      onChange={(v) => patchChrome({ danger: v })}
                    />
                    <ColorField
                      label="Sucesso"
                      hint="Online e confirmações"
                      value={chrome.success}
                      fallback="#22c55e"
                      swatches={['#22c55e', '#16a34a', '#10b981', '#84cc16']}
                      onChange={(v) => patchChrome({ success: v })}
                    />
                  </>
                ) : null}
              </div>
            ) : null}

            {tab === 'type' ? (
              <div className="theme-pane">
                <div className="theme-field theme-field-stack">
                  <div className="theme-field-copy">
                    <strong>Família da fonte</strong>
                    <span>Veja o resultado na prévia acima</span>
                  </div>
                  <select
                    value={chrome.font_family || ''}
                    onChange={(e) => patchChrome({ font_family: e.target.value })}
                  >
                    {FONT_PRESETS.map((f) => (
                      <option key={f.id || 'default'} value={f.id}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                  <div className="theme-font-samples">
                    {FONT_PRESETS.filter((f) => f.id).map((f) => (
                      <button
                        key={f.id}
                        type="button"
                        className={chrome.font_family === f.id ? 'is-on' : undefined}
                        style={{ fontFamily: f.id }}
                        onClick={() => patchChrome({ font_family: f.id })}
                      >
                        Aa · {f.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="theme-field">
                  <div className="theme-field-copy">
                    <strong>Tamanho base</strong>
                    <span>{chrome.font_size || 14}px</span>
                  </div>
                  <input
                    type="range"
                    min={12}
                    max={18}
                    value={chrome.font_size || 14}
                    onChange={(e) => patchChrome({ font_size: Number(e.target.value) })}
                  />
                </div>
              </div>
            ) : null}
            </div>
          </div>
        )}

        {error ? <div className="error">{error}</div> : null}

        <div className="form-actions">
          <button type="button" className="btn" onClick={handleClose}>
            Cancelar
          </button>
          {premium ? (
            <>
              <button type="button" className="btn" disabled={busy} onClick={() => void reset()}>
                Restaurar padrão
              </button>
              <button type="submit" className="btn btn-primary" disabled={busy}>
                Salvar tema
              </button>
            </>
          ) : null}
        </div>
      </form>
    </NativeDialog>
  );
}

export function applyThemeState(root: HTMLElement | null, theme: ThemeState | null | undefined) {
  const surfaces = theme?.surfaces || {};
  const chrome = resolveChrome(theme?.chrome || {}, surfaces);

  const page = document.body;
  const set = (k: string, v?: string | number) => {
    if (v == null || v === '') page.style.removeProperty(k);
    else page.style.setProperty(k, String(v));
  };

  set('--comm-accent', chrome.accent);
  set('--comm-accent-hover', chrome.accent_hover || chrome.accent);
  set('--comm-text', chrome.text);
  set('--comm-muted', chrome.muted);
  set('--comm-link', chrome.link);
  set('--comm-line', chrome.line);
  set('--comm-line-strong', chrome.line_strong || chrome.line);
  set('--comm-panel', chrome.panel);
  set('--comm-panel-2', chrome.panel_2 || chrome.panel);
  set('--theme-card-bg', chrome.card || chrome.panel);
  set('--comm-input', chrome.input);
  set('--comm-input-border', chrome.input_border || chrome.line);
  set('--comm-danger', chrome.danger);
  set('--comm-success', chrome.success);

  // Alinha fundos legados (--comm-bg*) ao tema (input/userbar/compose usam estes)
  const panel = chrome.panel || '';
  const panel2 = chrome.panel_2 || panel;
  const card = chrome.card || panel;
  const inputBg = chrome.input || card;
  if (panel2) set('--comm-bg0', panel2);
  else page.style.removeProperty('--comm-bg0');
  if (panel) {
    set('--comm-bg1', panel);
    set('--comm-bg2', panel);
  } else {
    page.style.removeProperty('--comm-bg1');
    page.style.removeProperty('--comm-bg2');
  }
  if (inputBg) set('--comm-bg3', inputBg);
  else page.style.removeProperty('--comm-bg3');

  if (chrome.font_family) set('--font', chrome.font_family);
  else page.style.removeProperty('--font');
  if (chrome.font_size) set('--theme-font-size', `${chrome.font_size}px`);
  else page.style.removeProperty('--theme-font-size');

  const baseForClass =
    chrome.panel || surfaces.chat?.color || surfaces.sidebar?.color || '#1a1d24';
  const lightUi =
    (chrome.contrast || 'auto') === 'light' ||
    ((chrome.contrast || 'auto') === 'auto' && hexLum(baseForClass) > 0.48);
  page.classList.toggle('theme-contrast-light', lightUi);
  page.classList.toggle('theme-contrast-dark', !lightUi);
  // legado: ui_style floating NÃO força mais is-theme-float por cima do interruptor por área.
  // Só as flags surfaces[k].floating controlam o visual; ui_style vazio + sem flags = legado puro.
  const mainFloatKeys = ['header', 'rail', 'sidebar', 'chat', 'members'] as SurfaceKey[];
  const explicitFloatOn = mainFloatKeys.filter((k) => !!surfaces[k]?.floating);
  const explicitFloatOff = mainFloatKeys.some(
    (k) => surfaces[k] != null && surfaces[k]!.floating === false,
  );
  const legacyFloatAll =
    chrome.ui_style === 'floating' && explicitFloatOn.length === 0 && !explicitFloatOff;

  const floatKeys = new Set<SurfaceKey>(
    legacyFloatAll
      ? mainFloatKeys
      : (Object.entries(surfaces)
          .filter(([, s]) => !!s?.floating)
          .map(([k]) => k as SurfaceKey)),
  );

  const allMainFloating = mainFloatKeys.every((k) => floatKeys.has(k));
  page.classList.toggle('theme-ui-floating', legacyFloatAll || allMainFloating);
  page.classList.toggle('theme-has-float-panels', floatKeys.size > 0);

  for (const key of SURFACES.map((s) => s.key)) {
    // header fica fora de .comm — busca no documento inteiro
    const el = (root?.querySelector(`[data-theme-surface="${key}"]`) ||
      document.querySelector(`[data-theme-surface="${key}"]`)) as HTMLElement | null;
    if (!el) continue;
    el.style.removeProperty('--theme-bg-color');
    el.style.removeProperty('--theme-bg-image');
    el.style.removeProperty('--theme-media-blur');
    el.style.removeProperty('--theme-media-opacity');
    el.style.removeProperty('--comm-text');
    el.style.removeProperty('--comm-muted');
    el.classList.remove(
      'has-theme-media',
      'has-theme-video',
      'has-theme-color',
      'is-theme-float',
      'theme-surface-light',
      'theme-surface-dark',
    );
    const video = el.querySelector(':scope > .comm-theme-video-bg') as HTMLVideoElement | null;
    if (video) video.remove();
    const cfg = surfaces[key];
    const wantFloat = floatKeys.has(key);
    if (wantFloat) el.classList.add('is-theme-float');
    if (!cfg && !wantFloat) continue;

    if (cfg?.color) {
      el.style.setProperty('--theme-bg-color', cfg.color);
      el.classList.add('has-theme-color');
    }

    if ((chrome.contrast || 'auto') === 'auto') {
      const sample = cfg?.color || chrome.panel || '#1a1d24';
      const a = autoText(sample);
      el.style.setProperty('--comm-text', a.text);
      el.style.setProperty('--comm-muted', a.muted);
      el.classList.toggle('theme-surface-light', hexLum(sample) > 0.42);
      el.classList.toggle('theme-surface-dark', hexLum(sample) <= 0.42);
    }

    if (!cfg) continue;
    el.style.setProperty('--theme-media-blur', `${cfg.blur ?? 12}px`);
    el.style.setProperty('--theme-media-opacity', String(cfg.opacity ?? 0.35));
    if (cfg.media_url) {
      if (cfg.media_kind === 'mp4' || cfg.media_kind === 'webm') {
        const v = document.createElement('video');
        v.className = 'comm-theme-video-bg';
        v.src = cfg.media_url;
        v.muted = true;
        v.loop = true;
        v.autoplay = true;
        v.playsInline = true;
        el.prepend(v);
        el.classList.add('has-theme-media', 'has-theme-video');
      } else {
        el.style.setProperty('--theme-bg-image', `url("${cfg.media_url}")`);
        el.classList.add('has-theme-media');
      }
    }
  }
}

export function applyThemeSurfaces(
  root: HTMLElement | null,
  surfaces: ThemeState['surfaces'] | null | undefined,
) {
  applyThemeState(root, { surfaces: surfaces || {}, chrome: {} });
}
