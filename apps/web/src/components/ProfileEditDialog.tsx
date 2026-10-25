import { FormEvent, useEffect, useRef, useState } from 'react';
import {
  Gamepad2,
  History,
  Link2,
  Radio,
  Shield,
  UserRound,
  X,
} from 'lucide-react';
import { api } from '../lib/api';
import { clearSteamLinkPending, isSteamLinkPending, startSteamLink } from '../lib/steamLink';
import { NativeDialog } from './NativeDialog';
import { Cs2GsiSettingsPanel, Cs2MatchHistoryPanel } from './Cs2GsiPanel';

export type ProfileTab = 'appearance' | 'account' | 'steam' | 'stream' | 'history';

type SteamMeBrief = {
  steam_linked: boolean;
  steam_id64: string;
  steam_persona: string;
  steam_avatar: string;
  has_trade_url: boolean;
  steam_trade_url?: string;
};

async function uploadMedia(file: File, kind: string) {
  const fd = new FormData();
  // kind antes do file — alguns parsers leem fields na ordem
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

function SteamTabPanel({
  active,
  onOpenShowcase,
}: {
  active: boolean;
  onOpenShowcase?: () => void;
}) {
  const [me, setMe] = useState<SteamMeBrief | null>(null);
  const [tradeUrl, setTradeUrl] = useState('');
  const [items, setItems] = useState<
    Array<{
      assetid: string;
      name: string;
      market_hash_name?: string;
      icon?: string;
      icon_large?: string;
      rarity?: string;
      rarity_color?: string;
      exterior?: string;
    }>
  >([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [loading, setLoading] = useState(false);
  const [savingShow, setSavingShow] = useState(false);
  const [linking, setLinking] = useState(false);
  const waitLinkRef = useRef(false);

  async function reload(refresh = false) {
    setLoading(true);
    try {
      const m = await api<
        SteamMeBrief & {
          showcase_items?: Array<{ assetid: string }>;
        }
      >('/api/steam/me');
      setMe(m);
      setTradeUrl(m.steam_trade_url || '');
      setPicked((m.showcase_items || []).map((i) => i.assetid));
      if (m.steam_linked) {
        waitLinkRef.current = false;
        clearSteamLinkPending();
        setError('');
        const inv = await api<{ ok: boolean; items?: typeof items; message?: string }>(
          `/api/steam/inventory${refresh ? '?refresh=1' : ''}`,
        );
        if (!inv.ok) setInfo(inv.message || 'Inventário indisponível');
        else setInfo(`${(inv.items || []).length} itens · até 5 insignias`);
        setItems(inv.items || []);
      } else {
        setItems([]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro');
    } finally {
      setLoading(false);
    }
  }

  async function connectSteam() {
    setError('');
    setLinking(true);
    try {
      const r = await startSteamLink('/comunidade?desktop=1');
      if (r.mode === 'external') {
        waitLinkRef.current = true;
        setInfo('Complete o login Steam no browser. Depois volte a esta janela — atualizamos automaticamente.');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao abrir Steam');
    } finally {
      setLinking(false);
    }
  }

  useEffect(() => {
    if (!active) return;
    const onFocus = () => {
      if (waitLinkRef.current || isSteamLinkPending()) void reload();
    };
    const onLinked = () => {
      waitLinkRef.current = false;
      void reload();
    };
    window.addEventListener('focus', onFocus);
    window.addEventListener('sf-steam-linked', onLinked);
    const t = window.setInterval(() => {
      if (waitLinkRef.current || isSteamLinkPending()) void reload();
    }, 2000);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('sf-steam-linked', onLinked);
      window.clearInterval(t);
    };
  }, [active]);

  useEffect(() => {
    if (active) {
      const pending = sessionStorage.getItem('sf_steam_link_err');
      if (pending) {
        setError(pending);
        sessionStorage.removeItem('sf_steam_link_err');
      }
      void reload();
    }
  }, [active]);

  async function saveTrade() {
    setError('');
    try {
      await api('/api/steam/trade-url', {
        method: 'PUT',
        body: JSON.stringify({ trade_url: tradeUrl }),
      });
      setInfo('Trade URL salva');
      void reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro');
    }
  }

  async function unlink() {
    if (!confirm('Desvincular Steam desta conta?')) return;
    await api('/api/steam/unlink', { method: 'POST', body: '{}' });
    void reload();
  }

  function toggle(id: string) {
    setPicked((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= 5) return prev;
      return [...prev, id];
    });
  }

  async function saveShowcase() {
    setSavingShow(true);
    setError('');
    try {
      const byId = new Map(items.map((i) => [i.assetid, i]));
      const chosen = picked
        .map((id) => byId.get(id))
        .filter((x): x is (typeof items)[number] => !!x);
      if (picked.length && !chosen.length) {
        throw new Error('Itens selecionados não estão no inventário carregado. Atualiza o inventário.');
      }
      const res = await api<{ ok?: boolean; saved?: number; showcase_items?: unknown[] }>(
        '/api/steam/showcase',
        {
          method: 'PUT',
          body: JSON.stringify({ items: chosen }),
        },
      );
      setInfo(`Insignias salvas (${res.saved ?? chosen.length}/5)`);
      void reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro ao salvar insignias');
    } finally {
      setSavingShow(false);
    }
  }

  const filtered = items.filter((i) => {
    const q = filter.trim().toLowerCase();
    if (!q) return true;
    return (
      i.name.toLowerCase().includes(q) ||
      (i.market_hash_name || '').toLowerCase().includes(q) ||
      (i.exterior || '').toLowerCase().includes(q)
    );
  });

  return (
    <div className="comm-profile-edit-panel is-wide" data-profile-panel="steam">
      <section className="comm-profile-edit-section comm-profile-edit-steam">
        <h3 className="comm-profile-edit-section-title">Steam CS2</h3>
        <p className="comm-profile-edit-steam-note">
          Conecte a Steam, salve a Trade URL e escolha até 5 skins como insignias.
        </p>
        {error ? <div className="error">{error}</div> : null}
        {info ? <p className="muted">{info}</p> : null}

        {!me?.steam_linked ? (
          <div className="comm-steam-setup-cta">
            <p>Vincule sua conta Steam via OpenID (oficial).</p>
            <button
              type="button"
              className="btn btn-primary"
              disabled={linking}
              onClick={() => void connectSteam()}
            >
              <Link2 size={16} /> {linking ? 'A abrir…' : 'Conectar Steam'}
            </button>
          </div>
        ) : (
          <>
            <div className="comm-steam-linked">
              <img src={me.steam_avatar || '/icon.svg'} alt="" referrerPolicy="no-referrer" />
              <div>
                <strong>{me.steam_persona || 'Steam'}</strong>
                <p>{me.steam_id64}</p>
                <p className="muted">
                  {me.has_trade_url ? 'Trade URL configurada' : 'Trade URL ainda não salva'}
                </p>
              </div>
              <div className="comm-profile-edit-actions" style={{ marginLeft: 'auto' }}>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={linking}
                  onClick={() => void connectSteam()}
                >
                  Trocar conta
                </button>
                <button type="button" className="btn btn-sm" onClick={() => void unlink()}>
                  Desvincular
                </button>
              </div>
            </div>

            <div className="comm-profile-steam-trade">
              <label className="comm-field">
                <span className="comm-field-label">Trade URL</span>
                <span className="comm-field-desc">
                  Necessária para trocas P2P.{' '}
                  <a
                    href="https://steamcommunity.com/id/me/tradeoffers/privacy#trade_offer_access_url"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Como obter
                  </a>
                </span>
                <input
                  type="url"
                  value={tradeUrl}
                  onChange={(e) => setTradeUrl(e.target.value)}
                  placeholder="https://steamcommunity.com/tradeoffer/new/?partner=…&token=…"
                  disabled={loading}
                />
              </label>
              <div className="comm-profile-edit-actions">
                <button type="button" className="btn btn-sm btn-primary" onClick={() => void saveTrade()}>
                  Salvar Trade URL
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => void reload(true)}
                  disabled={loading}
                >
                  Atualizar inventário
                </button>
                {onOpenShowcase ? (
                  <button type="button" className="btn btn-sm" onClick={() => onOpenShowcase()}>
                    Abrir em tela cheia
                  </button>
                ) : null}
              </div>
            </div>

            <div className="comm-profile-showcase-block">
              <p className="comm-label">
                Insignias ({picked.length}/5) — selecionadas ficam com número verde
              </p>
              <input
                type="search"
                className="comm-trade-filter"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filtrar inventário…"
              />
              <div className="comm-showcase-pick comm-showcase-pick-tall">
                {filtered.map((it) => {
                  const selIdx = picked.indexOf(it.assetid);
                  const on = selIdx >= 0;
                  return (
                    <button
                      key={it.assetid}
                      type="button"
                      className={`comm-pick-item${on ? ' is-on' : ''}`}
                      title={it.market_hash_name || it.name}
                      aria-pressed={on}
                      style={{ ['--skin-accent' as string]: it.rarity_color || '#8b9bb4' }}
                      onClick={() => toggle(it.assetid)}
                    >
                      {on ? (
                        <span className="comm-pick-sel" aria-hidden>
                          {selIdx + 1}
                        </span>
                      ) : null}
                      <img
                        src={it.icon || it.icon_large || '/icon.svg'}
                        alt=""
                        loading="lazy"
                        referrerPolicy="no-referrer"
                      />
                      <span>{it.name}</span>
                    </button>
                  );
                })}
                {!filtered.length && !loading ? (
                  <p className="muted" style={{ gridColumn: '1 / -1' }}>
                    Nenhum item. Deixe o inventário CS2 público e atualize.
                  </p>
                ) : null}
                {loading ? (
                  <p className="muted" style={{ gridColumn: '1 / -1' }}>
                    Carregando inventário…
                  </p>
                ) : null}
              </div>
              <div className="comm-profile-edit-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={savingShow || loading}
                  onClick={() => void saveShowcase()}
                >
                  Salvar insignias
                </button>
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function StreamTabPanel({ active }: { active: boolean }) {
  type Acc = {
    ready?: boolean;
    login?: string;
    display_name?: string;
    oauth?: boolean;
    manual_key?: boolean;
    needs_reconnect?: boolean;
    missing_scopes?: string[];
  };
  type AccPayload = {
    twitch: Acc | null;
    youtube: Acc | null;
    oauth: { twitch: boolean; youtube: boolean };
  };

  const [data, setData] = useState<AccPayload | null>(null);
  const [twitchKeyOpen, setTwitchKeyOpen] = useState(false);
  const [ytKeyOpen, setYtKeyOpen] = useState(false);
  const [twitchKey, setTwitchKey] = useState('');
  const [ytKey, setYtKey] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);

  async function reload() {
    setError('');
    try {
      const d = await api<AccPayload & { ok?: boolean }>('/api/community/me/stream-accounts');
      setData(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro');
    }
  }

  useEffect(() => {
    if (active) void reload();
  }, [active]);

  async function saveKey(provider: 'twitch' | 'youtube') {
    setBusy(true);
    setError('');
    setInfo('');
    try {
      await api('/api/community/me/stream-accounts/manual', {
        method: 'POST',
        body: JSON.stringify({
          provider,
          stream_key: provider === 'twitch' ? twitchKey : ytKey,
        }),
      });
      setInfo(`Chave ${provider === 'twitch' ? 'Twitch' : 'YouTube'} salva`);
      if (provider === 'twitch') setTwitchKey('');
      else setYtKey('');
      void reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro');
    } finally {
      setBusy(false);
    }
  }

  async function unlink(provider: 'twitch' | 'youtube') {
    if (!confirm(`Desvincular ${provider === 'twitch' ? 'Twitch' : 'YouTube'}?`)) return;
    setBusy(true);
    try {
      await api(`/api/community/me/stream-accounts/${provider}`, { method: 'DELETE' });
      void reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro');
    } finally {
      setBusy(false);
    }
  }

  const next = encodeURIComponent('/comunidade');

  function renderProvider(
    provider: 'twitch' | 'youtube',
    label: string,
    keyOpen: boolean,
    setKeyOpen: (v: boolean | ((x: boolean) => boolean)) => void,
    keyVal: string,
    setKeyVal: (v: string) => void,
    placeholder: string,
  ) {
    const acc = data?.[provider] || null;
    const oauthOk = !!data?.oauth?.[provider];
    return (
      <div className="comm-stream-account" data-comm-stream={provider}>
        <div className="comm-stream-account-head">
          <strong>{label}</strong>
          <span className={`comm-stream-status${acc?.ready ? ' is-ok' : ''} muted`}>
            {acc?.ready
              ? acc.display_name || acc.login || 'Conectado'
              : provider === 'twitch'
                ? 'Não conectada'
                : 'Não conectado'}
          </span>
        </div>
        <p className={`muted comm-stream-meta${acc?.needs_reconnect ? ' is-warn' : ''}`}>
          {acc?.ready
            ? acc.oauth
              ? acc.needs_reconnect
                ? `Permissões incompletas — reconecte. Faltam: ${(acc.missing_scopes || []).join(', ')}`
                : 'OAuth conectado — stream key automática no go-live.'
              : 'Chave manual salva.'
            : oauthOk
              ? `Use Conectar ${label} ou cole a stream key manualmente.`
              : `OAuth não configurado no servidor — cole a stream key manualmente.`}
        </p>
        <div className="comm-stream-actions">
          {oauthOk ? (
            <a
              className="btn btn-sm btn-primary"
              href={`/api/community/stream/oauth/${provider}?next=${next}`}
            >
              {acc?.needs_reconnect ? `Reconectar ${label}` : `Conectar ${label}`}
            </a>
          ) : (
            <button type="button" className="btn btn-sm btn-primary" disabled title="Defina TWITCH_/GOOGLE_ no .env">
              Conectar {label}
            </button>
          )}
          <button type="button" className="btn btn-sm" onClick={() => setKeyOpen((v) => !v)}>
            Stream key manual (opcional)
          </button>
          {acc?.ready ? (
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void unlink(provider)}>
              Desvincular
            </button>
          ) : null}
        </div>
        {keyOpen ? (
          <label className="comm-field comm-stream-key-field">
            <span className="comm-field-label">Stream key {label}</span>
            <span className="comm-field-desc">
              {provider === 'twitch'
                ? 'Só se não usar OAuth. Mesmo valor do OBS → Stream.'
                : 'Só se OAuth falhar. YouTube Studio → Chave de transmissão.'}
            </span>
            <input
              type="password"
              value={keyVal}
              onChange={(e) => setKeyVal(e.target.value)}
              placeholder={placeholder}
              autoComplete="off"
            />
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={busy || keyVal.trim().length < 8}
              onClick={() => void saveKey(provider)}
            >
              Salvar chave
            </button>
          </label>
        ) : null}
      </div>
    );
  }

  return (
    <div className="comm-profile-edit-panel is-wide" data-profile-panel="stream">
      <section className="comm-profile-edit-section comm-profile-edit-stream">
        <h3 className="comm-profile-edit-section-title">Transmissão (Twitch / YouTube)</h3>
        <p className="muted comm-profile-stream-lead">
          Vincule suas contas para retransmitir ao compartilhar tela na Comunidade.
        </p>
        {error ? <div className="error">{error}</div> : null}
        {info ? <p className="muted">{info}</p> : null}
        {renderProvider('twitch', 'Twitch', twitchKeyOpen, setTwitchKeyOpen, twitchKey, setTwitchKey, 'live_…')}
        {renderProvider('youtube', 'YouTube', ytKeyOpen, setYtKeyOpen, ytKey, setYtKey, 'xxxx-xxxx-xxxx-xxxx')}
      </section>
    </div>
  );
}

export function ProfileEditDialog({
  open,
  onClose,
  initial,
  onDone,
  initialTab = 'appearance',
  onOpenSteamShowcase,
}: {
  open: boolean;
  onClose: () => void;
  initial: { display_name: string; ramal: string; avatar_url: string; username?: string };
  onDone: (label: string, avatar: string, ramal: string) => void;
  initialTab?: ProfileTab;
  /** Abre o modal largo Steam (Trade URL + vitrine) — igual ao ASF. */
  onOpenSteamShowcase?: () => void;
}) {
  const [tab, setTab] = useState<ProfileTab>(initialTab);
  const [displayName, setDisplayName] = useState(initial.display_name);
  const [avatarUrl, setAvatarUrl] = useState(initial.avatar_url);
  const [password, setPassword] = useState('');
  const [phone, setPhone] = useState('');
  const [phoneDisplay, setPhoneDisplay] = useState('');
  const [error, setError] = useState('');
  const wasOpen = useRef(false);

  // Só reseta abas/campos ao ABRIR o modal — não a cada re-render do parent.
  useEffect(() => {
    if (open && !wasOpen.current) {
      setTab(initialTab);
      setDisplayName(initial.display_name);
      setAvatarUrl(initial.avatar_url);
      setPassword('');
      setError('');
      setPhone('');
      setPhoneDisplay('');
      void api<{ phone?: string; phone_display?: string }>('/api/community/me/whatsapp')
        .then((d) => {
          setPhone(d.phone_display || d.phone || '');
          setPhoneDisplay(d.phone_display || '');
        })
        .catch(() => undefined);
    }
    wasOpen.current = open;
  }, [open, initialTab, initial.display_name, initial.avatar_url]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (tab === 'steam' || tab === 'stream' || tab === 'history') return;
    setError('');
    try {
      const d = await api<{ user: { label: string; avatar_url: string; ramal?: string } }>(
        '/api/community/me/profile',
        {
          method: 'POST',
          body: JSON.stringify({
            display_name: displayName,
            ramal: initial.ramal || '',
            avatar_url: avatarUrl,
            ...(password ? { password } : {}),
          }),
        },
      );
      if (tab === 'account') {
        const wa = await api<{ phone_display?: string; phone?: string }>(
          '/api/community/me/whatsapp',
          {
            method: 'POST',
            body: JSON.stringify({ phone }),
          },
        );
        setPhoneDisplay(wa.phone_display || wa.phone || '');
        setPhone(wa.phone_display || wa.phone || '');
      }
      onDone(d.user.label, d.user.avatar_url, d.user.ramal || initial.ramal || '');
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro');
    }
  }

  const showSave = tab === 'appearance' || tab === 'account';

  return (
    <NativeDialog open={open} onClose={onClose} className="comm-dialog comm-dialog-profile-edit">
      <form className="comm-profile-edit-form" onSubmit={(e) => void submit(e)} onClick={(e) => e.stopPropagation()}>
        <header className="comm-profile-edit-head">
          <div>
            <p className="comm-profile-edit-kicker">Configurações</p>
            <h2>Meu perfil</h2>
            <p className="comm-profile-edit-lead">
              Organize aparência, conta, Steam, transmissão e histórico CS2 em abas.
            </p>
          </div>
          <button type="button" className="comm-dialog-x" onClick={onClose} aria-label="Fechar">
            <X size={18} />
          </button>
        </header>

        <nav className="comm-settings-tabs comm-profile-edit-tabs" role="tablist" aria-label="Seções do perfil">
          <button
            type="button"
            className={`comm-settings-tab${tab === 'appearance' ? ' is-on' : ''}`}
            role="tab"
            aria-selected={tab === 'appearance'}
            onClick={() => setTab('appearance')}
          >
            <UserRound size={16} /> Aparência
          </button>
          <button
            type="button"
            className={`comm-settings-tab${tab === 'account' ? ' is-on' : ''}`}
            role="tab"
            aria-selected={tab === 'account'}
            onClick={() => setTab('account')}
          >
            <Shield size={16} /> Conta
          </button>
          <button
            type="button"
            className={`comm-settings-tab${tab === 'steam' ? ' is-on' : ''}`}
            role="tab"
            aria-selected={tab === 'steam'}
            onClick={() => setTab('steam')}
          >
            <Gamepad2 size={16} /> Steam
          </button>
          <button
            type="button"
            className={`comm-settings-tab${tab === 'history' ? ' is-on' : ''}`}
            role="tab"
            aria-selected={tab === 'history'}
            onClick={() => setTab('history')}
          >
            <History size={16} /> Histórico CS2
          </button>
          <button
            type="button"
            className={`comm-settings-tab${tab === 'stream' ? ' is-on' : ''}`}
            role="tab"
            aria-selected={tab === 'stream'}
            onClick={() => setTab('stream')}
          >
            <Radio size={16} /> Transmissão
          </button>
        </nav>

        <div className="comm-profile-edit-body">
          {tab === 'appearance' ? (
            <div className="comm-profile-edit-panel">
              <section className="comm-profile-edit-section">
                <h3 className="comm-profile-edit-section-title">Foto de perfil</h3>
                <div className="comm-profile-edit-avatar">
                  <img
                    src={avatarUrl || '/icon.svg'}
                    alt=""
                    width={112}
                    height={112}
                    referrerPolicy="no-referrer"
                  />
                  <label className="btn btn-sm btn-primary avatar-file-btn">
                    Enviar imagem
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp,image/gif"
                      hidden
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f)
                          void uploadMedia(f, 'avatar')
                            .then(setAvatarUrl)
                            .catch((err) => setError(err.message));
                      }}
                    />
                  </label>
                  <p className="muted">JPG, PNG, WEBP ou GIF · até 2 MB</p>
                  <label className="comm-field">
                    <span className="comm-field-label">URL externa</span>
                    <input
                      type="text"
                      inputMode="url"
                      value={avatarUrl}
                      onChange={(e) => setAvatarUrl(e.target.value)}
                      placeholder="https://… ou arquivo enviado"
                    />
                  </label>
                </div>
              </section>
              <section className="comm-profile-edit-section">
                <h3 className="comm-profile-edit-section-title">Identidade</h3>
                <div className="comm-profile-edit-readonly">
                  <span className="comm-field-label">Usuário de login</span>
                  <strong className="comm-profile-login-name">{initial.username || '—'}</strong>
                  <p className="muted">O login não pode ser alterado aqui.</p>
                </div>
                <label className="comm-field">
                  <span className="comm-field-label">Nome de exibição</span>
                  <span className="comm-field-desc">
                    Aparece nas mensagens, lista de membros e chamadas de voz.
                  </span>
                  <input
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    maxLength={128}
                    placeholder="Ex.: Alex · Farm CS2"
                    autoComplete="nickname"
                  />
                </label>
              </section>
            </div>
          ) : null}

          {tab === 'account' ? (
            <div className="comm-profile-edit-panel">
              <section className="comm-profile-edit-section">
                <h3 className="comm-profile-edit-section-title">Contato e segurança</h3>
                <label className="comm-field">
                  <span className="comm-field-label">WhatsApp</span>
                  <span className="comm-field-desc">
                    Número com DDI (ex.: +55 11 98765-4321). Usado para avisos da conta.
                    {phoneDisplay ? ` Atual: ${phoneDisplay}` : ''}
                  </span>
                  <input
                    type="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="+55 (11) 98765-4321"
                    autoComplete="tel"
                  />
                </label>
                <label className="comm-field">
                  <span className="comm-field-label">Nova senha</span>
                  <span className="comm-field-desc">Opcional — deixe em branco para manter a atual.</span>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    minLength={6}
                    placeholder="Mínimo 6 caracteres"
                    autoComplete="new-password"
                  />
                </label>
              </section>
            </div>
          ) : null}

          {tab === 'steam' ? (
            <SteamTabPanel
              active={open && tab === 'steam'}
              onOpenShowcase={() => {
                // Não fecha o perfil: abre o modal largo por cima
                onOpenSteamShowcase?.();
              }}
            />
          ) : null}

          {tab === 'stream' ? <StreamTabPanel active={open && tab === 'stream'} /> : null}

          {tab === 'history' ? (
            <div className="comm-profile-edit-panel" data-profile-panel="history">
              <Cs2MatchHistoryPanel />
              <Cs2GsiSettingsPanel />
              <section className="comm-profile-edit-section">
                <h3 className="comm-profile-edit-section-title">Acesso ao histórico Valve</h3>
                <p className="muted">
                  Sharecodes oficiais (Steam) ainda em migração — separado do GSI acima.
                </p>
              </section>
            </div>
          ) : null}
        </div>

        {error ? (
          <p className="comm-dialog-hint" style={{ color: 'var(--comm-danger)', padding: '0 20px' }}>
            {error}
          </p>
        ) : null}
        <footer className="comm-profile-edit-foot">
          <button type="button" className="btn" onClick={onClose}>
            {showSave ? 'Cancelar' : 'Fechar'}
          </button>
          {showSave ? (
            <button type="submit" className="btn btn-primary">
              Salvar alterações
            </button>
          ) : null}
        </footer>
      </form>
    </NativeDialog>
  );
}
