import { useCallback, useEffect, useState } from 'react';

export type Cs2GsiSnapshot = {
  at: number;
  provider?: {
    name?: string;
    appid?: number | null;
    steamid?: string;
    timestamp?: number | null;
  };
  map: {
    name: string;
    nameRaw: string;
    phase: string;
    round: number;
    scoreCt: number;
    scoreT: number;
    mode?: string;
  };
  round: { phase: string; bomb: string; winTeam: string };
  player: {
    name: string;
    steamid: string;
    team: string;
    activity: string;
    health: number;
    armor: number;
    helmet?: boolean;
    money: number;
    roundKills?: number;
    roundKillHs?: number;
    equipValue?: number;
    kills: number;
    assists: number;
    deaths: number;
    mvps: number;
    score: number;
    weapon: string;
  };
  bomb?: { state: string; countdown: number | null } | null;
  phaseCountdowns?: { phase: string; phaseEndsIn: number | null } | null;
  allplayersCount: number;
  roster?: Array<{
    name: string;
    steamid: string;
    team: string;
    health?: number;
    kills: number;
    assists: number;
    deaths: number;
    mvps: number;
    isSelf?: boolean;
  }>;
};

export type Cs2GsiHistoryMatch = {
  id: string;
  status?: 'live' | 'finished' | string;
  startedAt: number;
  updatedAt?: number;
  endedAt?: number | null;
  durationSec?: number;
  map?: string;
  mapRaw?: string;
  scoreCt?: number;
  scoreT?: number;
  result?: string;
  endReason?: string;
  hadAllplayers?: boolean;
  stats?: { kills: number; assists: number; deaths: number; mvps: number; score: number };
  roster?: Array<{
    name: string;
    steamid: string;
    team: string;
    kills: number;
    assists: number;
    deaths: number;
    mvps?: number;
    isSelf?: boolean;
  }>;
  events?: Array<{
    type: string;
    at: number;
    weapon?: string;
    winTeam?: string;
    round?: number;
    note?: string;
  }>;
  rounds?: Array<Record<string, unknown>>;
  player?: { name?: string; steamid?: string; team?: string };
  correlationHint?: {
    mapRaw?: string;
    startedBucket?: number;
    steamids?: string[];
  } | null;
  valve?: {
    share_code?: string;
    match_id?: string;
    demo_url?: string;
    map?: string;
    scoreCt?: number;
    scoreT?: number;
    enrichedAt?: number;
  } | null;
};

export type Cs2GsiStatus = {
  ok?: boolean;
  enabled?: boolean;
  listening?: boolean;
  receiving?: boolean;
  waiting?: boolean;
  port?: number;
  cfgDir?: string;
  cfgPath?: string;
  cfgName?: string;
  error?: string;
  snapshot?: Cs2GsiSnapshot | null;
  enabledSetting?: boolean;
  needsFolder?: boolean;
  autoDefault?: boolean;
};

function isDesktop() {
  return typeof window !== 'undefined' && !!window.sfDesktop?.gsiStatus;
}

export function useCs2Gsi() {
  const desktop = isDesktop();
  const [status, setStatus] = useState<Cs2GsiStatus | null>(null);
  const [snap, setSnap] = useState<Cs2GsiSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const refresh = useCallback(async () => {
    if (!desktop || !window.sfDesktop?.gsiStatus) return;
    try {
      const st = (await window.sfDesktop.gsiStatus()) as Cs2GsiStatus;
      setStatus(st);
      if (st?.snapshot) setSnap(st.snapshot);
    } catch {
      /* ignore */
    }
  }, [desktop]);

  useEffect(() => {
    if (!desktop) return;
    void refresh();
    const t = window.setInterval(() => void refresh(), 4000);
    const unsub = window.sfDesktop?.onGsiUpdate?.((payload) => {
      setSnap(payload as Cs2GsiSnapshot);
      setStatus((prev) => ({
        ...(prev || {}),
        receiving: true,
        waiting: false,
        listening: true,
        enabled: true,
        snapshot: payload as Cs2GsiSnapshot,
      }));
    });
    return () => {
      window.clearInterval(t);
      unsub?.();
    };
  }, [desktop, refresh]);

  async function run(action: 'enable' | 'redeploy' | 'disable') {
    if (!desktop || !window.sfDesktop) return;
    setBusy(true);
    setMsg('');
    try {
      const fn =
        action === 'enable'
          ? window.sfDesktop.gsiEnable
          : action === 'redeploy'
            ? window.sfDesktop.gsiRedeploy
            : window.sfDesktop.gsiDisable;
      const res = (await fn?.()) as Cs2GsiStatus & { ok?: boolean; error?: string };
      if (!res?.ok) {
        setMsg(res?.error || 'Falha na operação GSI');
      } else if (action === 'enable') {
        setMsg('GSI activo. Reinicie o CS2 se já estiver aberto para carregar o cfg.');
      } else if (action === 'redeploy') {
        setMsg('Cfg reimplantado. Reinicie o CS2 se o placar não actualizar.');
      } else {
        setMsg('GSI desactivado.');
      }
      await refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return { desktop, status, snap, busy, msg, setMsg, refresh, run };
}

/** Após gameover GSI → Nest auto-enrich (throttled) → funde Valve no histórico local. */
export function useCs2ValveAutoEnrich(enabled = true) {
  useEffect(() => {
    if (!enabled || !isDesktop() || !window.sfDesktop?.onGsiMatchSaved) return;
    const unsub = window.sfDesktop.onGsiMatchSaved((raw) => {
      const match = raw as Cs2GsiHistoryMatch;
      if (!match?.id) return;
      void (async () => {
        try {
          const res = await fetch('/api/cs2/matches/auto-enrich', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ gsi_match: match }),
          });
          const data = (await res.json().catch(() => ({}))) as {
            ok?: boolean;
            skipped?: boolean;
            match?: {
              share_code?: string;
              demo_url?: string;
              detail?: Record<string, unknown>;
              has_detail?: boolean;
            };
          };
          if (!data?.ok || data.skipped || !data.match) return;
          const valve = {
            share_code: data.match.share_code || '',
            demo_url: data.match.demo_url || '',
            detail: data.match.detail || {},
            ...(data.match.detail || {}),
          };
          await window.sfDesktop?.gsiHistoryMergeValve?.(match.id, valve);
        } catch {
          /* ignore — enrich é best-effort */
        }
      })();
    });
    return () => unsub?.();
  }, [enabled]);
}
