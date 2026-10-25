import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { MatchPlayer, PrivateMatch } from '../lib/privateMatch';
import { MAP_LABEL, mapAccent, mapLabel, mapPhoto } from '../lib/mapAssets';

const HIDDEN = '*******';

function fmtRating(n?: number) {
  const v = Math.max(0, Math.round(Number(n) || 0));
  return v.toLocaleString('pt-BR');
}

function teamCap(format?: string) {
  const m = String(format || '5v5').match(/(\d+)\s*v\s*(\d+)/i);
  return Math.max(1, Math.min(5, Number(m?.[1] || 5)));
}

function padTeam(players: MatchPlayer[], cap: number) {
  const rows: Array<MatchPlayer | null> = [...players];
  while (rows.length < cap) rows.push(null);
  return rows.slice(0, Math.max(cap, players.length));
}

function useSyncedLeft(endsAt: number, serverNow?: number) {
  const offset = useRef(0);
  useEffect(() => {
    if (serverNow) offset.current = Date.now() - serverNow;
  }, [serverNow, endsAt]);
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (!endsAt) {
      setLeft(0);
      return;
    }
    const tick = () =>
      setLeft(Math.max(0, Math.ceil((endsAt - (Date.now() - offset.current)) / 1000)));
    tick();
    const id = window.setInterval(tick, 200);
    return () => window.clearInterval(id);
  }, [endsAt]);
  return left;
}

function radarPoints(maps: string[], values: Record<string, number>, r: number) {
  if (!maps.length) return '';
  return maps
    .map((id, i) => {
      const ang = -Math.PI / 2 + (i * 2 * Math.PI) / maps.length;
      const v = Math.max(0.12, Math.min(1, values[id] ?? 0.5));
      return `${50 + Math.cos(ang) * r * v},${50 + Math.sin(ang) * r * v}`;
    })
    .join(' ');
}

function Slot(props: { p: MatchPlayer | null; mine?: boolean }) {
  return (
    <div className={`pv-slot${props.mine ? ' is-me' : ''}${!props.p ? ' is-empty' : ''}`}>
      <span className="pv-av" aria-hidden />
      <strong>{HIDDEN}</strong>
      <em>{HIDDEN}</em>
    </div>
  );
}

export function PremierVetoPanel(props: {
  match: PrivateMatch;
  userId?: number;
  busy?: boolean;
  onBan: (mapId: string) => void;
  onPickSide: (side: 'CT' | 'T') => void;
  onEnd?: () => void;
}) {
  const { match, userId } = props;
  const me = match.players.find((p) => p.userId === userId);
  const myTeam = (me?.team || '') as 'CT' | 'T' | '';
  const veto = match.veto;
  const maps = match.mapPool?.length ? match.mapPool : Object.keys(MAP_LABEL);
  const slice = veto?.slices[veto.sliceIndex];
  const pickSide = slice?.kind === 'pick_side';
  const iAmPicker = pickSide && !!userId && !!veto?.pickerUserId && veto.pickerUserId === userId;
  const myTurn = pickSide
    ? iAmPicker || (!veto?.pickerUserId && !!myTeam && veto?.turnTeam === myTeam)
    : !!myTeam && veto?.turnTeam === myTeam;
  const left = useSyncedLeft(veto?.turnEndsAt || match.voteEndsAt || 0, match.serverNow);
  const banned = useMemo(() => new Set((veto?.bans || []).map((b) => b.map)), [veto?.bans]);
  const voteCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const mapId of Object.values(match.votes || {})) {
      if (!mapId || banned.has(mapId)) continue;
      c[mapId] = (c[mapId] || 0) + 1;
    }
    return c;
  }, [match.votes, banned]);
  const myVote = match.votes[String(userId || '')];
  const cap = teamCap(match.format);
  const [hoverId, setHoverId] = useState<string | null>(null);

  const mine = match.players.filter(
    (p) => p.inviteStatus !== 'declined' && (!myTeam || p.team === myTeam),
  );
  const opp = match.players.filter(
    (p) => p.inviteStatus !== 'declined' && myTeam && p.team && p.team !== myTeam,
  );
  const mineRows = padTeam(mine, cap);
  const oppRows = padTeam(opp, cap);

  const myTotal =
    (myTeam === 'T' ? match.teamRating?.T : match.teamRating?.CT) ??
    mine.reduce((s, p) => s + (Number(p.rating) || 0), 0);
  const oppTotal =
    (myTeam === 'T' ? match.teamRating?.CT : match.teamRating?.T) ??
    opp.reduce((s, p) => s + (Number(p.rating) || 0), 0);

  const title = !slice
    ? 'Veto'
    : pickSide
      ? myTurn
        ? 'Escolhe o lado do teu time'
        : 'A aguardar um jogador escolher o lado'
      : myTurn
        ? slice.label
        : `A aguardar o adversário · ${slice.label}`;

  const radarR = 24;
  const mapR = 40;
  const radarUid = useId().replace(/:/g, '');
  const radarCt = match.radarCt || {};
  const radarT = match.radarT || {};
  const ambience = hoverId || myVote || veto?.mapsLeft?.[0] || maps[0];
  const ambiencePhoto = ambience ? mapPhoto(ambience) : '';
  const ambienceAccent = ambience ? mapAccent(ambience) : '#8aa0b8';

  return (
    <div
      className="pv-root"
      style={
        {
          '--pv-ambience': ambienceAccent,
          '--pv-ambience-photo': ambiencePhoto ? `url(${ambiencePhoto})` : 'none',
        } as CSSProperties
      }
    >
      <div className="pv-ambience" aria-hidden />
      <button type="button" className="pv-close" onClick={props.onEnd}>
        Encerrar
      </button>
      <ol className="pv-phases">
        {(veto?.slices || []).map((s, i) => (
          <li
            key={`${s.label}-${i}`}
            className={`${i === veto?.sliceIndex ? 'is-on' : ''} ${i < (veto?.sliceIndex || 0) ? 'is-done' : ''}`}
          >
            {s.label}
          </li>
        ))}
      </ol>

      <div className="pv-title">
        {myTurn && !pickSide ? <span className="pv-turn-dot" /> : <span className="pv-wait">⟳</span>}
        <h2>{title}</h2>
        <div className="pv-clock" aria-live="polite">
          <span>{left}</span>
          <small>s</small>
        </div>
      </div>

      <aside className="pv-col is-you">
        <div className="pv-col-head">
          <h3>
            <i /> O teu time
          </h3>
          <b className="pv-team-sum">{fmtRating(myTotal)}</b>
        </div>
        <div className="pv-slots">
          {mineRows.map((p, i) => (
            <Slot key={p ? p.userId : `empty-you-${i}`} p={p} mine={p?.userId === userId} />
          ))}
        </div>
      </aside>

      <div className="pv-wheel">
        <div className="pv-stage">
          <svg className="pv-radar" viewBox="0 0 100 100" aria-hidden>
            <defs>
              <linearGradient id={`${radarUid}-ct`} x1="20%" y1="10%" x2="80%" y2="90%">
                <stop offset="0%" stopColor="rgba(96,180,255,0.48)" />
                <stop offset="100%" stopColor="rgba(56,120,210,0.16)" />
              </linearGradient>
              <linearGradient id={`${radarUid}-t`} x1="80%" y1="10%" x2="20%" y2="90%">
                <stop offset="0%" stopColor="rgba(255,120,160,0.44)" />
                <stop offset="100%" stopColor="rgba(200,60,100,0.14)" />
              </linearGradient>
              <filter id={`${radarUid}-glow`} x="-30%" y="-30%" width="160%" height="160%">
                <feGaussianBlur stdDeviation="0.7" result="b" />
                <feMerge>
                  <feMergeNode in="b" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>
            {[0.34, 0.67, 1].map((k) => (
              <circle key={k} className="pv-grid" cx="50" cy="50" r={radarR * k} />
            ))}
            {maps.map((id, i) => {
              const ang = -Math.PI / 2 + (i * 2 * Math.PI) / maps.length;
              return (
                <line
                  key={id}
                  className="pv-axis"
                  x1={50}
                  y1={50}
                  x2={50 + Math.cos(ang) * radarR}
                  y2={50 + Math.sin(ang) * radarR}
                />
              );
            })}
            <polygon
              className="pv-fill is-t"
              points={radarPoints(maps, radarT, radarR)}
              fill={`url(#${radarUid}-t)`}
              filter={`url(#${radarUid}-glow)`}
            />
            <polygon
              className="pv-fill is-ct"
              points={radarPoints(maps, radarCt, radarR)}
              fill={`url(#${radarUid}-ct)`}
              filter={`url(#${radarUid}-glow)`}
            />
          </svg>

          {maps.map((id, i) => {
            const ang = -Math.PI / 2 + (i * 2 * Math.PI) / maps.length;
            const x = 50 + Math.cos(ang) * mapR;
            const y = 50 + Math.sin(ang) * mapR;
            const dead = banned.has(id);
            const last = (veto?.mapsLeft || []).length === 1 && veto?.mapsLeft[0] === id;
            const n = voteCounts[id] || 0;
            const accent = mapAccent(id);
            const label = mapLabel(id);
            return (
              <button
                key={id}
                type="button"
                className={`pv-map${dead ? ' is-ban' : ''}${last ? ' is-last' : ''}${myVote === id ? ' is-mine' : ''}${!pickSide && !dead ? ' is-live' : ''}`}
                style={
                  {
                    left: `${x}%`,
                    top: `${y}%`,
                    '--map-accent': accent,
                  } as CSSProperties
                }
                disabled={pickSide || dead || !!props.busy}
                onClick={() => props.onBan(id)}
                onMouseEnter={() => setHoverId(id)}
                onMouseLeave={() => setHoverId(null)}
                onFocus={() => setHoverId(id)}
                onBlur={() => setHoverId(null)}
                title={label}
                aria-label={label}
              >
                <img src={mapPhoto(id)} alt={label} decoding="async" />
                <span className="pv-map-shade" aria-hidden />
                <span className="pv-map-name">{label}</span>
                <span className="pv-map-votes">
                  {n} {n === 1 ? 'voto' : 'votos'}
                </span>
              </button>
            );
          })}

          {pickSide && myTurn ? (
            <div className="pv-side">
              <p className="pv-side-hint">Só tu escolhes. O teu time começa neste lado.</p>
              <div className="pv-side-actions">
                <button type="button" className="pv-side-btn is-ct" onClick={() => props.onPickSide('CT')}>
                  Começar CT
                </button>
                <button type="button" className="pv-side-btn is-t" onClick={() => props.onPickSide('T')}>
                  Começar TR
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <aside className="pv-col is-opp">
        <div className="pv-col-head">
          <h3>
            <i /> Adversário
          </h3>
          <b className="pv-team-sum">{fmtRating(oppTotal)}</b>
        </div>
        <div className="pv-slots">
          {oppRows.map((p, i) => (
            <Slot key={p ? p.userId : `empty-opp-${i}`} p={p} />
          ))}
        </div>
      </aside>
    </div>
  );
}
