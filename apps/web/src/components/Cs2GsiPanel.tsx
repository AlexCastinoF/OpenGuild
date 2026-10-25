import { useCallback, useEffect, useState } from 'react';
import { Crosshair, History } from 'lucide-react';
import { api } from '../lib/api';
import { useCs2Gsi, type Cs2GsiHistoryMatch, type Cs2GsiSnapshot } from '../lib/cs2Gsi';

function fmtWhen(ts?: number | null) {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '—';
  }
}

function fmtDur(sec?: number) {
  if (!sec || sec < 0) return '—';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s`;
}

function resultLabel(r?: string) {
  if (r === 'win') return 'Vitória';
  if (r === 'loss') return 'Derrota';
  if (r === 'draw') return 'Empate';
  return '';
}

function splitRoster(roster: Cs2GsiHistoryMatch['roster'], myTeam?: string) {
  const list = roster || [];
  const team = String(myTeam || list.find((p) => p.isSelf)?.team || '').toUpperCase();
  const allies = list.filter((p) => String(p.team || '').toUpperCase() === team);
  const enemies = list.filter((p) => String(p.team || '').toUpperCase() && String(p.team).toUpperCase() !== team);
  const unknown = list.filter((p) => !String(p.team || '').trim());
  return { allies, enemies, unknown, team };
}

function PlayerNames({
  title,
  players,
}: {
  title: string;
  players: NonNullable<Cs2GsiHistoryMatch['roster']>;
}) {
  if (!players.length) return null;
  return (
    <div className="cs2-gsi-team-block">
      <h5>{title}</h5>
      <ul className="cs2-gsi-roster">
        {players.map((p, i) => (
          <li key={`${p.steamid || p.name}-${i}`} className={p.isSelf ? 'is-self' : undefined}>
            <span className="cs2-gsi-roster-name">
              {p.name || 'Jogador'}
              {p.isSelf ? ' (você)' : ''}
            </span>
            <span className="cs2-gsi-roster-kd muted" title="Kills / Deaths">
              {p.kills ?? 0}/{p.deaths ?? 0}
              {p.assists != null ? ` · ${p.assists}A` : ''}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Chip compacto: partida (mapa/placar) ou lobby (só tipo de fila). */
export type Cs2LiveChipData = {
  at: number;
  map: string;
  scoreCt: number;
  scoreT: number;
  team: string;
  kills: number;
  deaths: number;
  health: number;
  kind?: 'match' | 'lobby';
  mode?: string;
  modeLabel?: string;
  phase?: string;
};

function labelCs2Mode(mode: string): string {
  const m = (mode || '').toLowerCase().trim();
  if (!m) return '';
  if (m.includes('premier') || m === 'competitive_teams') return 'Premier';
  if (m === 'competitive' || m.includes('competitive')) return 'Competitivo';
  if (m === 'scrimcomp2v2' || m.includes('wingman') || m.includes('2v2')) return 'Wingman';
  if (m === 'deathmatch' || m.includes('deathmatch')) return 'Deathmatch';
  if (m === 'casual' || m.includes('casual')) return 'Casual';
  if (m.includes('retake')) return 'Retake';
  if (m.includes('armsrace') || m.includes('gungame')) return 'Corrida armada';
  if (m.includes('dangerzone')) return 'Danger Zone';
  if (m.includes('workshop')) return 'Workshop';
  return mode.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** null = sem GSI útil (não publicar). */
export function cs2LiveFromSnap(
  snap: Cs2GsiSnapshot,
  prevMode?: { mode?: string; modeLabel?: string } | null,
): Cs2LiveChipData | null {
  const phase = String(snap.map.phase || '').toLowerCase();
  const activity = String(snap.player.activity || '').toLowerCase();
  const mode = String(snap.map.mode || '').trim() || String(prevMode?.mode || '').trim();
  const modeLabel =
    labelCs2Mode(String(snap.map.mode || '').trim()) ||
    String(prevMode?.modeLabel || '').trim() ||
    labelCs2Mode(mode);
  const rawMap = snap.map.name || snap.map.nameRaw || '';
  const mapName = rawMap ? rawMap.charAt(0).toUpperCase() + rawMap.slice(1) : '';
  const teamRaw = String(snap.player.team || '').toUpperCase();
  const team = teamRaw === 'CT' || teamRaw === 'T' ? teamRaw : '';

  const inMatch =
    ['live', 'warmup', 'intermission', 'gameover'].includes(phase) ||
    (activity === 'playing' && !!mapName);

  if (inMatch) {
    return {
      at: snap.at || Date.now(),
      map: mapName || 'CS2',
      scoreCt: snap.map.scoreCt ?? 0,
      scoreT: snap.map.scoreT ?? 0,
      team,
      kills: snap.player.kills ?? 0,
      deaths: snap.player.deaths ?? 0,
      health: snap.player.health ?? 0,
      kind: 'match',
      mode: String(snap.map.mode || mode || ''),
      modeLabel: labelCs2Mode(String(snap.map.mode || '')) || modeLabel,
      phase,
    };
  }

  // Lobby / menu: GSI raramente manda map.mode antes da partida.
  // Mostra tipo conhecido (atual ou último da sessão); senão "Lobby CS2".
  const cs2Open =
    Number(snap.provider?.appid) === 730 ||
    /cs2|counter-strike/i.test(String(snap.provider?.name || '')) ||
    activity === 'menu' ||
    activity === 'textinput' ||
    !!snap.at;

  if (!cs2Open) return null;

  return {
    at: snap.at || Date.now(),
    map: '',
    scoreCt: 0,
    scoreT: 0,
    team: '',
    kills: 0,
    deaths: 0,
    health: 0,
    kind: 'lobby',
    mode,
    modeLabel: modeLabel || 'Lobby CS2',
    phase,
  };
}

export function Cs2MemberLiveChip({
  snap,
  live,
  className,
  compact,
}: {
  snap?: Cs2GsiSnapshot | null;
  live?: Cs2LiveChipData | null;
  className?: string;
  compact?: boolean;
}) {
  const data: Cs2LiveChipData | null = live
    ? live
    : snap
      ? cs2LiveFromSnap(snap)
      : null;
  if (!data) return null;

  const isPrivateMatch =
    data.modeLabel === 'Partida privada' ||
    data.mode === 'dedicated' ||
    data.mode === 'private';
  // Scrim privada: não esconder por TTL curto (GSI/warmup falham e o badge sumia)
  const fresh =
    isPrivateMatch || Date.now() - (data.at || 0) < 45000;
  if (!fresh) return null;

  if (data.kind === 'lobby') {
    const label = data.modeLabel || data.mode || 'Lobby CS2';
    return (
      <span
        className={`comm-member-cs2 is-lobby${compact ? ' is-compact' : ''}${className ? ` ${className}` : ''}`}
        data-live="1"
        data-kind="lobby"
        title={`Lobby · ${label}`}
        onClick={(e) => e.stopPropagation()}
      >
        <span className="comm-member-cs2-dot" aria-hidden title="Lobby" />
        <span className="comm-member-cs2-map">{label}</span>
      </span>
    );
  }

  const mapName = data.map || 'CS2';
  const myTeam = data.team === 'CT' || data.team === 'T' ? data.team : '';
  const alive = (data.health ?? 0) > 0;
  const kills = data.kills ?? 0;
  const deaths = data.deaths ?? 0;
  const title = [
    mapName,
    data.modeLabel || '',
    `CT ${data.scoreCt}:${data.scoreT} TR`,
    myTeam ? `time ${myTeam === 'T' ? 'TR' : 'CT'}` : '',
    `K ${kills} D ${deaths}`,
    alive ? 'vivo' : 'morto',
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <span
      className={`comm-member-cs2${compact ? ' is-compact' : ''}${className ? ` ${className}` : ''}`}
      data-live="1"
      data-kind="match"
      data-team={myTeam || undefined}
      data-alive={alive ? '1' : '0'}
      title={title}
      onClick={(e) => e.stopPropagation()}
    >
      <span className="comm-member-cs2-dot" aria-hidden title={alive ? 'Vivo' : 'Morto'} />
      <span className="comm-member-cs2-map">{mapName}</span>
      <span className="comm-member-cs2-score" aria-label="Placar">
        <span className={`comm-member-cs2-side is-ct${myTeam === 'CT' ? ' is-mine' : ''}`}>
          CT{myTeam === 'CT' ? <span className="comm-member-cs2-check" aria-label="seu time">✓</span> : null}
        </span>
        <b>{data.scoreCt}</b>
        <span className="comm-member-cs2-vs">:</span>
        <b>{data.scoreT}</b>
        <span className={`comm-member-cs2-side is-t${myTeam === 'T' ? ' is-mine' : ''}`}>
          TR{myTeam === 'T' ? <span className="comm-member-cs2-check" aria-label="seu time">✓</span> : null}
        </span>
      </span>
      <span className="comm-member-cs2-kd" title="Kills / Deaths">
        K {kills} D {deaths}
      </span>
    </span>
  );
}

function ScoreboardCard({ snap }: { snap: Cs2GsiSnapshot }) {
  const live = Date.now() - (snap.at || 0) < 20000;
  const roster = snap.roster || [];
  const myTeam = String(snap.player.team || '').toUpperCase();
  const allies = roster.filter((p) => String(p.team || '').toUpperCase() === myTeam);
  const enemies = roster.filter((p) => String(p.team || '').toUpperCase() && String(p.team).toUpperCase() !== myTeam);

  return (
    <div className="cs2-gsi-scoreboard" data-live={live ? '1' : '0'}>
      <Cs2MemberLiveChip snap={snap} className="cs2-gsi-scoreboard-chip" />
      <div className="cs2-gsi-scoreboard-head">
        <span className="muted">
          R{snap.map.round} · {snap.map.phase || snap.round.phase || '—'}
        </span>
      </div>
      <div className="cs2-gsi-player">
        <div>
          <strong>{snap.player.name || 'Você'}</strong>
          <span className="muted">
            {snap.player.team || '—'}
            {snap.player.weapon ? ` · ${snap.player.weapon}` : ''}
          </span>
        </div>
        <div className="cs2-gsi-kda">
          <span title="Kills">{snap.player.kills}</span>
          <span title="Assists">{snap.player.assists}</span>
          <span title="Deaths">{snap.player.deaths}</span>
        </div>
      </div>
      {roster.length > 1 ? (
        <div className="cs2-gsi-live-names">
          {allies.length ? (
            <p>
              <strong>Time:</strong> {allies.map((p) => p.name).filter(Boolean).join(', ')}
            </p>
          ) : null}
          {enemies.length ? (
            <p>
              <strong>Adversários:</strong> {enemies.map((p) => p.name).filter(Boolean).join(', ')}
            </p>
          ) : null}
        </div>
      ) : (
        <p className="muted cs2-gsi-live-names-hint">
          Nomes dos outros só aparecem se o CS2 enviar o roster (nem sempre em MM).
        </p>
      )}
    </div>
  );
}

/** Painel principal de histórico de partidas. */
export function Cs2MatchHistoryPanel({ compact }: { compact?: boolean }) {
  const [matches, setMatches] = useState<Cs2GsiHistoryMatch[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Cs2GsiHistoryMatch | null>(null);
  const desktop = typeof window !== 'undefined' && !!window.sfDesktop?.gsiHistory;

  const load = useCallback(async () => {
    if (!window.sfDesktop?.gsiHistory) return;
    const res = await window.sfDesktop.gsiHistory({ limit: compact ? 8 : 40 });
    setMatches((res?.matches || []) as Cs2GsiHistoryMatch[]);
  }, [compact]);

  useEffect(() => {
    if (!desktop) return;
    void load();
    const t = window.setInterval(() => void load(), 2500);
    return () => window.clearInterval(t);
  }, [desktop, load]);

  async function openMatch(id: string) {
    if (openId === id) {
      setOpenId(null);
      setDetail(null);
      return;
    }
    setOpenId(id);
    const res = await window.sfDesktop?.gsiHistoryGet?.(id);
    setDetail((res?.match as Cs2GsiHistoryMatch) || null);
  }

  async function clearAll() {
    if (!window.confirm('Apagar todo o histórico local de partidas?')) return;
    await window.sfDesktop?.gsiHistoryClear?.();
    setOpenId(null);
    setDetail(null);
    await load();
  }

  if (!desktop) {
    return (
      <section className="comm-profile-edit-section cs2-gsi-history-panel">
        <h3 className="comm-profile-edit-section-title">Histórico de partidas CS2</h3>
        <p className="muted">Disponível no app Desktop (GSI grava as partidas neste PC).</p>
      </section>
    );
  }

  return (
    <section className={`comm-profile-edit-section cs2-gsi-history-panel${compact ? ' is-compact' : ''}`}>
      <div className="cs2-gsi-history-head">
        <h3 className="comm-profile-edit-section-title" style={{ margin: 0 }}>
          Histórico de partidas
        </h3>
        {!compact && matches.length ? (
          <button type="button" className="btn btn-sm" onClick={() => void clearAll()}>
            Limpar
          </button>
        ) : null}
      </div>
      <p className="muted" style={{ marginTop: 6 }}>
        O histórico monta-se <strong>durante</strong> a partida e actualiza sozinho. Clique numa para
        ver nomes e K/D.
      </p>

      {!matches.length ? (
        <div className="cs2-gsi-history-empty">
          <History size={22} aria-hidden />
          <p>
            Ainda não há partidas. Com o GSI activo, joga até ao <strong>fim do mapa</strong> — a
            partida aparece aqui automaticamente.
          </p>
        </div>
      ) : (
        <ul className="cs2-gsi-history-list">
          {matches.map((m) => {
            const namesPreview = (m.roster || [])
              .filter((p) => !p.isSelf && p.name)
              .slice(0, 4)
              .map((p) => p.name)
              .join(', ');
            return (
              <li key={m.id}>
                <button
                  type="button"
                  className={`cs2-gsi-history-item${openId === m.id ? ' is-open' : ''}`}
                  onClick={() => void openMatch(m.id)}
                >
                  <div className="cs2-gsi-history-item-top">
                    <strong>{m.map || 'Mapa'}</strong>
                    <span className="cs2-gsi-history-score">
                      {m.scoreCt ?? 0}:{m.scoreT ?? 0}
                    </span>
                    {m.status === 'live' ? (
                      <span className="cs2-gsi-history-result is-live">Ao vivo</span>
                    ) : m.result ? (
                      <span className={`cs2-gsi-history-result is-${m.result}`}>
                        {resultLabel(m.result)}
                      </span>
                    ) : null}
                    <span className="cs2-gsi-src-badge is-gsi" title="Dados locais GSI">
                      GSI
                    </span>
                    {m.valve?.share_code || m.valve?.match_id ? (
                      <span className="cs2-gsi-src-badge is-valve" title="Enriquecido Valve">
                        Valve
                      </span>
                    ) : null}
                    {m.valve?.demo_url ? (
                      <span className="cs2-gsi-src-badge is-demo" title="Demo disponível">
                        Demo
                      </span>
                    ) : null}
                  </div>
                  <div className="cs2-gsi-history-item-meta muted">
                    Você {m.stats?.kills ?? 0}/{m.stats?.deaths ?? 0}
                    {m.stats?.assists != null ? `/${m.stats.assists}` : ''} · {fmtWhen(m.startedAt)} ·{' '}
                    {fmtDur(m.durationSec)}
                  </div>
                  {namesPreview ? (
                    <div className="cs2-gsi-history-names-preview muted">Com: {namesPreview}</div>
                  ) : (
                    <div className="cs2-gsi-history-names-preview muted">
                      Só o teu nome (CS2 não enviou roster dos outros)
                    </div>
                  )}
                </button>
                {openId === m.id && detail ? (
                  <div className="cs2-gsi-history-detail">
                    {detail.valve?.demo_url ? (
                      <p className="cs2-gsi-demo-link">
                        <a href={detail.valve.demo_url} target="_blank" rel="noreferrer">
                          Abrir replay / demo (Steam)
                        </a>
                        {detail.valve.share_code ? (
                          <span className="muted"> · {detail.valve.share_code}</span>
                        ) : null}
                      </p>
                    ) : null}
                    {(() => {
                      const { allies, enemies, unknown } = splitRoster(
                        detail.roster,
                        detail.player?.team || detail.roster?.find((p) => p.isSelf)?.team,
                      );
                      return (
                        <div className="cs2-gsi-teams">
                          <PlayerNames title="O teu time" players={allies} />
                          <PlayerNames title="Adversários" players={enemies} />
                          <PlayerNames title="Jogadores" players={unknown} />
                          {!allies.length && !enemies.length && !unknown.length ? (
                            <p className="muted">Sem nomes gravados nesta partida.</p>
                          ) : null}
                        </div>
                      );
                    })()}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Config GSI (automático; pode desativar). */
export function Cs2GsiSettingsPanel() {
  const { desktop, status, snap, busy, msg, run } = useCs2Gsi();

  if (!desktop) {
    return (
      <section className="comm-profile-edit-section">
        <h3 className="comm-profile-edit-section-title">Partidas CS2 ao vivo (GSI)</h3>
        <p className="muted">
          O placar em tempo real precisa do <strong>app Desktop</strong> SteamFarm Comunidade neste
          PC.
        </p>
        <Cs2ValveAuthPanel />
      </section>
    );
  }

  const enabled = status?.enabledSetting !== false;
  const stateLabel = !enabled
    ? 'Desactivado nas definições'
    : status?.receiving
      ? 'A receber dados do CS2'
      : status?.listening
        ? 'À espera do CS2'
        : status?.needsFolder || status?.error
          ? 'Activo — falta pasta cfg do CS2'
          : 'A activar…';

  return (
    <>
      <section className="comm-profile-edit-section cs2-gsi-settings">
        <h3 className="comm-profile-edit-section-title">Captura ao vivo (GSI)</h3>
        <p className="muted" style={{ marginTop: 0 }}>
          Ligado automaticamente ao abrir o Desktop. Escreve o ficheiro cfg na pasta do CS2 e
          escuta o placar em tempo real.
        </p>
        <label className="cs2-gsi-toggle">
          <input
            type="checkbox"
            checked={enabled}
            disabled={busy}
            onChange={(e) => {
              if (e.target.checked) void run('enable');
              else void run('disable');
            }}
          />
          <span>Integração CS2 automática</span>
        </label>
        <p className="cs2-gsi-state">
          Estado: <strong>{stateLabel}</strong>
          {status?.port ? <span className="muted"> · porta {status.port}</span> : null}
        </p>
        {status?.cfgDir ? (
          <p className="comm-dialog-hint muted" style={{ wordBreak: 'break-all' }}>
            cfg: {status.cfgDir}
          </p>
        ) : null}
        {status?.error ? (
          <p className="comm-dialog-hint" style={{ color: 'var(--comm-danger)' }}>
            {status.error}
          </p>
        ) : null}
        {msg ? <p className="comm-dialog-hint">{msg}</p> : null}
        <div className="cs2-gsi-actions">
          {enabled ? (
            <button type="button" className="btn" disabled={busy} onClick={() => void run('redeploy')}>
              Escolher pasta / reimplantar cfg
            </button>
          ) : null}
        </div>
        {snap ? <ScoreboardCard snap={snap} /> : null}
      </section>
      <Cs2ValveAuthPanel />
    </>
  );
}

type ValveStatus = {
  configured?: boolean;
  has_auth?: boolean;
  auto_enrich?: boolean;
  help_url?: string;
  api_key_configured?: boolean;
  steam_linked?: boolean;
  matches_cached?: number;
  matches_with_detail?: number;
  cooldown_sec?: number;
  max_sync_codes?: number;
};

/** Auth Valve uma vez: match auth code + sharecode seed + auto-enrich. */
export function Cs2ValveAuthPanel() {
  const [status, setStatus] = useState<ValveStatus | null>(null);
  const [authCode, setAuthCode] = useState('');
  const [knownCode, setKnownCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const refresh = useCallback(async () => {
    try {
      const st = await api<ValveStatus>('/api/cs2/matches/status');
      setStatus(st);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function save() {
    setBusy(true);
    setMsg('');
    try {
      const res = await api<{ ok?: boolean; status?: ValveStatus }>('/api/cs2/matches/auth', {
        method: 'POST',
        body: JSON.stringify({ auth_code: authCode, known_code: knownCode }),
      });
      setStatus(res.status || null);
      setAuthCode('');
      setKnownCode('');
      setMsg('Códigos guardados. Após cada partida o Desktop pede detalhes Valve (máx. 3 sync).');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    if (!window.confirm('Remover auth/sharecode Valve deste perfil?')) return;
    setBusy(true);
    try {
      const res = await api<{ status?: ValveStatus }>('/api/cs2/matches/auth', { method: 'DELETE' });
      setStatus(res.status || null);
      setMsg('Auth Valve removida.');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function toggleAuto(enabled: boolean) {
    setBusy(true);
    try {
      const res = await api<{ status?: ValveStatus }>('/api/cs2/matches/auto-enrich/toggle', {
        method: 'POST',
        body: JSON.stringify({ enabled }),
      });
      setStatus(res.status || null);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function runSync() {
    setBusy(true);
    setMsg('');
    try {
      const res = await api<{ ok?: boolean; added?: number; error?: string; soft?: boolean }>(
        '/api/cs2/matches/sync',
        { method: 'POST', body: '{}' },
      );
      setMsg(
        res.ok
          ? `Sync: ${res.added || 0} código(s) novo(s).`
          : res.error || 'Sync sem novos códigos.',
      );
      await refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="comm-profile-edit-section cs2-valve-auth">
      <h3 className="comm-profile-edit-section-title">Detalhes Valve (sharecode)</h3>
      <p className="muted" style={{ marginTop: 4 }}>
        Uma vez: autenticação de partida + sharecode recente. No fim de cada mapa o Desktop puxa até{' '}
        {status?.max_sync_codes || 3} códigos (com pausa) e 1 enriquecimento GC — só o link da demo,
        sem descarregar .dem no servidor.
      </p>
      {status?.help_url ? (
        <p className="comm-dialog-hint">
          <a href={status.help_url} target="_blank" rel="noreferrer">
            Obter códigos na Steam (ajuda CS2)
          </a>
        </p>
      ) : null}
      <p className="cs2-gsi-state">
        Estado:{' '}
        <strong>{status?.configured ? 'Configurado' : 'Por configurar'}</strong>
        {status?.matches_cached != null ? (
          <span className="muted">
            {' '}
            · {status.matches_cached} sharecodes
            {status.matches_with_detail != null ? ` · ${status.matches_with_detail} com detalhe` : ''}
          </span>
        ) : null}
      </p>
      {!status?.steam_linked ? (
        <p className="comm-dialog-hint" style={{ color: 'var(--comm-danger)' }}>
          Vincule a Steam no perfil antes.
        </p>
      ) : null}
      {!status?.api_key_configured ? (
        <p className="comm-dialog-hint muted">
          API key Steam ainda não vista pelo Nest (admin Flask ou STEAM_WEB_API_KEY).
        </p>
      ) : null}

      {!status?.configured ? (
        <div className="cs2-valve-fields">
          <label>
            Código de autenticação
            <input
              type="text"
              value={authCode}
              onChange={(e) => setAuthCode(e.target.value)}
              placeholder="XXXX-XXXXX-XXXX"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <label>
            Sharecode recente
            <input
              type="text"
              value={knownCode}
              onChange={(e) => setKnownCode(e.target.value)}
              placeholder="CSGO-xxxxx-xxxxx-xxxxx-xxxxx-xxxxx"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !authCode.trim() || !knownCode.trim()}
            onClick={() => void save()}
          >
            Guardar
          </button>
        </div>
      ) : (
        <div className="cs2-gsi-actions">
          <label className="cs2-valve-toggle">
            <input
              type="checkbox"
              checked={status.auto_enrich !== false}
              disabled={busy}
              onChange={(e) => void toggleAuto(e.target.checked)}
            />
            Auto-enrich após partida (cooldown {status.cooldown_sec || 90}s)
          </label>
          <button type="button" className="btn" disabled={busy} onClick={() => void runSync()}>
            Sync agora
          </button>
          <button type="button" className="btn" disabled={busy} onClick={() => void clear()}>
            Remover auth
          </button>
        </div>
      )}
      {msg ? <p className="comm-dialog-hint">{msg}</p> : null}
    </section>
  );
}

/** Overlay flutuante + atalho para histórico. */
export function Cs2GsiLiveOverlay({
  onOpenSettings,
  onOpenHistory,
  snap,
  status,
}: {
  onOpenSettings?: () => void;
  onOpenHistory?: () => void;
  snap?: Cs2GsiSnapshot | null;
  status?: import('../lib/cs2Gsi').Cs2GsiStatus | null;
}) {
  const desktop = typeof window !== 'undefined' && !!window.sfDesktop?.gsiStatus;
  const [expanded, setExpanded] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  if (!desktop) return null;
  if (!status?.listening && !status?.enabledSetting) return null;

  return (
    <div className={`cs2-gsi-float${snap && !expanded ? ' is-chip' : ''}`} role="status">
      <div className="cs2-gsi-float-bar">
        <Crosshair size={14} aria-hidden />
        <span>CS2</span>
        {snap ? (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setExpanded((v) => !v)}
            title={expanded ? 'Minimizar' : 'Expandir placar'}
          >
            {expanded ? '−' : '+'}
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => {
            if (onOpenHistory) onOpenHistory();
            else setShowHistory((v) => !v);
          }}
        >
          Histórico
        </button>
        {onOpenSettings ? (
          <button type="button" className="btn btn-sm" onClick={onOpenSettings}>
            Config
          </button>
        ) : null}
      </div>
      {snap ? (
        expanded ? (
          <ScoreboardCard snap={snap} />
        ) : (
          <Cs2MemberLiveChip snap={snap} className="cs2-gsi-float-chip" compact />
        )
      ) : (
        <p className="muted cs2-gsi-float-wait">À espera do CS2…</p>
      )}
      {showHistory && !onOpenHistory ? (
        <div className="cs2-gsi-float-history">
          <Cs2MatchHistoryPanel compact />
        </div>
      ) : null}
    </div>
  );
}
