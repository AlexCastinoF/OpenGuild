import {
  CSSProperties,
  FormEvent,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  Bell,
  Headphones,
  Image,
  Mail,
  Monitor,
  MonitorUp,
  Palette,
  Save,
  Shield,
  Upload,
  UserRound,
  X,
} from 'lucide-react';
import { PERMISSION_GROUPS } from '@steamfarm/shared';
import { api } from '../lib/api';
import { pushNotifyNow, requestNotifyPermission } from '../lib/commNotify';
import { useBrandStore } from '../store/brand';
import type { AudioDevicePrefs } from './AudioSettingsDialog';
import {
  normalizeAudioPrefs,
  saveAudioPrefs,
  VoiceFilterControls,
  type NoiseEngine,
} from './AudioSettingsDialog';
import { NativeDialog } from './NativeDialog';
import { MemberShowcaseGrid } from './ItemDetailDialog';
import type { SkinItem } from './SkinPickItem';

export { NativeDialog } from './NativeDialog';
export { ProfileEditDialog as ProfileDialog, type ProfileTab } from './ProfileEditDialog';

async function uploadMedia(file: File, kind: string) {
  const fd = new FormData();
  fd.append('kind', kind);
  fd.append('file', file);
  const res = await fetch('/api/community/media', {
    method: 'POST',
    credentials: 'include',
    body: fd,
  });
  const data = (await res.json()) as { ok?: boolean; url?: string; error?: string };
  if (!res.ok || data.ok === false || !data.url) throw new Error(data.error || 'upload_failed');
  return data.url;
}

export function CreateServerDialog({
  open,
  onClose,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  return (
    <NativeDialog open={open} onClose={onClose}>
      <form
        className="comm-dialog-form"
        onSubmit={(e) => {
          e.preventDefault();
          void onSubmit(name)
            .then(() => {
              setName('');
              onClose();
            })
            .catch((err) => setError(err.message));
        }}
      >
        <h2>Criar servidor</h2>
        <label>
          Nome
          <input
            type="text"
            maxLength={80}
            required
            placeholder="Ex.: Farm noturno"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </label>
        {error ? <p className="comm-dialog-hint" style={{ color: 'var(--comm-danger)' }}>{error}</p> : null}
        <div className="form-actions">
          <button type="submit" className="btn btn-primary">
            Criar
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
        </div>
      </form>
    </NativeDialog>
  );
}

export function JoinInviteDialog({
  open,
  onClose,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (code: string) => Promise<void>;
}) {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  return (
    <NativeDialog open={open} onClose={onClose}>
      <form
        className="comm-dialog-form"
        onSubmit={(e) => {
          e.preventDefault();
          void onSubmit(code)
            .then(() => {
              setCode('');
              onClose();
            })
            .catch((err) => setError(err.message));
        }}
      >
        <h2>Entrar com convite</h2>
        <label>
          Link ou código
          <input
            type="text"
            maxLength={256}
            required
            placeholder="Cole o link ou código do convite"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoFocus
          />
        </label>
        {error ? <p className="comm-dialog-hint" style={{ color: 'var(--comm-danger)' }}>{error}</p> : null}
        <div className="form-actions">
          <button type="submit" className="btn btn-primary">
            Entrar
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
        </div>
      </form>
    </NativeDialog>
  );
}

export function CreateChannelDialog({
  open,
  onClose,
  serverId,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  serverId: number;
  onDone: () => void;
}) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState('text');
  const [error, setError] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    try {
      await api(`/api/community/servers/${serverId}/channels`, {
        method: 'POST',
        body: JSON.stringify({ name, kind }),
      });
      setName('');
      onDone();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro');
    }
  }

  return (
    <NativeDialog open={open} onClose={onClose}>
      <form className="comm-dialog-form" onSubmit={(e) => void submit(e)}>
        <h2>Novo canal</h2>
        <label>
          Nome
          <input type="text" maxLength={64} required value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </label>
        <label>
          Tipo
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="text">Texto</option>
            <option value="voice">Voz</option>
            <option value="screen">Tela (voz + compartilhar)</option>
          </select>
        </label>
        {error ? <p className="comm-dialog-hint" style={{ color: 'var(--comm-danger)' }}>{error}</p> : null}
        <div className="form-actions">
          <button type="submit" className="btn btn-primary">
            Criar
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
        </div>
      </form>
    </NativeDialog>
  );
}

export function ChannelSettingsDialog({
  open,
  onClose,
  channel,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  channel: { id: number; name: string; icon_url?: string } | null;
  onDone: () => void;
}) {
  const [name, setName] = useState('');
  const [iconUrl, setIconUrl] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (channel) {
      setName(channel.name);
      setIconUrl(channel.icon_url || '');
    }
  }, [channel]);

  if (!channel) return null;

  async function save(e: FormEvent) {
    e.preventDefault();
    try {
      await api(`/api/community/channels/${channel!.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name, icon_url: iconUrl }),
      });
      onDone();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro');
    }
  }

  async function remove() {
    if (!channel) return;
    if (!confirm('Excluir canal? Esta ação remove todas as mensagens.')) return;
    await api(`/api/community/channels/${channel.id}`, { method: 'DELETE' });
    onDone();
    onClose();
  }

  return (
    <NativeDialog open={open} onClose={onClose}>
      <form className="comm-dialog-form" onSubmit={(e) => void save(e)}>
        <h2>Canal</h2>
        <label>
          Nome
          <input type="text" maxLength={64} required value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="comm-upload-row">
          <label>
            Ícone
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void uploadMedia(f, 'channel').then(setIconUrl).catch((err) => setError(err.message));
              }}
            />
          </label>
          <label>
            ou URL
            <input
              type="text"
              inputMode="url"
              placeholder="https://… ou arquivo enviado"
              value={iconUrl}
              onChange={(e) => setIconUrl(e.target.value)}
            />
          </label>
          {iconUrl ? (
            <img className="comm-upload-preview" src={iconUrl} alt="" referrerPolicy="no-referrer" />
          ) : null}
        </div>
        <p className="comm-dialog-note muted">GIF animado permitido. Deixe vazio para o padrão (# / voz / tela).</p>
        <div className="comm-channel-danger">
          <button type="button" className="btn btn-danger" onClick={() => void remove()}>
            Excluir canal
          </button>
          <p className="muted comm-dialog-note">Esta ação é permanente e remove todas as mensagens do canal.</p>
        </div>
        {error ? <p className="comm-dialog-hint" style={{ color: 'var(--comm-danger)' }}>{error}</p> : null}
        <div className="form-actions">
          <button type="submit" className="btn btn-primary">
            Salvar
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
        </div>
      </form>
    </NativeDialog>
  );
}

export function InviteDialog({
  open,
  onClose,
  url,
  code,
}: {
  open: boolean;
  onClose: () => void;
  url: string;
  code: string;
}) {
  const value = url || code;
  return (
    <NativeDialog open={open} onClose={onClose}>
      <form className="comm-dialog-form" onSubmit={(e) => e.preventDefault()}>
        <h2>Convidar pessoas</h2>
        <p className="comm-dialog-hint">
          Compartilhe o link abaixo. Quem estiver logado verá um convite para entrar; quem não estiver poderá entrar ou
          criar conta.
        </p>
        <label>
          Link do convite
          <input type="url" readOnly value={value} onFocus={(e) => e.target.select()} />
        </label>
        <div className="form-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void navigator.clipboard.writeText(value)}
          >
            Copiar link
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Fechar
          </button>
        </div>
      </form>
    </NativeDialog>
  );
}

type Role = {
  id: number;
  name: string;
  color: string;
  permissions: string[] | unknown;
  is_default?: boolean;
  hoist?: boolean;
  member_card_color?: string | null;
  border_color?: string | null;
  border_effect?: string | null;
  border_motion?: string | null;
};

export function ServerSettingsDialog({
  open,
  onClose,
  serverId,
  initial,
  canManageRoles,
  members = [],
  initialTab = 'appearance',
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  serverId: number;
  initial: {
    name: string;
    description: string;
    is_listed: boolean;
    icon_url: string;
    banner_url: string;
  };
  canManageRoles: boolean;
  members?: Array<{ id: number; label: string; role: string }>;
  initialTab?: 'appearance' | 'roles';
  onDone: () => void;
}) {
  const [tab, setTab] = useState<'appearance' | 'roles'>(initialTab);
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [listed, setListed] = useState(initial.is_listed);
  const [iconUrl, setIconUrl] = useState(initial.icon_url);
  const [bannerUrl, setBannerUrl] = useState(initial.banner_url);
  const [error, setError] = useState('');
  const [roles, setRoles] = useState<Role[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [roleName, setRoleName] = useState('');
  const [roleColor, setRoleColor] = useState('#949ba4');
  const [cardColor, setCardColor] = useState('#5865f2');
  const [borderColor, setBorderColor] = useState('#949ba4');
  const [borderEffect, setBorderEffect] = useState('solid');
  const [borderMotion, setBorderMotion] = useState('none');
  const [hoist, setHoist] = useState(false);
  const [perms, setPerms] = useState<string[]>([]);
  const [assignUserId, setAssignUserId] = useState<number | ''>('');
  const [assignRoleIds, setAssignRoleIds] = useState<number[]>([]);
  const wasOpen = useRef(false);

  // Só reseta abas/campos ao ABRIR o modal — `initial` muda a cada refetch do parent.
  useEffect(() => {
    if (open && !wasOpen.current) {
      setTab(canManageRoles ? initialTab : 'appearance');
      setName(initial.name);
      setDescription(initial.description);
      setListed(initial.is_listed);
      setIconUrl(initial.icon_url);
      setBannerUrl(initial.banner_url);
      setError('');
      setSelectedId(null);
      setAssignUserId('');
      setAssignRoleIds([]);
    }
    wasOpen.current = open;
  }, [open, initial, initialTab, canManageRoles]);

  async function loadRoles() {
    const d = await api<{ roles: Role[] }>(`/api/community/servers/${serverId}/roles`);
    setRoles(d.roles);
    if (d.roles[0] && !selectedId) selectRole(d.roles[0]);
  }

  function selectRole(r: Role) {
    setSelectedId(r.id);
    setRoleName(r.name);
    setRoleColor(r.color || '#949ba4');
    setCardColor(r.member_card_color || '#5865f2');
    setBorderColor(r.border_color || r.color || '#949ba4');
    setBorderEffect(r.border_effect || 'solid');
    setBorderMotion(r.border_motion || 'none');
    setHoist(!!r.hoist);
    setPerms(Array.isArray(r.permissions) ? (r.permissions as string[]) : []);
  }

  useEffect(() => {
    if (open && tab === 'roles' && canManageRoles) {
      void loadRoles().catch((e) => setError(e.message));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tab, serverId, canManageRoles]);

  async function saveAppearance(e: FormEvent) {
    e.preventDefault();
    setError('');
    try {
      await api(`/api/community/servers/${serverId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name,
          description,
          is_listed: listed,
          icon_url: iconUrl,
          banner_url: bannerUrl,
        }),
      });
      onDone();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro');
    }
  }

  return (
    <NativeDialog open={open} onClose={onClose} className="comm-dialog comm-dialog-server-settings">
      <div className="comm-server-settings" onClick={(e) => e.stopPropagation()}>
        <header className="comm-server-settings-head">
          <div className="comm-server-settings-head-text">
            <h2>Configurações do servidor</h2>
            <p className="muted">Personalize a aparência, descoberta pública e cargos com permissões.</p>
          </div>
          <button type="button" className="comm-dialog-x" onClick={onClose} aria-label="Fechar">
            <X size={18} />
          </button>
        </header>

        <nav className="comm-settings-tabs comm-server-settings-tabs" role="tablist">
          <button
            type="button"
            className={`comm-settings-tab${tab === 'appearance' ? ' is-on' : ''}`}
            role="tab"
            onClick={() => setTab('appearance')}
          >
            <Palette size={16} /> Aparência
          </button>
          {canManageRoles ? (
            <button
              type="button"
              className={`comm-settings-tab${tab === 'roles' ? ' is-on' : ''}`}
              role="tab"
              onClick={() => setTab('roles')}
            >
              <Shield size={16} /> Cargos e permissões
            </button>
          ) : null}
        </nav>

        <div className="comm-server-settings-body">
          {tab === 'appearance' ? (
            <form className="comm-settings-panel comm-server-appearance" onSubmit={(e) => void saveAppearance(e)}>
              <div className="comm-server-appearance-grid">
                <div className="comm-server-appearance-fields">
                  <label className="comm-field">
                    <span className="comm-field-label">Nome do servidor</span>
                    <input
                      type="text"
                      maxLength={80}
                      required
                      placeholder="Ex.: Equipe Comercial"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                    />
                  </label>
                  <label className="comm-field">
                    <span className="comm-field-label">Descrição (página Descobrir)</span>
                    <textarea
                      maxLength={500}
                      rows={3}
                      placeholder="Conte sobre o servidor…"
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                    />
                  </label>
                  <label className="comm-check comm-server-listed">
                    <input type="checkbox" checked={listed} onChange={(e) => setListed(e.target.checked)} />
                    <span>
                      Aparecer na página <strong>Descobrir</strong> e aceitar solicitações de entrada
                    </span>
                  </label>
                  <div className="comm-server-media-grid">
                    <section className="comm-server-media-card">
                      <h3 className="comm-field-label">
                        <Image size={14} /> Ícone
                      </h3>
                      <div className="comm-server-media-inputs">
                        <label className="comm-file-btn">
                          <input
                            type="file"
                            accept="image/jpeg,image/png,image/webp,image/gif"
                            hidden
                            onChange={(e) => {
                              const f = e.target.files?.[0];
                              if (f)
                                void uploadMedia(f, 'icon')
                                  .then(setIconUrl)
                                  .catch((err) => setError(err.message));
                            }}
                          />
                          <Upload size={14} /> Enviar arquivo
                        </label>
                        <label className="comm-field comm-field-inline">
                          <span className="comm-field-label">ou URL</span>
                          <input
                            type="text"
                            inputMode="url"
                            placeholder="https://… ou arquivo enviado"
                            value={iconUrl}
                            onChange={(e) => setIconUrl(e.target.value)}
                          />
                        </label>
                      </div>
                      <p className="comm-dialog-note muted">Quadrado · até 3 MB · JPG, PNG, WEBP ou GIF</p>
                    </section>
                    <section className="comm-server-media-card">
                      <h3 className="comm-field-label">Banner</h3>
                      <div className="comm-server-media-inputs">
                        <label className="comm-file-btn">
                          <input
                            type="file"
                            accept="image/jpeg,image/png,image/webp,image/gif"
                            hidden
                            onChange={(e) => {
                              const f = e.target.files?.[0];
                              if (f)
                                void uploadMedia(f, 'banner')
                                  .then(setBannerUrl)
                                  .catch((err) => setError(err.message));
                            }}
                          />
                          <Upload size={14} /> Enviar arquivo
                        </label>
                        <label className="comm-field comm-field-inline">
                          <span className="comm-field-label">ou URL</span>
                          <input
                            type="text"
                            inputMode="url"
                            placeholder="https://… ou arquivo enviado"
                            value={bannerUrl}
                            onChange={(e) => setBannerUrl(e.target.value)}
                          />
                        </label>
                      </div>
                      <p className="comm-dialog-note muted">Recomendado ~960×240 · até 5 MB</p>
                    </section>
                  </div>
                </div>
                <aside className="comm-server-preview-card" aria-label="Pré-visualização">
                  <p className="comm-field-label">Pré-visualização</p>
                  <div className="comm-server-preview-mock">
                    <div
                      className={`comm-server-preview-banner${bannerUrl ? ' has-image' : ''}`}
                      style={bannerUrl ? { backgroundImage: `url(${bannerUrl})` } : undefined}
                    >
                      {!bannerUrl ? <span className="muted">Banner do servidor</span> : null}
                    </div>
                    <div className="comm-server-preview-meta">
                      {iconUrl ? (
                        <img className="comm-server-preview-icon" src={iconUrl} alt="" />
                      ) : (
                        <div className="comm-server-preview-icon comm-server-preview-icon-ph">
                          {name.slice(0, 1) || 'S'}
                        </div>
                      )}
                      <div>
                        <strong>{name || 'Nome do servidor'}</strong>
                        <p className="muted">{description || 'Descrição aparece aqui…'}</p>
                      </div>
                    </div>
                  </div>
                </aside>
              </div>
              {error ? <p className="comm-dialog-hint" style={{ color: 'var(--comm-danger)' }}>{error}</p> : null}
              <div className="form-actions comm-server-settings-actions">
                <button type="submit" className="btn btn-primary">
                  <Save size={14} /> Salvar aparência
                </button>
                <button type="button" className="btn" onClick={onClose}>
                  Cancelar
                </button>
              </div>
            </form>
          ) : (
            <div className="comm-settings-panel comm-roles-panel">
              <div className="comm-roles-layout">
                <aside className="comm-roles-list-wrap">
                  <div className="comm-roles-list-head">
                    <span className="comm-label">Cargos do servidor</span>
                    <button
                      type="button"
                      className="btn btn-sm btn-primary"
                      onClick={() =>
                        void api(`/api/community/servers/${serverId}/roles`, {
                          method: 'POST',
                          body: JSON.stringify({ name: 'Novo cargo', color: '#5865f2', permissions: [] }),
                        }).then(() => loadRoles())
                      }
                    >
                      + Novo
                    </button>
                  </div>
                  <ul className="comm-roles-list">
                    {roles.map((r) => (
                      <li key={r.id}>
                        <button
                          type="button"
                          className={`comm-role-pick${selectedId === r.id ? ' is-on' : ''}`}
                          onClick={() => selectRole(r)}
                        >
                          <span className="comm-role-dot" style={{ background: r.color || '#949ba4' }} />
                          {r.name}
                        </button>
                      </li>
                    ))}
                  </ul>
                </aside>
                <div className="comm-roles-editor-wrap">
                  {selectedId ? (
                    <div className="comm-roles-editor">
                      <div className="comm-roles-editor-head">
                        <label className="comm-field">
                          <span className="comm-field-label">Nome do cargo</span>
                          <input
                            type="text"
                            maxLength={64}
                            value={roleName}
                            onChange={(e) => setRoleName(e.target.value)}
                          />
                        </label>
                        <div className="comm-roles-colors">
                          <label className="comm-field comm-field-color">
                            <span className="comm-field-label">Cor do cargo</span>
                            <input type="color" value={roleColor} onChange={(e) => setRoleColor(e.target.value)} />
                          </label>
                          <label className="comm-field comm-field-color">
                            <span className="comm-field-label">Cor do card (membros)</span>
                            <div className="comm-color-row">
                              <input type="color" value={cardColor} onChange={(e) => setCardColor(e.target.value)} />
                              <button
                                type="button"
                                className="btn btn-sm btn-ghost"
                                onClick={() => setCardColor('#5865f2')}
                              >
                                Limpar
                              </button>
                            </div>
                          </label>
                          <label className="comm-field comm-field-color">
                            <span className="comm-field-label">Cor da borda</span>
                            <div className="comm-color-row">
                              <input
                                type="color"
                                value={borderColor}
                                onChange={(e) => setBorderColor(e.target.value)}
                              />
                              <button
                                type="button"
                                className="btn btn-sm btn-ghost"
                                onClick={() => setBorderColor(roleColor)}
                              >
                                Igual à cor
                              </button>
                            </div>
                          </label>
                        </div>
                        <div className="comm-roles-border-fx">
                          <label className="comm-field">
                            <span className="comm-field-label">Efeito da borda</span>
                            <select value={borderEffect} onChange={(e) => setBorderEffect(e.target.value)}>
                              <option value="none">Nenhum</option>
                              <option value="solid">Sólida</option>
                              <option value="glow">Brilho</option>
                              <option value="neon">Neon</option>
                              <option value="double">Dupla</option>
                            </select>
                          </label>
                          <label className="comm-field">
                            <span className="comm-field-label">Movimento</span>
                            <select value={borderMotion} onChange={(e) => setBorderMotion(e.target.value)}>
                              <option value="none">Parado</option>
                              <option value="pulse">Pulso</option>
                              <option value="shimmer">Brilho deslizante</option>
                              <option value="laser">Laser girando</option>
                            </select>
                          </label>
                          <div className="comm-roles-border-preview" aria-hidden>
                            <span
                              className={`comm-member-name-cargo fx-${borderEffect} motion-${borderMotion}`}
                              style={
                                {
                                  ['--cargo-color' as string]: roleColor,
                                  ['--cargo-border-color' as string]: borderColor,
                                } as CSSProperties
                              }
                            >
                              {roleName || 'Prévia'}
                            </span>
                          </div>
                        </div>
                      </div>
                      <label className="comm-check">
                        <input type="checkbox" checked={hoist} onChange={(e) => setHoist(e.target.checked)} />
                        <span>Destacar membros com este cargo na lista</span>
                      </label>
                      <p className="comm-label">Permissões</p>
                      <div className="comm-perms-grid">
                        {PERMISSION_GROUPS.map((g) => (
                          <div key={g.group} className="comm-perms-group">
                            <strong>{g.group}</strong>
                            {g.permissions.map((p) => (
                              <label key={p.key} className="comm-check">
                                <input
                                  type="checkbox"
                                  checked={perms.includes(p.key)}
                                  onChange={() =>
                                    setPerms((prev) =>
                                      prev.includes(p.key)
                                        ? prev.filter((k) => k !== p.key)
                                        : [...prev, p.key],
                                    )
                                  }
                                />
                                <span>{p.label}</span>
                              </label>
                            ))}
                          </div>
                        ))}
                      </div>
                      <div className="form-actions">
                        <button
                          type="button"
                          className="btn btn-primary"
                          onClick={() =>
                            void api(`/api/community/servers/${serverId}/roles/${selectedId}`, {
                              method: 'PATCH',
                              body: JSON.stringify({
                                name: roleName,
                                color: roleColor,
                                permissions: perms,
                                hoist,
                                member_card_color: cardColor,
                                border_color: borderColor,
                                border_effect: borderEffect,
                                border_motion: borderMotion,
                              }),
                            }).then(() => loadRoles())
                          }
                        >
                          <Save size={14} /> Salvar cargo
                        </button>
                        <button
                          type="button"
                          className="btn btn-danger"
                          onClick={() => {
                            if (!confirm('Excluir cargo?')) return;
                            void api(`/api/community/servers/${serverId}/roles/${selectedId}`, {
                              method: 'DELETE',
                            }).then(() => {
                              setSelectedId(null);
                              return loadRoles();
                            });
                          }}
                        >
                          Excluir
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="comm-roles-empty-state">
                      <Shield size={28} />
                      <p>
                        <strong>Selecione um cargo</strong> na lista ou crie um novo para editar permissões.
                      </p>
                    </div>
                  )}
                </div>
              </div>
              {members.length ? (
                <div className="comm-roles-assign" style={{ marginTop: 16 }}>
                  <p className="comm-label">Atribuir cargos a um membro</p>
                  <div className="comm-roles-assign-row" style={{ display: 'grid', gap: 10 }}>
                    <label className="comm-field">
                      <span className="comm-field-label">Membro</span>
                      <select
                        value={assignUserId}
                        onChange={(e) =>
                          setAssignUserId(e.target.value ? Number(e.target.value) : '')
                        }
                      >
                        <option value="">Selecione…</option>
                        {members.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.label} ({m.role})
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="comm-perms-grid">
                      {roles.map((r) => (
                        <label key={r.id} className="comm-check comm-role-assign">
                          <input
                            type="checkbox"
                            checked={assignRoleIds.includes(r.id)}
                            onChange={() =>
                              setAssignRoleIds((prev) =>
                                prev.includes(r.id)
                                  ? prev.filter((id) => id !== r.id)
                                  : [...prev, r.id],
                              )
                            }
                          />
                          <span className="comm-role-dot" style={{ background: r.color || '#949ba4' }} />
                          <span>{r.name}</span>
                        </label>
                      ))}
                    </div>
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={!assignUserId}
                      onClick={() => {
                        if (!assignUserId) return;
                        void api(
                          `/api/community/servers/${serverId}/members/${assignUserId}/roles`,
                          {
                            method: 'PATCH',
                            body: JSON.stringify({ role_ids: assignRoleIds }),
                          },
                        ).then(() => onDone());
                      }}
                    >
                      Salvar atribuição
                    </button>
                  </div>
                </div>
              ) : null}
              <div className="form-actions comm-server-settings-actions">
                <button type="button" className="btn" onClick={onClose}>
                  Fechar
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </NativeDialog>
  );
}


export function SettingsAudioDialog({
  open,
  onClose,
  prefs,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  prefs: AudioDevicePrefs;
  onSave: (p: AudioDevicePrefs) => void;
}) {
  const brandName = useBrandStore((s) => s.name);
  const [tab, setTab] = useState<'audio' | 'notify'>('audio');
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [speakers, setSpeakers] = useState<MediaDeviceInfo[]>([]);
  const [micId, setMicId] = useState(prefs.micId);
  const [speakerId, setSpeakerId] = useState(prefs.speakerId);
  const [engine, setEngine] = useState<NoiseEngine>(prefs.noiseEngine);
  const [noiseLevel, setNoiseLevel] = useState(prefs.noiseLevel);
  const [echoCancellation, setEchoCancellation] = useState(prefs.echoCancellation);
  const [notifyEnabled, setNotifyEnabled] = useState(
    () => localStorage.getItem('steamfarm-notify-enabled') !== '0',
  );
  const [permStatus, setPermStatus] = useState<NotificationPermission>(() =>
    typeof Notification !== 'undefined' ? Notification.permission : 'denied',
  );
  const [prefsMap, setPrefsMap] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem('steamfarm-notify-prefs') || '{}');
    } catch {
      return {};
    }
  });

  useEffect(() => {
    if (!open) return;
    setTab('audio');
    const n = normalizeAudioPrefs(prefs);
    setMicId(n.micId);
    setSpeakerId(n.speakerId);
    setEngine(n.noiseEngine);
    setNoiseLevel(n.noiseLevel);
    setEchoCancellation(n.echoCancellation);
    if (typeof Notification !== 'undefined') setPermStatus(Notification.permission);
    void (async () => {
      try {
        await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        /* ignore */
      }
      const devices = await navigator.mediaDevices.enumerateDevices();
      setMics(devices.filter((d) => d.kind === 'audioinput'));
      setSpeakers(devices.filter((d) => d.kind === 'audiooutput'));
    })();
  }, [open, prefs]);

  function togglePref(key: string) {
    setPrefsMap((prev) => {
      const next = { ...prev, [key]: prev[key] === false ? true : false };
      // default true when undefined — toggle to false first
      if (prev[key] === undefined) next[key] = false;
      localStorage.setItem('steamfarm-notify-prefs', JSON.stringify(next));
      return next;
    });
  }

  function prefOn(key: string) {
    return prefsMap[key] !== false;
  }

  return (
    <NativeDialog open={open} onClose={onClose} className="comm-dialog comm-dialog-settings">
      <div className="comm-dialog-form" onClick={(e) => e.stopPropagation()}>
        <h2>Configurações</h2>
        <nav className="comm-settings-tabs" role="tablist">
          <button
            type="button"
            className={`comm-settings-tab${tab === 'audio' ? ' is-on' : ''}`}
            onClick={() => setTab('audio')}
          >
            <Headphones size={16} /> Áudio
          </button>
          <button
            type="button"
            className={`comm-settings-tab${tab === 'notify' ? ' is-on' : ''}`}
            onClick={() => setTab('notify')}
          >
            <Bell size={16} /> Notificações
          </button>
        </nav>

        {tab === 'audio' ? (
          <div className="comm-settings-panel">
            <p className="comm-dialog-hint">Microfone e saída de som usados na voz e ao assistir transmissões.</p>
            <label>
              Microfone
              <select value={micId} onChange={(e) => setMicId(e.target.value)}>
                <option value="">Padrão do sistema</option>
                {mics.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || `Mic ${d.deviceId.slice(0, 6)}`}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Alto-falante / fone
              <select value={speakerId} onChange={(e) => setSpeakerId(e.target.value)}>
                <option value="">Padrão do sistema</option>
                {speakers.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || `Out ${d.deviceId.slice(0, 6)}`}
                  </option>
                ))}
              </select>
            </label>
            <VoiceFilterControls
              micId={micId}
              engine={engine}
              noiseLevel={noiseLevel}
              echoCancellation={echoCancellation}
              onEngineChange={setEngine}
              onLevelChange={setNoiseLevel}
              onEchoChange={setEchoCancellation}
            />
          </div>
        ) : (
          <div className="comm-settings-panel">
            <p className="comm-dialog-hint">
              Escolha quais alertas aparecem fora da conversa ativa. Ao abrir um chat, novos avisos dessa conversa
              param.
            </p>
            <label className="comm-notify-master">
              <input
                type="checkbox"
                checked={notifyEnabled}
                onChange={(e) => {
                  setNotifyEnabled(e.target.checked);
                  localStorage.setItem('steamfarm-notify-enabled', e.target.checked ? '1' : '0');
                }}
              />
              Ativar notificações push
            </label>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                void (async () => {
                  const perm = await requestNotifyPermission();
                  setPermStatus(perm);
                  if (perm === 'granted') {
                    pushNotifyNow({
                      kind: 'community.text_message',
                      threadKey: 'comm:test',
                      title: brandName,
                      body: 'Notificações ativas. Com a aba em segundo plano, avisos de mensagens e voz aparecem aqui.',
                    });
                  }
                })();
              }}
            >
              Pedir permissão do navegador
            </button>
            {typeof Notification !== 'undefined' ? (
              <p className="comm-dialog-hint" data-notify-perm-status>
                {permStatus === 'granted'
                  ? 'Permissão concedida — se o toast de teste não aparecer, confira o Focus Assist do Windows'
                  : permStatus === 'denied'
                    ? 'Permissão negada — habilite nas configurações do navegador'
                    : 'Permissão ainda não solicitada'}
              </p>
            ) : null}
            <fieldset className="comm-notify-group">
              <legend>Comunidade</legend>
              <label>
                <input
                  type="checkbox"
                  checked={prefOn('community.member_join')}
                  onChange={() => togglePref('community.member_join')}
                />{' '}
                Novo membro entrou
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={prefOn('community.text_message')}
                  onChange={() => togglePref('community.text_message')}
                />{' '}
                Mensagem em canal de texto
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={prefOn('community.screen_share')}
                  onChange={() => togglePref('community.screen_share')}
                />{' '}
                Alguém está transmitindo tela
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={prefOn('community.remote_access')}
                  onChange={() => togglePref('community.remote_access')}
                />{' '}
                Pedido de acesso remoto
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={prefOn('community.dm')}
                  onChange={() => togglePref('community.dm')}
                />{' '}
                Mensagem direta (DM)
              </label>
            </fieldset>
          </div>
        )}

        <div className="form-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              const next = normalizeAudioPrefs({
                micId,
                speakerId,
                noiseEngine: engine,
                noiseLevel,
                echoCancellation,
              });
              saveAudioPrefs(next);
              onSave(next);
              onClose();
            }}
          >
            Aplicar
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Fechar
          </button>
        </div>
      </div>
    </NativeDialog>
  );
}

export function JoinRequestsDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [requests, setRequests] = useState<
    Array<{ id: number; server_name: string; message: string; user: { label: string; avatar_url: string } }>
  >([]);

  useEffect(() => {
    if (!open) return;
    void api<{ requests: typeof requests }>('/api/community/join-requests').then((d) =>
      setRequests(d.requests),
    );
  }, [open]);

  async function handle(id: number, action: 'approve' | 'deny') {
    await api(`/api/community/join-requests/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ action }),
    });
    setRequests((prev) => prev.filter((r) => r.id !== id));
  }

  return (
    <NativeDialog open={open} onClose={onClose} className="comm-dialog comm-dialog-join-requests">
      <div className="comm-requests-shell" onClick={(e) => e.stopPropagation()}>
        <header className="comm-requests-head">
          <div>
            <p className="comm-requests-kicker">Servidores</p>
            <h2>Solicitações de entrada</h2>
            <p className="comm-requests-lead">
              Pedidos via Descobrir. Aceitar adiciona a pessoa como membro.
            </p>
          </div>
          <button type="button" className="comm-dialog-x" onClick={onClose} aria-label="Fechar">
            <X size={18} />
          </button>
        </header>

        <div className="comm-requests-body">
          {requests.length ? (
            <ul className="comm-requests-list">
              {requests.map((r) => (
                <li key={r.id} className="comm-request-item">
                  <img
                    className="comm-avatar comm-request-avatar"
                    src={r.user.avatar_url || '/icon.svg'}
                    alt=""
                    width={44}
                    height={44}
                    referrerPolicy="no-referrer"
                  />
                  <div className="comm-request-body">
                    <div className="comm-request-meta">
                      <strong>{r.user.label}</strong>
                      <span className="comm-request-server">{r.server_name}</span>
                    </div>
                    <p className="comm-request-msg">{r.message || 'Sem mensagem'}</p>
                    <div className="comm-request-actions">
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        onClick={() => void handle(r.id, 'approve')}
                      >
                        Aceitar
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => void handle(r.id, 'deny')}
                      >
                        Recusar
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="comm-requests-empty">
              <p>Nenhuma solicitação pendente.</p>
              <span className="muted">Quando alguém pedir entrada, aparece aqui.</span>
            </div>
          )}
        </div>

        <footer className="comm-requests-foot">
          <button type="button" className="btn" onClick={onClose}>
            Fechar
          </button>
        </footer>
      </div>
    </NativeDialog>
  );
}

export function ShareScreenDialog({
  open,
  onClose,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: (opts: {
    quality: string;
    fps: number;
    audioMode: 'off' | 'app' | 'system';
    bitrateMode: 'auto' | 'fixed';
    title: string;
    publicWatch: boolean;
    publicWatchMax: number;
    publicWatchCustomNames: boolean;
    publicWatchChat: boolean;
    publicWatchChatPost: boolean;
  }) => void;
}) {
  const LS = {
    quality: 'comm-pref-share-quality',
    fps: 'comm-pref-share-fps',
    bitrate: 'comm-pref-share-bitrate-mode',
    audio: 'comm-pref-share-audio-mode',
  };
  const [tab, setTab] = useState<'community' | 'twitch' | 'youtube'>('community');
  const [title, setTitle] = useState('');
  const [quality, setQuality] = useState('720');
  const [fps, setFps] = useState(30);
  const [audioMode, setAudioMode] = useState<'off' | 'app' | 'system'>('off');
  const [bitrateMode, setBitrateMode] = useState<'auto' | 'fixed'>('fixed');
  const [publicWatch, setPublicWatch] = useState(true);
  const [publicWatchMax, setPublicWatchMax] = useState(50);
  const [publicWatchCustomNames, setPublicWatchCustomNames] = useState(true);
  const [publicWatchChat, setPublicWatchChat] = useState(true);
  const [publicWatchChatPost, setPublicWatchChatPost] = useState(true);

  useEffect(() => {
    if (!open) return;
    const isDesktop = typeof window !== 'undefined' && !!window.sfDesktop;
    const defaultAudio: 'off' | 'app' | 'system' = isDesktop ? 'off' : 'app';
    try {
      setQuality(localStorage.getItem(LS.quality) || '720');
      setFps(Number(localStorage.getItem(LS.fps) || 30) || 30);
      setBitrateMode(
        (localStorage.getItem(LS.bitrate) as 'auto' | 'fixed') || 'fixed',
      );
      const saved = localStorage.getItem(LS.audio) as 'off' | 'app' | 'system' | null;
      // Desktop: default só vídeo (WASAPI mutava a call). User pode ligar app/system.
      setAudioMode(saved || defaultAudio);
    } catch {
      setQuality('720');
      setFps(30);
      setAudioMode(defaultAudio);
      setBitrateMode('fixed');
    }
    setTab('community');
    setTitle('');
    setPublicWatch(true);
    setPublicWatchMax(50);
    setPublicWatchCustomNames(true);
    setPublicWatchChat(true);
    setPublicWatchChatPost(true);
  }, [open]);

  return (
    <NativeDialog open={open} onClose={onClose} className="comm-dialog comm-dialog-live-wizard">
      <form
        className="comm-dialog-form"
        onSubmit={(e) => {
          e.preventDefault();
          try {
            localStorage.setItem(LS.quality, quality);
            localStorage.setItem(LS.fps, String(fps));
            localStorage.setItem(LS.bitrate, bitrateMode);
            localStorage.setItem(LS.audio, audioMode);
          } catch {
            /* ignore */
          }
          onConfirm({
            quality,
            fps,
            audioMode,
            bitrateMode,
            title: title.trim(),
            publicWatch,
            publicWatchMax,
            publicWatchCustomNames,
            publicWatchChat,
            publicWatchChatPost,
          });
          onClose();
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="comm-live-wiz-head">
          <div>
            <h2>Configurar transmissão</h2>
            <p className="comm-dialog-hint">
              Defina qualidade da tela e link público — o compartilhamento começa quando você
              confirmar.
            </p>
          </div>
        </header>

        <nav className="comm-live-wiz-tabs" role="tablist" aria-label="Destinos da live">
          <button
            type="button"
            className={`comm-live-wiz-tab${tab === 'community' ? ' is-on' : ''}`}
            role="tab"
            aria-selected={tab === 'community'}
            onClick={() => setTab('community')}
          >
            Comunidade
          </button>
          <button
            type="button"
            className={`comm-live-wiz-tab${tab === 'twitch' ? ' is-on' : ''}`}
            role="tab"
            aria-selected={tab === 'twitch'}
            onClick={() => setTab('twitch')}
          >
            Twitch
          </button>
          <button
            type="button"
            className={`comm-live-wiz-tab${tab === 'youtube' ? ' is-on' : ''}`}
            role="tab"
            aria-selected={tab === 'youtube'}
            onClick={() => setTab('youtube')}
          >
            YouTube
          </button>
        </nav>

        {tab === 'community' ? (
          <div className="comm-live-wiz-panel is-on" role="tabpanel">
            <label className="comm-field">
              <span className="comm-field-label">Título da live</span>
              <input
                type="text"
                maxLength={120}
                placeholder="Ex.: Reunião semanal"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
            <div className="comm-live-share-quality">
              <label className="comm-field">
                <span className="comm-field-label">Resolução</span>
                <select value={quality} onChange={(e) => setQuality(e.target.value)}>
                  <option value="source">Fonte (nativo)</option>
                  <option value="480">480p</option>
                  <option value="720">720p</option>
                  <option value="1080">1080p</option>
                </select>
              </label>
              <label className="comm-field">
                <span className="comm-field-label">FPS</span>
                <select value={fps} onChange={(e) => setFps(Number(e.target.value))}>
                  <option value={15}>15</option>
                  <option value={30}>30</option>
                  <option value={60}>60</option>
                </select>
              </label>
              <label className="comm-field">
                <span className="comm-field-label">Modo de bitrate</span>
                <select
                  value={bitrateMode}
                  onChange={(e) => setBitrateMode(e.target.value as 'auto' | 'fixed')}
                >
                  <option value="fixed">Fixo (recomendado)</option>
                  <option value="auto">Automático</option>
                </select>
              </label>
            </div>
            <p className="comm-dialog-note muted">
              A resolução e o FPS escolhidos ficam travados na transmissão. Em &quot;Automático&quot;,
              só o bitrate pode variar — a imagem não muda sozinha para outra qualidade.
            </p>
            <label className="comm-field">
              <span className="comm-field-label">Áudio da tela</span>
              <select
                value={audioMode}
                onChange={(e) => setAudioMode(e.target.value as 'off' | 'app' | 'system')}
              >
                <option value="off">Desligado</option>
                <option value="app">Só da janela / aplicativo</option>
                <option value="system">Sistema inteiro (pode causar eco)</option>
              </select>
            </label>
            <p className="comm-dialog-note muted">
              No desktop o padrão é <strong>só vídeo</strong> (a call de voz fica estável). Áudio da
              app/sistema via WASAPI é opcional — pode mutar a voz nalgumas máquinas. Escolhe uma{' '}
              <strong>janela</strong> (não ecrã inteiro) para &quot;Só da janela&quot;. No
              Chrome/Edge marque &quot;Compartilhar áudio&quot; no seletor.
            </p>
            <fieldset className="comm-live-destinations">
              <legend>Retransmitir também para</legend>
              <p className="muted comm-live-hint">
                Gere um link público para outras pessoas assistirem a tela.
              </p>
            </fieldset>
            <fieldset className="comm-live-public-watch">
              <legend>Link público (sem login)</legend>
              <label className="comm-check">
                <input
                  type="checkbox"
                  checked={publicWatch}
                  onChange={(e) => setPublicWatch(e.target.checked)}
                />
                <span>Gerar link para qualquer pessoa assistir</span>
              </label>
              <label className="comm-field comm-live-public-max">
                <span className="comm-field-label">Limite de espectadores</span>
                <input
                  type="number"
                  min={1}
                  max={500}
                  value={publicWatchMax}
                  onChange={(e) => setPublicWatchMax(Number(e.target.value) || 50)}
                />
              </label>
              <label className="comm-check">
                <input
                  type="checkbox"
                  checked={publicWatchCustomNames}
                  onChange={(e) => setPublicWatchCustomNames(e.target.checked)}
                />
                <span>Permitir convidados escolherem o nome</span>
              </label>
              <label className="comm-check">
                <input
                  type="checkbox"
                  checked={publicWatchChat}
                  onChange={(e) => setPublicWatchChat(e.target.checked)}
                />
                <span>Exibir chat na transmissão pública</span>
              </label>
              <label className="comm-check">
                <input
                  type="checkbox"
                  checked={publicWatchChatPost}
                  onChange={(e) => setPublicWatchChatPost(e.target.checked)}
                  disabled={!publicWatchChat}
                />
                <span>Convidados podem enviar mensagens</span>
              </label>
              <p className="comm-dialog-note muted">
                Quem tiver o link entra como convidado — não precisa de conta. O limite vale só
                para espectadores públicos. (Link público será ativado na sala da comunidade; RTMP
                Twitch/YouTube ainda em portagem.)
              </p>
            </fieldset>
            <p className="comm-dialog-note muted">O título aparece no link público da reunião.</p>
          </div>
        ) : null}

        {tab === 'twitch' ? (
          <div className="comm-live-wiz-panel is-on" role="tabpanel">
            <p className="muted">
              Retransmissão Twitch ainda não está disponível nesta versão React. Use a aba
              Comunidade para compartilhar na sala, ou o Meeting Flask para ir ao ar na Twitch.
            </p>
          </div>
        ) : null}

        {tab === 'youtube' ? (
          <div className="comm-live-wiz-panel is-on" role="tabpanel">
            <p className="muted">
              Retransmissão YouTube ainda não está disponível nesta versão React. Use a aba
              Comunidade para compartilhar na sala, ou o Meeting Flask para ir ao ar no YouTube.
            </p>
          </div>
        ) : null}

        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={tab !== 'community'}>
            Compartilhar / Ir ao ar
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
        </div>
      </form>
    </NativeDialog>
  );
}

export function MemberProfileDialog({
  open,
  onClose,
  member,
  canKick,
  canAssignRoles,
  serverId,
  myUserId,
  canRemote,
  remoteBusy,
  onDm,
  onTrade,
  onKick,
  onRemoteControl,
  onRemoteInvite,
  onDone,
  onOpenItem,
}: {
  open: boolean;
  onClose: () => void;
  member: {
    id: number;
    label: string;
    username?: string;
    avatar_url: string;
    ramal: string;
    role: string;
    steam_linked?: boolean;
    steam_persona?: string;
    showcase_items?: Array<{
      assetid: string;
      name: string;
      icon?: string;
      icon_large?: string;
      rarity_color?: string;
      rarity?: string;
      exterior?: string;
      market_hash_name?: string;
    }>;
    card_color?: string | null;
    custom_roles?: Array<{ id: number; name: string; color: string }>;
  } | null;
  canKick: boolean;
  canAssignRoles: boolean;
  serverId: number;
  myUserId?: number;
  canRemote?: boolean;
  remoteBusy?: boolean;
  onDm: (userId: number) => void;
  onTrade?: (userId: number, label: string) => void;
  onKick: (userId: number, label: string) => void;
  onRemoteControl?: (userId: number) => void;
  onRemoteInvite?: (userId: number) => void;
  onDone: () => void;
  onOpenItem?: (item: SkinItem) => void;
}) {
  const [roles, setRoles] = useState<Role[]>([]);
  const [picked, setPicked] = useState<number[]>([]);
  const [error, setError] = useState('');
  const [savingRoles, setSavingRoles] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);

  useEffect(() => {
    if (!open || !member) return;
    setError('');
    setAdminOpen(false);
  }, [open, member]);

  useEffect(() => {
    if (!open || !member || !canAssignRoles) return;
    void api<{ roles: Role[] }>(`/api/community/servers/${serverId}/roles`)
      .then((d) => {
        setRoles(d.roles.filter((r) => !r.is_default));
        setPicked((member.custom_roles || []).map((r) => r.id));
      })
      .catch((e) => setError(e.message));
  }, [open, member, serverId, canAssignRoles]);

  if (!member) return null;

  const accent =
    member.card_color ||
    member.custom_roles?.[0]?.color ||
    (member.role === 'owner' ? '#f0b232' : member.role === 'admin' ? '#5865f2' : '#6366f1');
  const showAdmin = canAssignRoles;
  const isSelf = !!myUserId && member.id === myUserId;

  return (
    <NativeDialog open={open} onClose={onClose} className="comm-dialog comm-dialog-member-card">
      <div className="comm-member-sheet" onClick={(e) => e.stopPropagation()}>
        <div
          className="comm-member-sheet-banner"
          style={{ ['--sheet-accent' as string]: accent }}
        />
        <button type="button" className="comm-member-sheet-close" onClick={onClose} aria-label="Fechar">
          <X size={16} />
        </button>
        <div className="comm-member-sheet-hero">
          <img
            className="comm-member-sheet-av"
            src={member.avatar_url || '/icon.svg'}
            alt=""
            referrerPolicy="no-referrer"
            onError={(e) => {
              (e.target as HTMLImageElement).src = '/icon.svg';
            }}
          />
          <div className="comm-member-sheet-id">
            <strong>{member.label}</strong>
            {member.username ? <em>@{member.username}</em> : null}
            <div className="comm-member-sheet-tags">
              <span
                className="comm-member-sheet-tag"
                style={{ ['--tag-color' as string]: accent }}
              >
                {roleLabelLocal(member.role)}
              </span>
              {(member.custom_roles || []).map((r) => (
                <span
                  key={r.id}
                  className="comm-member-sheet-tag"
                  style={{ ['--tag-color' as string]: r.color || '#949ba4' }}
                >
                  {r.name}
                </span>
              ))}
            </div>
          </div>
        </div>

        <div className="comm-member-sheet-actions">
          <div className="comm-member-sheet-actions-row">
            {!isSelf ? (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  onDm(member.id);
                  onClose();
                }}
              >
                <Mail size={15} aria-hidden />
                Mensagem
              </button>
            ) : null}
            {onTrade && member.steam_linked && !isSelf ? (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  onTrade(member.id, member.label);
                  onClose();
                }}
              >
                Propor troca
              </button>
            ) : null}
            {canKick && !isSelf ? (
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => {
                  onKick(member.id, member.label);
                  onClose();
                }}
              >
                Expulsar
              </button>
            ) : null}
          </div>
          {canRemote && !isSelf && (onRemoteControl || onRemoteInvite) ? (
            <div className="comm-member-sheet-actions-row is-remote">
              {onRemoteControl ? (
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={remoteBusy}
                  title="Pedir controlo total da máquina deste membro"
                  onClick={() => {
                    onRemoteControl(member.id);
                    onClose();
                  }}
                >
                  <Monitor size={15} aria-hidden />
                  Controlar PC
                </button>
              ) : null}
              {onRemoteInvite ? (
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={remoteBusy}
                  title="Pedir que este membro aceda à sua máquina"
                  onClick={() => {
                    onRemoteInvite(member.id);
                    onClose();
                  }}
                >
                  <MonitorUp size={15} aria-hidden />
                  Partilhar o meu
                </button>
              ) : null}
            </div>
          ) : null}
        </div>

        {(member.showcase_items || []).length > 0 ? (
          <div style={{ padding: '0 1rem 1rem' }}>
            <p className="comm-label" style={{ marginBottom: 8 }}>
              Itens em destaque
            </p>
            <MemberShowcaseGrid
              items={member.showcase_items}
              onOpen={(it) => onOpenItem?.(it)}
            />
          </div>
        ) : member.steam_linked ? (
          <p className="muted" style={{ padding: '0 1rem 1rem' }}>
            Steam: {member.steam_persona || 'vinculada'} · sem vitrine
          </p>
        ) : null}

        {showAdmin ? (
          <div className={`comm-member-sheet-admin${adminOpen ? ' is-open' : ''}`}>
            <button
              type="button"
              className="comm-member-sheet-admin-toggle"
              aria-expanded={adminOpen}
              onClick={() => setAdminOpen((v) => !v)}
            >
              <Shield size={14} aria-hidden />
              Gerenciar membro
              <span className="comm-member-sheet-admin-chev">{adminOpen ? '−' : '+'}</span>
            </button>
            {adminOpen ? (
              <div className="comm-member-sheet-admin-body">
                {canAssignRoles ? (
                  <div className="comm-member-sheet-field">
                    <span>Cargos</span>
                    <div className="comm-member-sheet-roles">
                      {roles.length ? (
                        roles.map((r) => {
                          const on = picked.includes(r.id);
                          return (
                            <button
                              key={r.id}
                              type="button"
                              className={`comm-member-sheet-role${on ? ' is-on' : ''}`}
                              style={{ ['--role-color' as string]: r.color || '#949ba4' }}
                              aria-pressed={on}
                              onClick={() =>
                                setPicked((prev) =>
                                  prev.includes(r.id)
                                    ? prev.filter((id) => id !== r.id)
                                    : [...prev, r.id],
                                )
                              }
                            >
                              <span className="comm-role-dot" style={{ background: r.color || '#949ba4' }} />
                              {r.name}
                            </button>
                          );
                        })
                      ) : (
                        <p className="muted">Nenhum cargo customizado neste servidor.</p>
                      )}
                    </div>
                    {roles.length ? (
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        disabled={savingRoles}
                        onClick={() => {
                          setSavingRoles(true);
                          setError('');
                          void api(`/api/community/servers/${serverId}/members/${member.id}/roles`, {
                            method: 'PATCH',
                            body: JSON.stringify({ role_ids: picked }),
                          })
                            .then(() => onDone())
                            .catch((e) => setError(e.message))
                            .finally(() => setSavingRoles(false));
                        }}
                      >
                        {savingRoles ? 'Salvando…' : 'Salvar cargos'}
                      </button>
                    ) : null}
                  </div>
                ) : null}
                {error ? (
                  <p className="comm-dialog-hint" style={{ color: 'var(--comm-danger)' }}>
                    {error}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </NativeDialog>
  );
}

function roleLabelLocal(role: string) {
  if (role === 'owner') return 'Dono';
  if (role === 'admin') return 'Admin';
  return 'Membro';
}

/* Compat exports */
export { CreateChannelDialog as CreateChannelDialogLegacy };
