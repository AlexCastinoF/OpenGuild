import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Link2, RefreshCw, X } from 'lucide-react';
import { api } from '../lib/api';
import { clearSteamLinkPending, isSteamLinkPending, startSteamLink } from '../lib/steamLink';
import { NativeDialog } from './NativeDialog';
import { SkinPickItem, type SkinItem } from './SkinPickItem';

export type SteamItem = SkinItem;

type SteamMe = {
  steam_linked: boolean;
  steam_id64: string;
  steam_persona: string;
  steam_avatar: string;
  has_trade_url: boolean;
  steam_trade_url?: string;
  steam_profile_url?: string;
  showcase_items: SteamItem[];
};

type TradeRow = {
  id: number;
  status: string;
  status_label: string;
  message: string;
  proposer_user_id: number;
  partner_user_id: number;
  proposer_items: SteamItem[];
  partner_items: SteamItem[];
  proposer_user: { id: number; label: string; avatar_url: string };
  partner_user: { id: number; label: string; avatar_url: string };
  proposer: { steam_trade_url?: string; steam_profile_url?: string };
  partner: { steam_trade_url?: string; steam_profile_url?: string };
};

function ItemTile({
  item,
  selected,
  selectedIndex,
  onToggle,
}: {
  item: SteamItem;
  selected?: boolean;
  selectedIndex?: number;
  onToggle?: () => void;
}) {
  return (
    <SkinPickItem
      item={item}
      selected={selected}
      selectedIndex={selectedIndex}
      onToggle={onToggle}
    />
  );
}

export function SteamSetupDialog({
  open,
  onClose,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const [me, setMe] = useState<SteamMe | null>(null);
  const [items, setItems] = useState<SteamItem[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [tradeUrl, setTradeUrl] = useState('');
  const [filter, setFilter] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [loading, setLoading] = useState(false);
  const [linking, setLinking] = useState(false);
  const waitLinkRef = useRef(false);

  async function reload(refresh = false) {
    setLoading(true);
    try {
      const m = await api<SteamMe>('/api/steam/me');
      setMe(m);
      setTradeUrl(m.steam_trade_url || '');
      setPicked((m.showcase_items || []).map((i) => i.assetid));
      if (m.steam_linked) {
        waitLinkRef.current = false;
        clearSteamLinkPending();
        setError('');
        const inv = await api<{ ok: boolean; items: SteamItem[]; message?: string }>(
          `/api/steam/inventory${refresh ? '?refresh=1' : ''}`,
        );
        if (!inv.ok) setInfo(inv.message || 'Inventário indisponível');
        else setInfo(`${inv.items.length} itens`);
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
    if (!open) return;
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
  }, [open]);

  useEffect(() => {
    if (open) {
      const pending = sessionStorage.getItem('sf_steam_link_err');
      if (pending) {
        setError(pending);
        sessionStorage.removeItem('sf_steam_link_err');
      }
      void reload();
    }
  }, [open]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (i) =>
        i.name.toLowerCase().includes(q) ||
        (i.market_hash_name || '').toLowerCase().includes(q) ||
        (i.exterior || '').toLowerCase().includes(q),
    );
  }, [items, filter]);

  function toggle(id: string) {
    setPicked((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= 5) return prev;
      return [...prev, id];
    });
  }

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

  async function saveShowcase() {
    setError('');
    try {
      const byId = new Map(items.map((i) => [i.assetid, i]));
      const chosen = picked
        .map((id) => byId.get(id))
        .filter((x): x is SteamItem => !!x);
      if (picked.length && !chosen.length) {
        throw new Error('Itens selecionados não estão no inventário. Atualiza e tenta outra vez.');
      }
      const res = await api<{ ok?: boolean; saved?: number }>('/api/steam/showcase', {
        method: 'PUT',
        body: JSON.stringify({ items: chosen }),
      });
      setInfo(`Vitrine salva (${res.saved ?? chosen.length}/5)`);
      onSaved?.();
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

  return (
    <NativeDialog open={open} onClose={onClose} className="comm-dialog comm-dialog-wide">
      <div className="comm-dialog-form" onClick={(e) => e.stopPropagation()}>
        <h2>Steam CS2 · itens em destaque</h2>
        <p className="comm-dialog-hint">
          {error || info || 'Conecte a Steam, salve a Trade URL e escolha até 5 itens.'}
        </p>

        {!me?.steam_linked ? (
          <div className="form-actions" style={{ justifyContent: 'flex-start', flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn-primary"
              disabled={linking}
              onClick={() => void connectSteam()}
            >
              <Link2 size={16} /> {linking ? 'A abrir…' : 'Conectar Steam'}
            </button>
            <button type="button" className="btn" onClick={onClose}>
              Fechar
            </button>
          </div>
        ) : (
          <>
            <div className="comm-steam-linked">
              <img src={me.steam_avatar || '/icon.svg'} alt="" referrerPolicy="no-referrer" />
              <div>
                <strong>{me.steam_persona || 'Steam'}</strong>
                <p>{me.steam_id64}</p>
                <p>
                  {me.has_trade_url ? 'Trade URL configurada' : 'Trade URL ainda não salva'}
                </p>
              </div>
            </div>
            <div className="form-actions" style={{ justifyContent: 'flex-start', flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn"
                disabled={linking}
                onClick={() => void connectSteam()}
              >
                {linking ? 'A abrir…' : 'Trocar conta Steam'}
              </button>
              <button type="button" className="btn" onClick={() => void unlink()}>
                Desvincular
              </button>
            </div>

            <div className="comm-dialog-body">
              <label>
                Trade URL
                <input
                  type="url"
                  value={tradeUrl}
                  onChange={(e) => setTradeUrl(e.target.value)}
                  placeholder="https://steamcommunity.com/tradeoffer/new/?partner=…&token=…"
                />
              </label>
              <p className="muted" style={{ fontSize: '.78rem', margin: '.35rem 0 .6rem' }}>
                <a
                  href="https://steamcommunity.com/id/me/tradeoffers/privacy#trade_offer_access_url"
                  target="_blank"
                  rel="noreferrer"
                >
                  Como obter a Trade URL
                </a>
              </p>
              <div className="form-actions" style={{ justifyContent: 'flex-start' }}>
                <button type="button" className="btn" onClick={() => void saveTrade()}>
                  Salvar Trade URL
                </button>
              </div>
              <p className="comm-label">Itens em destaque (até 5) — aparecem abaixo do nome</p>
              <input
                type="search"
                className="comm-trade-filter"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filtrar inventário…"
              />
              <div className="comm-showcase-pick comm-showcase-pick-tall" data-comm-showcase-grid>
                {filtered.map((it) => {
                  const selIdx = picked.indexOf(it.assetid);
                  return (
                    <ItemTile
                      key={it.assetid}
                      item={it}
                      selected={selIdx >= 0}
                      selectedIndex={selIdx >= 0 ? selIdx : undefined}
                      onToggle={() => toggle(it.assetid)}
                    />
                  );
                })}
                {!filtered.length && !loading ? (
                  <p className="muted" style={{ gridColumn: '1 / -1' }}>
                    Nenhum item. Inventário CS2 precisa estar público.
                  </p>
                ) : null}
              </div>
              <p className="muted">{picked.length}/5 selecionados</p>
            </div>

            <div className="form-actions">
              <button type="button" className="btn btn-primary" onClick={() => void saveShowcase()}>
                Salvar itens
              </button>
              <button
                type="button"
                className="btn"
                disabled={loading}
                onClick={() => void reload(true)}
              >
                <RefreshCw size={14} /> Atualizar inventário
              </button>
              <button type="button" className="btn" onClick={onClose}>
                Fechar
              </button>
            </div>
          </>
        )}
      </div>
    </NativeDialog>
  );
}

export function TradesListDialog({
  open,
  onClose,
  myUserId,
}: {
  open: boolean;
  onClose: () => void;
  myUserId: number;
}) {
  const [trades, setTrades] = useState<TradeRow[]>([]);
  const [error, setError] = useState('');

  async function reload() {
    setError('');
    try {
      const d = await api<{ trades: TradeRow[] }>('/api/community/trades');
      setTrades(d.trades || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro');
    }
  }

  useEffect(() => {
    if (open) void reload();
  }, [open]);

  async function act(id: number, action: string) {
    try {
      await api(`/api/community/trades/${id}/${action}`, { method: 'POST', body: '{}' });
      void reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro');
    }
  }

  function statusClass(status: string) {
    if (status === 'completed') return 'is-ok';
    if (status === 'cancelled' || status === 'declined') return 'is-muted';
    if (status === 'steam_failed' || status === 'failed') return 'is-bad';
    if (status === 'proposed' || status === 'ready' || status === 'steam_sent' || status === 'steam_manual')
      return 'is-warn';
    return '';
  }

  return (
    <NativeDialog open={open} onClose={onClose} className="comm-dialog comm-dialog-wide comm-dialog-trades">
      <div className="comm-dialog-form" onClick={(e) => e.stopPropagation()}>
        <header className="comm-dialog-head">
          <div>
            <h2>Minhas trocas</h2>
            <p className="muted">Propostas e status com outros membros</p>
          </div>
          <button type="button" className="comm-dialog-x" onClick={onClose} aria-label="Fechar">
            <X size={18} />
          </button>
        </header>
        {error ? <div className="error">{error}</div> : null}
        <div className="comm-trades-list">
          {trades.length === 0 ? <p className="muted comm-trades-empty">Nenhuma troca ainda.</p> : null}
          {trades.map((t) => {
            const amPartner = t.partner_user_id === myUserId;
            const other = amPartner ? t.proposer_user : t.partner_user;
            const mineItems = amPartner ? t.partner_items : t.proposer_items;
            const theirItems = amPartner ? t.proposer_items : t.partner_items;
            const partnerUrl = amPartner ? t.proposer.steam_trade_url : t.partner.steam_trade_url;
            return (
              <article key={t.id} className={`comm-trade-card status-${t.status}`}>
                <header className="comm-trade-card-head">
                  <div className="comm-trade-card-who">
                    <img
                      className="comm-avatar"
                      src={other.avatar_url || '/icon.svg'}
                      alt=""
                      width={36}
                      height={36}
                      referrerPolicy="no-referrer"
                    />
                    <div>
                      <strong>{other.label}</strong>
                      <span className="muted">#{t.id}</span>
                    </div>
                  </div>
                  <span className={`comm-trade-status ${statusClass(t.status)}`}>
                    {t.status_label || t.status}
                  </span>
                </header>
                {t.message ? <p className="comm-trade-msg">{t.message}</p> : null}
                <div className="comm-trade-sides">
                  <div>
                    <span className="comm-trade-side-label">
                      Você {amPartner ? 'recebe' : 'oferece'}
                    </span>
                    <div className="comm-trade-chips">
                      {mineItems.length ? (
                        mineItems.map((i) => (
                          <span
                            key={i.assetid}
                            className="comm-trade-chip"
                            title={i.market_hash_name || i.name}
                            style={{ ['--skin-accent' as string]: i.rarity_color || '#8b9bb4' }}
                          >
                            <img src={i.icon || i.icon_large || '/icon.svg'} alt="" referrerPolicy="no-referrer" />
                            <em>{i.name}</em>
                          </span>
                        ))
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </div>
                  </div>
                  <div>
                    <span className="comm-trade-side-label">Outro lado</span>
                    <div className="comm-trade-chips">
                      {theirItems.length ? (
                        theirItems.map((i) => (
                          <span
                            key={i.assetid}
                            className="comm-trade-chip"
                            title={i.market_hash_name || i.name}
                            style={{ ['--skin-accent' as string]: i.rarity_color || '#8b9bb4' }}
                          >
                            <img src={i.icon || i.icon_large || '/icon.svg'} alt="" referrerPolicy="no-referrer" />
                            <em>{i.name}</em>
                          </span>
                        ))
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="comm-trade-actions">
                  {amPartner && t.status === 'proposed' ? (
                    <>
                      <button type="button" className="btn btn-primary btn-sm" onClick={() => void act(t.id, 'accept')}>
                        Aceitar
                      </button>
                      <button type="button" className="btn btn-sm btn-ghost" onClick={() => void act(t.id, 'decline')}>
                        Recusar
                      </button>
                    </>
                  ) : null}
                  {!amPartner && ['proposed', 'steam_manual', 'ready'].includes(t.status) ? (
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => void act(t.id, 'cancel')}>
                      Cancelar
                    </button>
                  ) : null}
                  {['steam_manual', 'ready', 'steam_sent'].includes(t.status) ? (
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => void act(t.id, 'complete')}>
                      Marcar concluída
                    </button>
                  ) : null}
                  {partnerUrl ? (
                    <a className="btn btn-sm btn-ghost" href={partnerUrl} target="_blank" rel="noreferrer">
                      Trade URL do parceiro
                    </a>
                  ) : null}
                </div>
              </article>
            );
          })}
        </div>
      </div>
    </NativeDialog>
  );
}

export function TradeComposerDialog({
  open,
  onClose,
  partner,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  partner: { id: number; label: string } | null;
  onDone: () => void;
}) {
  const [mine, setMine] = useState<SteamItem[]>([]);
  const [theirs, setTheirs] = useState<SteamItem[]>([]);
  const [give, setGive] = useState<string[]>([]);
  const [want, setWant] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const [filterMe, setFilterMe] = useState('');
  const [filterThem, setFilterThem] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open || !partner) return;
    setGive([]);
    setWant([]);
    setMessage('');
    setError('');
    void (async () => {
      try {
        const [a, b] = await Promise.all([
          api<{ ok: boolean; items: SteamItem[]; message?: string }>('/api/steam/inventory?refresh=1'),
          api<{ ok: boolean; items: SteamItem[]; message?: string }>(
            `/api/steam/inventory/${partner.id}?refresh=1`,
          ),
        ]);
        if (!a.ok) setError(a.message || 'Seu inventário indisponível');
        if (!b.ok) setError((e) => e || b.message || 'Inventário do parceiro indisponível');
        setMine(a.items || []);
        setTheirs(b.items || []);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Erro');
      }
    })();
  }, [open, partner]);

  function toggle(list: string[], setList: (v: string[]) => void, id: string) {
    setList(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!partner) return;
    setError('');
    try {
      await api('/api/community/trades', {
        method: 'POST',
        body: JSON.stringify({
          partner_id: partner.id,
          give_assetids: give,
          want_assetids: want,
          message,
        }),
      });
      onDone();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro');
    }
  }

  if (!partner) return null;

  const mineF = mine.filter(
    (i) => !filterMe || i.name.toLowerCase().includes(filterMe.toLowerCase()),
  );
  const theirsF = theirs.filter(
    (i) => !filterThem || i.name.toLowerCase().includes(filterThem.toLowerCase()),
  );
  const giveItems = give
    .map((id) => mine.find((i) => i.assetid === id))
    .filter(Boolean) as SteamItem[];
  const wantItems = want
    .map((id) => theirs.find((i) => i.assetid === id))
    .filter(Boolean) as SteamItem[];

  return (
    <NativeDialog open={open} onClose={onClose} className="comm-dialog comm-dialog-wide comm-dialog-trade-compose">
      <form className="comm-dialog-form" onSubmit={(e) => void submit(e)} onClick={(e) => e.stopPropagation()}>
        <header className="comm-dialog-head">
          <div>
            <h2>Propor troca</h2>
            <p className="muted">Com {partner.label}</p>
          </div>
          <button type="button" className="comm-dialog-x" onClick={onClose} aria-label="Fechar">
            <X size={18} />
          </button>
        </header>
        {error ? <div className="error">{error}</div> : null}

        <div className="comm-trade-selected is-tray">
          <p className="comm-label">Selecionados para a troca</p>
          <div className="comm-trade-selected-cols">
            <div>
              <em>Você oferece ({giveItems.length})</em>
              <div className="comm-trade-chips">
                {giveItems.length ? (
                  giveItems.map((i) => (
                    <button
                      key={i.assetid}
                      type="button"
                      className="comm-trade-chip is-removable"
                      title="Remover"
                      style={{ ['--skin-accent' as string]: i.rarity_color || '#8b9bb4' }}
                      onClick={() => toggle(give, setGive, i.assetid)}
                    >
                      <img src={i.icon || i.icon_large || '/icon.svg'} alt="" referrerPolicy="no-referrer" />
                      <em>{i.name}</em>
                    </button>
                  ))
                ) : (
                  <span className="muted">Clique nos seus itens abaixo</span>
                )}
              </div>
            </div>
            <div>
              <em>Você pede ({wantItems.length})</em>
              <div className="comm-trade-chips">
                {wantItems.length ? (
                  wantItems.map((i) => (
                    <button
                      key={i.assetid}
                      type="button"
                      className="comm-trade-chip is-removable"
                      title="Remover"
                      style={{ ['--skin-accent' as string]: i.rarity_color || '#8b9bb4' }}
                      onClick={() => toggle(want, setWant, i.assetid)}
                    >
                      <img src={i.icon || i.icon_large || '/icon.svg'} alt="" referrerPolicy="no-referrer" />
                      <em>{i.name}</em>
                    </button>
                  ))
                ) : (
                  <span className="muted">Clique nos itens dele(a) abaixo</span>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="comm-trade-cols">
          <div>
            <strong>Seu inventário</strong>
            <input
              className="comm-trade-filter"
              value={filterMe}
              onChange={(e) => setFilterMe(e.target.value)}
              placeholder="Filtrar seus itens…"
            />
            <div className="comm-showcase-pick">
              {mineF.map((it) => (
                <ItemTile
                  key={it.assetid}
                  item={it}
                  selected={give.includes(it.assetid)}
                  onToggle={() => toggle(give, setGive, it.assetid)}
                />
              ))}
            </div>
          </div>
          <div>
            <strong>Inventário de {partner.label}</strong>
            <input
              className="comm-trade-filter"
              value={filterThem}
              onChange={(e) => setFilterThem(e.target.value)}
              placeholder="Filtrar itens dele(a)…"
            />
            <div className="comm-showcase-pick">
              {theirsF.map((it) => (
                <ItemTile
                  key={it.assetid}
                  item={it}
                  selected={want.includes(it.assetid)}
                  onToggle={() => toggle(want, setWant, it.assetid)}
                />
              ))}
            </div>
          </div>
        </div>
        <label>
          Mensagem
          <input value={message} onChange={(e) => setMessage(e.target.value)} maxLength={500} placeholder="Opcional" />
        </label>
        <div className="form-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary" disabled={!give.length && !want.length}>
            Enviar proposta
          </button>
        </div>
      </form>
    </NativeDialog>
  );
}
