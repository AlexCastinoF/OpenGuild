import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { NativeDialog } from './NativeDialog';
import { MatchAdminCvarForm, useAdminCvarFormState } from './MatchAdminCvarForm';
import {
  defaultAdminSettings,
  expandAdminCvarCommands,
  formatAdminExecError,
  suggestConsoleCommands,
  WELCOME_COLOR_OPTIONS,
  type AdminSettingsMap,
} from '../lib/matchAdminCvars';
import {
  defaultKillSoundsSettings,
  quakePreset,
  type KillSoundsSettings,
} from '../lib/killSounds';
import { KillSoundsForm } from './KillSoundsForm';
import type { BootInfo, HostServerOpts, MatchMode, PrivateMatch } from '../lib/privateMatch';
import { parsePackChangelog } from '../lib/packChangelog';
import { PremierVetoPanel } from './PremierVetoPanel';
import { api } from '../lib/api';

import { MAP_LABEL, mapKey as mapId, mapPhoto } from '../lib/mapAssets';

const MAP_BG: Record<string, string> = {
  mirage: 'linear-gradient(145deg,#2d4a38,#121a16)',
  inferno: 'linear-gradient(145deg,#5a3024,#1a100c)',
  dust2: 'linear-gradient(145deg,#8a6e3a,#1e1810)',
  nuke: 'linear-gradient(145deg,#3a5260,#101820)',
  ancient: 'linear-gradient(145deg,#2a4a3a,#0e1612)',
  anubis: 'linear-gradient(145deg,#8a6a32,#1a140c)',
};

export type InviteMember = {
  id: number;
  label?: string;
  display_name?: string;
  username?: string;
  online?: boolean;
};

function inviteMemberName(m: InviteMember) {
  return (m.label || m.display_name || m.username || `#${m.id}`).trim();
}

function InvitePick(props: {
  members: InviteMember[];
  mode: 'check' | 'chip';
  selectedIds?: number[];
  onToggle?: (id: number) => void;
  onInvite?: (id: number) => void;
  busy?: boolean;
}) {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<'all' | 'online' | 'offline'>('all');
  const onlineCount = props.members.filter((m) => m.online).length;
  const offlineCount = props.members.length - onlineCount;
  const shown = useMemo(() => {
    const query = q.trim().toLowerCase();
    return props.members
      .filter((m) => {
        if (filter === 'online' && !m.online) return false;
        if (filter === 'offline' && m.online) return false;
        if (query && !inviteMemberName(m).toLowerCase().includes(query)) return false;
        return true;
      })
      .sort((a, b) => {
        const on = Number(!!b.online) - Number(!!a.online);
        if (on) return on;
        return inviteMemberName(a).localeCompare(inviteMemberName(b), 'pt');
      });
  }, [props.members, q, filter]);

  if (!props.members.length) {
    return <p className="pm-muted">Sem outros membros — podes criar só contigo.</p>;
  }

  return (
    <div className="pm-invite-pick">
      <div className="pm-invite-toolbar">
        <input
          type="search"
          className="pm-invite-search"
          placeholder="Filtrar por nome…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Filtrar membros"
        />
        <div className="pm-invite-filters" role="group" aria-label="Filtro de presença">
          <button
            type="button"
            className={`pm-invite-filter${filter === 'all' ? ' is-on' : ''}`}
            onClick={() => setFilter('all')}
          >
            Todos <em>{props.members.length}</em>
          </button>
          <button
            type="button"
            className={`pm-invite-filter${filter === 'online' ? ' is-on' : ''}`}
            onClick={() => setFilter('online')}
          >
            Online <em>{onlineCount}</em>
          </button>
          <button
            type="button"
            className={`pm-invite-filter${filter === 'offline' ? ' is-on' : ''}`}
            onClick={() => setFilter('offline')}
          >
            Offline <em>{offlineCount}</em>
          </button>
        </div>
        {props.mode === 'check' && onlineCount > 0 ? (
          <button
            type="button"
            className="btn pm-btn-ghost pm-invite-select-online"
            onClick={() => {
              for (const m of props.members) {
                if (!m.online) continue;
                if (props.selectedIds?.includes(m.id)) continue;
                props.onToggle?.(m.id);
              }
            }}
          >
            Marcar online
          </button>
        ) : null}
      </div>
      {shown.length === 0 ? (
        <p className="pm-muted">Ninguém neste filtro.</p>
      ) : props.mode === 'check' ? (
        <ul>
          {shown.map((m) => {
            const on = !!props.selectedIds?.includes(m.id);
            return (
              <li key={m.id}>
                <label className={on ? 'is-on' : ''}>
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => props.onToggle?.(m.id)}
                  />
                  <span className="pm-invite-name">{inviteMemberName(m)}</span>
                  <span className={`pm-online-badge${m.online ? ' is-on' : ' is-off'}`}>
                    <i />
                    {m.online ? 'Online' : 'Offline'}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="pm-invite-row">
          {shown.map((m) => (
            <button
              key={m.id}
              type="button"
              className={`btn pm-chip${m.online ? ' is-online' : ''}`}
              disabled={props.busy}
              onClick={() => props.onInvite?.(m.id)}
            >
              <span className={`pm-online-dot${m.online ? ' is-on' : ''}`} />
              {inviteMemberName(m)}
              <span className={`pm-online-badge compact${m.online ? ' is-on' : ' is-off'}`}>
                {m.online ? 'Online' : 'Off'}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

type MatchPackIndexEntry = {
  version: string;
  publishedAt?: string | null;
  changelogSummary?: string;
};

type MatchPackManifest = {
  version?: string;
  changelog?: string;
  defaults?: Record<string, number>;
};

/** Aplica defaults do pack sem sobrescrever valores que o user já alterou face ao baseline. */
function mergePackDefaults(
  current: AdminSettingsMap,
  packDefaults: Record<string, number> | undefined,
  baseline: AdminSettingsMap,
): AdminSettingsMap {
  if (!packDefaults) return current;
  const out: AdminSettingsMap = { ...current };
  for (const [k, raw] of Object.entries(packDefaults)) {
    const n = Number(raw);
    if (!Number.isFinite(n)) continue;
    if (out[k] == null || out[k] === baseline[k]) out[k] = n;
  }
  return out;
}

function label(m: PrivateMatch) {
  return m.name || 'Partida privada';
}

function avatarFallback(name: string) {
  return (name || '?').slice(0, 2).toUpperCase();
}

export function PmSpinner(props: { label: string; sub?: string }) {
  return (
    <div className="pm-spinner-block" role="status" aria-live="polite">
      <div className="pm-spinner" aria-hidden />
      <strong>{props.label}</strong>
      {props.sub ? <span>{props.sub}</span> : null}
    </div>
  );
}

export function MatchConsoleKeyDialog(props: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  save: (vk: number) => Promise<{ ok?: boolean }>;
}) {
  const [options, setOptions] = useState<Array<{ vk: number; label: string }>>([]);
  const [vk, setVk] = useState(0xde);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!props.open || !window.sfDesktop?.matchConsoleKeyGet) return;
    void window.sfDesktop.matchConsoleKeyGet().then((r) => {
      if (r?.options?.length) setOptions(r.options);
      if (r?.consoleVk != null && r.consoleVk > 0) setVk(r.consoleVk);
      else setVk(0xde);
    });
  }, [props.open]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setErr('');
    try {
      const r = await props.save(vk);
      if (!r?.ok) {
        setErr('Não foi possível guardar.');
        return;
      }
      props.onSaved();
      props.onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <NativeDialog open={props.open} onClose={props.onClose} className="comm-dialog pm-dialog">
      <form className="pm-modal" onSubmit={(e) => void submit(e)}>
        <div className="pm-modal-hero">
          <p className="pm-kicker">Configuração CS2</p>
          <h2>Tecla da consola</h2>
          <p className="pm-lead">
            Diz-nos qual tecla abre a consola no teu CS2 (ex.: aspas &quot;). O app usa-a para colar o
            connect — sem isto o auto-connect não corre.
          </p>
        </div>
        <div className="pm-fields">
          <label>
            Tecla
            <select value={vk} onChange={(e) => setVk(Number(e.target.value))}>
              {(options.length
                ? options
                : [
                    { vk: 0xde, label: 'Aspas " (OEM_7)' },
                    { vk: 0xc0, label: '~ (OEM_3)' },
                  ]
              ).map((o) => (
                <option key={o.vk} value={o.vk}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {err ? <p className="pm-error">{err}</p> : null}
        <div className="pm-actions">
          <button type="button" className="btn pm-btn-ghost" onClick={props.onClose}>
            Depois
          </button>
          <button type="submit" className="btn btn-primary pm-btn" disabled={saving}>
            Guardar tecla
          </button>
        </div>
      </form>
    </NativeDialog>
  );
}

export function MatchInviteModal(props: {
  open: boolean;
  match: PrivateMatch | null;
  busy?: boolean;
  onAccept: () => void;
  onDecline: () => void;
  onClose: () => void;
}) {
  const { open, match, busy, onAccept, onDecline, onClose } = props;
  if (!match) return null;
  const host = match.players.find((p) => p.isHost);
  const dedi = match.mode === 'host_listen';
  return (
    <NativeDialog
      open={open}
      onClose={busy ? () => {} : onClose}
      className="comm-dialog pm-dialog"
    >
      <div className="pm-modal">
        <div className="pm-modal-hero">
          <span className={`pm-mode-badge ${dedi ? 'is-dedi' : 'is-valve'}`}>
            {dedi ? 'Dedicated' : 'Valve'}
          </span>
          <p className="pm-kicker">Convite de partida</p>
          <h2>{label(match)}</h2>
        </div>
        <div className="pm-peer">
          <div className="pm-av">{avatarFallback(host?.displayName || 'H')}</div>
          <div>
            <strong>{host?.displayName || 'Host'}</strong>
            <span>organizador · {match.format}</span>
          </div>
        </div>
        <ul className="pm-points">
          <li>{dedi ? `MR${match.mr} · mapa por voto (30s)` : 'Matchmaking Valve'}</li>
          <li>
            {dedi
              ? 'Connect automático só depois do dedicated 100% ready'
              : 'Abre o CS2 e entra na pool'}
          </li>
          <li>Stats e ranking no app (GSI)</li>
        </ul>
        <div className="pm-actions">
          <button type="button" className="btn pm-btn-ghost" disabled={busy} onClick={onDecline}>
            Recusar
          </button>
          <button type="button" className="btn btn-primary pm-btn" disabled={busy} onClick={onAccept}>
            Aceitar
          </button>
        </div>
      </div>
    </NativeDialog>
  );
}

export function MatchCreateDialog(props: {
  open: boolean;
  busy?: boolean;
  error?: string;
  members?: InviteMember[];
  onClose: () => void;
  onCreate: (input: {
    mode: MatchMode;
    name: string;
    room_password: string;
    format: string;
    mr: number;
    hostname: string;
    cheats: boolean;
    port: number;
    invite_ids: number[];
    admin_settings?: AdminSettingsMap;
    match_pack_version?: string;
    welcome_message?: string;
    welcome_color?: string;
    sound_settings?: KillSoundsSettings;
  }) => void | Promise<void>;
}) {
  const canHostListen =
    typeof window !== 'undefined' &&
    (!!window.sfDesktop?.matchPrepareHost || import.meta.env.DEV);
  const hasPackIpc =
    typeof window !== 'undefined' && typeof window.sfDesktop?.matchEnsurePack === 'function';
  const hasSoundIpc =
    typeof window !== 'undefined' && typeof window.sfDesktop?.matchSoundSettings === 'function';
  const [step, setStep] = useState(0);
  const [mode, setMode] = useState<MatchMode>(canHostListen ? 'host_listen' : 'valve');
  const [name, setName] = useState('Scrim');
  const [pass, setPass] = useState('');
  const [format, setFormat] = useState('5v5');
  const [mr, setMr] = useState(12);
  const [hostname, setHostname] = useState('SF Scrim');
  const [cheats, setCheats] = useState(false);
  const [inviteIds, setInviteIds] = useState<number[]>([]);
  const adminForm = useAdminCvarFormState(defaultAdminSettings());
  const [welcome, setWelcome] = useState('Partida Privada Castino.Tech');
  const [welcomeColor, setWelcomeColor] = useState('green');
  const [packVersions, setPackVersions] = useState<MatchPackIndexEntry[]>([]);
  const [packVersion, setPackVersion] = useState('');
  const [packChangelog, setPackChangelog] = useState('');
  const [packBusy, setPackBusy] = useState(false);
  const [packError, setPackError] = useState('');
  const [sounds, setSounds] = useState<KillSoundsSettings>(defaultKillSoundsSettings());
  const [botsEnabled, setBotsEnabled] = useState(false);
  const [botCount, setBotCount] = useState(5);
  const [botDifficulty, setBotDifficulty] = useState(1);
  const packBaselineRef = useRef<AdminSettingsMap>(defaultAdminSettings());
  const wasOpenRef = useRef(false);

  const steps =
    mode === 'host_listen'
      ? ['Modo', 'Partida', 'Servidor', 'Mensagem', 'Sons', 'Convidar']
      : ['Modo', 'Partida', 'Convidar'];
  const lastStep = steps.length - 1;
  const packChanges = parsePackChangelog(packChangelog);

  useEffect(() => {
    // Só reset na transição fechado→aberto (senão mid-edit volta ao default)
    if (props.open && !wasOpenRef.current) {
      setStep(0);
      setInviteIds([]);
      setMode(canHostListen ? 'host_listen' : 'valve');
      setName('Scrim');
      setPass('');
      setFormat('5v5');
      setMr(12);
      setHostname('SF Scrim');
      setCheats(false);
      adminForm.syncFrom(defaultAdminSettings(), { force: true });
      packBaselineRef.current = defaultAdminSettings();
      setWelcome('Partida Privada Castino.Tech');
      setWelcomeColor('green');
      setPackVersions([]);
      setPackVersion('');
      setPackChangelog('');
      setPackError('');
      setPackBusy(false);
      setSounds(quakePreset());
      setBotsEnabled(false);
      setBotCount(5);
      setBotDifficulty(1);
      // Carrega última escolha do host (se Desktop 1.2.38+)
      void (async () => {
        try {
          const prefs = await window.sfDesktop?.matchSoundPrefsGet?.();
          if (prefs?.settings && typeof prefs.settings === 'object') {
            const loaded = {
              ...quakePreset(),
              ...(prefs.settings as KillSoundsSettings),
              events: {
                ...quakePreset().events,
                ...((prefs.settings as KillSoundsSettings).events || {}),
              },
            };
            // Se prefs antigas vinham disabled sem escolha, mantém preset ligado
            if (!loaded.enabled && !prefs.settings.enabled) {
              loaded.enabled = true;
            }
            setSounds(loaded);
          }
        } catch {
          /* ignore */
        }
      })();
    }
    wasOpenRef.current = props.open;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset só ao abrir
  }, [props.open, canHostListen]);

  useEffect(() => {
    setStep((s) => Math.min(s, lastStep));
  }, [mode, lastStep]);

  useEffect(() => {
    if (!props.open || mode !== 'host_listen') return;
    let cancelled = false;
    void (async () => {
      try {
        const idx = await api<{
          latest?: string | null;
          versions?: MatchPackIndexEntry[];
        }>('/api/match-packs');
        if (cancelled) return;
        const list = Array.isArray(idx.versions) ? idx.versions : [];
        setPackVersions(list);
        const latest = String(idx.latest || list[0]?.version || '').trim();
        if (latest) setPackVersion((prev) => prev || latest);
      } catch (e) {
        if (!cancelled) {
          setPackError(e instanceof Error ? e.message : 'Não foi possível listar packs');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.open, mode]);

  useEffect(() => {
    if (!props.open || mode !== 'host_listen' || !packVersion) return;
    let cancelled = false;
    void (async () => {
      try {
        const man = await api<MatchPackManifest>(`/api/match-packs/${packVersion}`);
        if (cancelled) return;
        setPackChangelog(String(man.changelog || ''));
        const next = mergePackDefaults(
          adminForm.toSettings(),
          man.defaults,
          packBaselineRef.current,
        );
        packBaselineRef.current = {
          ...packBaselineRef.current,
          ...(man.defaults || {}),
        };
        // Sem force: se o host já editou cvars, não apagar a meio da digitação
        adminForm.syncFrom(next);
      } catch (e) {
        if (!cancelled) {
          setPackChangelog('');
          setPackError(e instanceof Error ? e.message : 'Manifesto do pack indisponível');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- só ao mudar versão
  }, [props.open, mode, packVersion]);

  // Ao mudar de passo, foca o 1.º campo editável (senão o teclado fica no botão Seguinte)
  useEffect(() => {
    if (!props.open || step === 0) return;
    const t = window.setTimeout(() => {
      const body = document.querySelector('.pm-dialog--create[open] .pm-modal-body');
      const field = body?.querySelector<HTMLElement>(
        'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([disabled]), textarea:not([disabled]), select:not([disabled])',
      );
      field?.focus({ preventScroll: true });
    }, 40);
    return () => window.clearTimeout(t);
  }, [props.open, step]);

  function toggleInvite(id: number) {
    setInviteIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function goNext() {
    setStep((s) => Math.min(lastStep, s + 1));
  }

  function goBack() {
    setStep((s) => Math.max(0, s - 1));
  }

  async function finishCreate() {
    if (packBusy || props.busy) return;
    const settings = adminForm.toSettings();
    if (cheats) settings.sv_cheats = 1;
    if (mode === 'host_listen') {
      settings.bot_quota = botsEnabled ? Math.min(10, Math.max(1, Math.round(botCount) || 5)) : 0;
      settings.bot_difficulty = botsEnabled ? Math.min(3, Math.max(0, Math.round(botDifficulty) || 1)) : 1;
    }
    let chosenPack = mode === 'host_listen' ? packVersion.trim() : '';
    setPackBusy(true);
    setPackError('');
    if (mode === 'host_listen' && chosenPack && hasPackIpc) {
      try {
        const ensured = await Promise.race([
          window.sfDesktop!.matchEnsurePack!(chosenPack),
          new Promise<never>((_, reject) => {
            window.setTimeout(() => reject(new Error('timeout_pack')), 20000);
          }),
        ]);
        if (ensured?.ok) {
          const merged = mergePackDefaults(settings, ensured.defaults, packBaselineRef.current);
          Object.assign(settings, merged);
          if (ensured.pluginVersion) chosenPack = ensured.pluginVersion;
        } else {
          setPackError(ensured?.error || 'Pack não descarregou — a criar a sala na mesma.');
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setPackError(
          msg === 'timeout_pack'
            ? 'Pack demorou demasiado — a criar a sala na mesma.'
            : `${msg} — a criar a sala na mesma.`,
        );
      }
    }
    try {
      await props.onCreate({
        mode,
        name: name.trim() || 'Scrim',
        room_password: pass,
        format,
        mr,
        hostname: (hostname || name).trim() || 'SF Scrim',
        cheats,
        port: 0,
        invite_ids: inviteIds,
        welcome_message: welcome.trim() || 'Partida Privada Castino.Tech',
        welcome_color: welcomeColor || 'green',
        admin_settings: mode === 'host_listen' ? settings : undefined,
        match_pack_version: mode === 'host_listen' && chosenPack ? chosenPack : undefined,
        sound_settings: mode === 'host_listen' ? sounds : undefined,
      });
    } catch (e) {
      setPackError(e instanceof Error ? e.message : String(e));
    } finally {
      setPackBusy(false);
    }
  }

  function submit(e: FormEvent) {
    // Enter nos inputs NÃO avança o wizard — só os botões Seguinte / Criar
    e.preventDefault();
    e.stopPropagation();
  }

  const isServerStep = mode === 'host_listen' && step === 2;
  const isMessageStep = mode === 'host_listen' && step === 3;
  const isSoundsStep = mode === 'host_listen' && step === 4;
  const isInviteStep = step === lastStep;
  const isOptionsStep = step === 1;

  return (
    <NativeDialog
      open={props.open}
      onClose={props.onClose}
      className="comm-dialog pm-dialog pm-dialog--create"
    >
      <form
        className="pm-modal pm-modal--wizard"
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        noValidate
      >
        <div className="pm-modal-hero">
          <div className="pm-modal-hero-row">
            <p className="pm-kicker">Nova partida</p>
            <span className="pm-step-count">
              {step + 1}/{steps.length}
            </span>
          </div>
          <h2>{steps[step]}</h2>
          <p className="pm-lead">
            {step === 0 && 'Onde queres correr a sala?'}
            {isOptionsStep && 'Nome, formato e acesso — a porta é automática.'}
            {isServerStep && 'Escolhe a versão e o essencial do dedicated.'}
            {isMessageStep && 'Mensagem de sistema no chat CS2 ao entrar na partida.'}
            {isSoundsStep && 'Sons Quake — só tu configuras; os outros ouvem.'}
            {isInviteStep && 'Convida membros — eles aceitam ou recusam.'}
          </p>
        </div>

        <div className="pm-wizard-steps" aria-hidden>
          {steps.map((label, i) => (
            <span key={label} className={i === step ? 'is-on' : i < step ? 'is-done' : ''}>
              {label}
            </span>
          ))}
        </div>

        <div className="pm-modal-body">
          {step === 0 ? (
            <div className="pm-mode-stack">
              <div className="pm-mode-grid">
                <button
                  type="button"
                  className={`pm-mode-card ${mode === 'valve' ? 'is-on' : ''}`}
                  onClick={() => setMode('valve')}
                >
                  <strong>Valve</strong>
                  <span>Private MM · party Steam</span>
                </button>
                <button
                  type="button"
                  className={`pm-mode-card is-dedi ${mode === 'host_listen' ? 'is-on' : ''}`}
                  onClick={() => canHostListen && setMode('host_listen')}
                  disabled={!canHostListen}
                  title={
                    canHostListen
                      ? undefined
                      : 'Precisa do Desktop (1.2.29+) para dedicated no teu PC'
                  }
                >
                  <strong>O teu PC</strong>
                  <span>
                    {canHostListen
                      ? 'Dedicated local · amigos no teu IP'
                      : 'Requer app Desktop 1.2.29+'}
                  </span>
                </button>
              </div>
              <p className="pm-mode-soon">Server VPS · em breve</p>
            </div>
          ) : null}

          {isOptionsStep ? (
            <div className="pm-fields pm-fields--dense">
              <div className="pm-fields-row">
                <label>
                  Nome da partida
                  <input value={name} onChange={(e) => setName(e.target.value)} />
                </label>
                <label>
                  Senha {mode === 'host_listen' ? '(CS2)' : '(sala)'}
                  <input
                    value={pass}
                    onChange={(e) => setPass(e.target.value)}
                    placeholder="opcional"
                  />
                </label>
              </div>
              <div className="pm-fields-row pm-fields-row-3">
                <label>
                  Formato
                  <select value={format} onChange={(e) => setFormat(e.target.value)}>
                    <option>5v5</option>
                    <option>2v2</option>
                    <option>1v1</option>
                  </select>
                </label>
                <label>
                  MR
                  <select
                    value={mr}
                    disabled={mode === 'valve'}
                    onChange={(e) => setMr(Number(e.target.value))}
                  >
                    <option value={12}>12</option>
                    <option value={15}>15</option>
                    <option value={8}>8</option>
                  </select>
                </label>
                {mode === 'host_listen' ? (
                  <label className="pm-toggle-chip-wrap">
                    Cheats
                    <span className="pm-toggle-chip">
                      <input
                        type="checkbox"
                        checked={cheats}
                        onChange={(e) => setCheats(e.target.checked)}
                      />
                      <span>{cheats ? 'Ligados' : 'Off'}</span>
                    </span>
                  </label>
                ) : (
                  <span />
                )}
              </div>
              {mode === 'host_listen' ? (
                <label>
                  Nome no status do server
                  <input
                    value={hostname}
                    onChange={(e) => setHostname(e.target.value)}
                    placeholder="SF Scrim"
                  />
                </label>
              ) : null}
              {mode === 'host_listen' ? (
                <div className="pm-bots-box">
                  <label className="pm-toggle-chip-wrap">
                    Bots
                    <span className="pm-toggle-chip">
                      <input
                        type="checkbox"
                        checked={botsEnabled}
                        onChange={(e) => setBotsEnabled(e.target.checked)}
                      />
                      <span>{botsEnabled ? 'Ligados' : 'Off'}</span>
                    </span>
                  </label>
                  {botsEnabled ? (
                    <div className="pm-fields-row">
                      <label>
                        Quantidade
                        <input
                          type="number"
                          min={1}
                          max={10}
                          value={botCount}
                          onChange={(e) =>
                            setBotCount(Math.min(10, Math.max(1, Number(e.target.value) || 1)))
                          }
                        />
                      </label>
                      <label>
                        Dificuldade
                        <select
                          value={botDifficulty}
                          onChange={(e) => setBotDifficulty(Number(e.target.value))}
                        >
                          <option value={0}>Fácil</option>
                          <option value={1}>Normal</option>
                          <option value={2}>Difícil</option>
                          <option value={3}>Expert</option>
                        </select>
                      </label>
                    </div>
                  ) : (
                    <p className="pm-hint">Podes ligar bots para preencher os slots vazios no dedicated.</p>
                  )}
                </div>
              ) : null}
            </div>
          ) : null}

          {isServerStep ? (
            <div className="pm-server-step">
              <div className="pm-pack-pick">
                <label>
                  Versão do servidor
                  <select
                    value={packVersion}
                    onChange={(e) => {
                      packBaselineRef.current = adminForm.toSettings();
                      adminForm.markClean();
                      setPackVersion(e.target.value);
                    }}
                    disabled={!packVersions.length || packBusy}
                  >
                    {!packVersions.length ? <option value="">A carregar…</option> : null}
                    {packVersions.map((v) => (
                      <option key={v.version} value={v.version}>
                        {v.version}
                        {v.version === packVersions[0]?.version ? ' · recomendada' : ''}
                      </option>
                    ))}
                  </select>
                </label>
                {!hasPackIpc ? (
                  <p className="pm-hint">Atualiza o Desktop uma vez para descarregar packs novos.</p>
                ) : null}
                {packError ? <p className="pm-error">{packError}</p> : null}
              </div>

              {packChanges.length > 0 ? (
                <section className="pm-pack-changelog" aria-label="Novidades desta versão">
                  <header>
                    <h3>Novidades · v{packVersion || '—'}</h3>
                    <span>Recursos e melhorias</span>
                  </header>
                  <ul>
                    {packChanges.map((item, i) => (
                      <li key={`${item.kind}-${i}`} className={`is-${item.kind}`}>
                        <span className="pm-change-ico" aria-hidden>
                          {item.kind === 'remove' ? '❌' : item.kind === 'add' ? '✅' : '•'}
                        </span>
                        <span>{item.text}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              <div className="pm-server-essentials">
                <p className="pm-hint">
                  Tempo e economia. Mensagem de sistema no passo seguinte; o resto no Admin depois
                  de criar.
                </p>
                <MatchAdminCvarForm
                  values={adminForm.values}
                  onChange={adminForm.setField}
                  tabs={['tempo', 'economia']}
                  compact
                />
              </div>
            </div>
          ) : null}

          {isMessageStep ? (
            <div className="pm-fields pm-fields--dense">
              <label>
                Mensagem de sistema (chat CS2)
                <input
                  value={welcome}
                  onChange={(e) => setWelcome(e.target.value)}
                  maxLength={200}
                  placeholder="Partida Privada Castino.Tech"
                />
              </label>
              <label>
                Cor da mensagem
                <select
                  value={welcomeColor}
                  onChange={(e) => setWelcomeColor(e.target.value)}
                >
                  {WELCOME_COLOR_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              <div className="pm-sysmsg-preview" aria-label="Pré-visualização">
                <span className="pm-muted" style={{ display: 'block', marginBottom: 4 }}>
                  Pré-visualização
                </span>
                <em>[Sistema]</em> {welcome.trim() || 'Partida Privada Castino.Tech'}
              </div>
              <p className="pm-hint">
                Aparece no chat do CS2 quando os jogadores entram. Independente dos anúncios de
                kill (vermelho).
              </p>
            </div>
          ) : null}

          {isSoundsStep ? (
            <KillSoundsForm
              value={sounds}
              onChange={setSounds}
              compact
              ipcMissing={!hasSoundIpc && !import.meta.env.DEV}
            />
          ) : null}

          {isInviteStep ? (
            <InvitePick
              members={props.members || []}
              mode="check"
              selectedIds={inviteIds}
              onToggle={toggleInvite}
            />
          ) : null}

          {props.error || packError ? (
            <p className="pm-error">{props.error || packError}</p>
          ) : null}
        </div>

        <div className="pm-actions">
          {step === 0 ? (
            <button type="button" className="btn pm-btn-ghost" onClick={props.onClose}>
              Cancelar
            </button>
          ) : (
            <button type="button" className="btn pm-btn-ghost" onClick={goBack}>
              Voltar
            </button>
          )}
          {step < lastStep ? (
            <button
              type="button"
              className="btn btn-primary pm-btn"
              disabled={props.busy || packBusy}
              onClick={goNext}
            >
              Seguinte
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary pm-btn"
              disabled={props.busy || packBusy}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                void finishCreate();
              }}
            >
              {props.busy || packBusy ? 'A criar…' : 'Criar sala'}
            </button>
          )}
        </div>
      </form>
    </NativeDialog>
  );
}

export function MatchConnectPrompt(props: {
  open: boolean;
  match: PrivateMatch | null;
  busy?: boolean;
  onYesOpen: () => void;
  onNoLaunch: () => void;
  onClose: () => void;
}) {
  if (!props.open || !props.match?.connect) return null;
  const c = props.match.connect;
  return (
    <NativeDialog open={props.open} onClose={props.onClose} className="comm-dialog pm-dialog">
      <div className="pm-modal">
        <div className="pm-modal-hero">
          <p className="pm-kicker">Entrar no server</p>
          <h2>O CS2 já está aberto?</h2>
          <p className="pm-lead">
            Vamos usar <code>steam://connect</code> e, se precisares, colar o connect só na janela
            do <strong>cliente</strong> (nunca no dedicated).
          </p>
        </div>
        <code className="pm-connect">
          {c.connectString || `connect ${c.host}:${c.port}`}
        </code>
        <div className="pm-actions">
          <button
            type="button"
            className="btn btn-primary pm-btn"
            disabled={props.busy}
            onClick={props.onYesOpen}
          >
            Sim — entrar agora
          </button>
          <button
            type="button"
            className="btn pm-btn"
            disabled={props.busy}
            onClick={props.onNoLaunch}
          >
            Não — abrir CS2 e entrar
          </button>
          <button type="button" className="btn pm-btn-ghost" onClick={props.onClose}>
            Depois
          </button>
        </div>
      </div>
    </NativeDialog>
  );
}

type DedicatedSnap = {
  running?: boolean;
  pid?: number | null;
  hostname?: string | null;
  map?: string | null;
  host?: string | null;
  port?: number | null;
  cheats?: boolean;
  playersInServer?: Array<{ name: string }>;
  logTail?: string;
};

export function DedicatedMonitor(props: { active: boolean; isHost: boolean }) {
  const [snap, setSnap] = useState<DedicatedSnap | null>(null);
  const [cmd, setCmd] = useState('');
  const [busyCmd, setBusyCmd] = useState(false);

  useEffect(() => {
    if (!props.active || !props.isHost || !window.sfDesktop?.matchDedicatedSnapshot) {
      setSnap(null);
      return;
    }
    let alive = true;
    const tick = async () => {
      try {
        const r = await window.sfDesktop?.matchDedicatedSnapshot?.();
        if (alive && r?.ok) setSnap(r);
      } catch {
        /* ignore */
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), 4000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [props.active, props.isHost]);

  const runCmd = async () => {
    if (!cmd.trim() || !window.sfDesktop?.matchDedicatedExec) return;
    setBusyCmd(true);
    try {
      await window.sfDesktop.matchDedicatedExec(cmd.trim());
      setCmd('');
      const r = await window.sfDesktop.matchDedicatedSnapshot?.();
      if (r?.ok) setSnap(r);
    } finally {
      setBusyCmd(false);
    }
  };

  if (!props.active || !props.isHost) return null;

  return (
    <section className="pm-section pm-monitor">
      <h3>Monitor do dedicated</h3>
      {!snap?.running ? (
        <PmSpinner label="A sincronizar…" sub="À espera do processo dedicated" />
      ) : (
        <>
          <div className="pm-monitor-grid">
            <div>
              <span className="pm-muted">Hostname</span>
              <strong>{snap.hostname || '—'}</strong>
            </div>
            <div>
              <span className="pm-muted">Mapa</span>
              <strong>{MAP_LABEL[snap.map || ''] || snap.map || '—'}</strong>
            </div>
            <div>
              <span className="pm-muted">Endpoint</span>
              <strong>
                {snap.host}:{snap.port}
              </strong>
            </div>
            <div>
              <span className="pm-muted">sv_cheats</span>
              <strong>{snap.cheats ? 'ON' : 'OFF'}</strong>
            </div>
            <div>
              <span className="pm-muted">PID</span>
              <strong>{snap.pid || '—'}</strong>
            </div>
          </div>

          <h4 className="pm-subh">Jogadores no server</h4>
          {snap.playersInServer?.length ? (
            <ul className="pm-player-list">
              {snap.playersInServer.map((p, i) => (
                <li key={`${p.name}-${i}`}>{p.name}</li>
              ))}
            </ul>
          ) : (
            <p className="pm-muted">Ninguém no status ainda — refresh a cada 4s.</p>
          )}

          {props.isHost ? (
            <div className="pm-invite-row" style={{ marginTop: 10 }}>
              <input
                className="pm-gslt-input"
                value={cmd}
                onChange={(e) => setCmd(e.target.value)}
                placeholder="Comando (ex: status, mp_restartgame 1, sv_cheats 1)"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void runCmd();
                }}
              />
              <button
                type="button"
                className="btn btn-primary pm-btn"
                disabled={busyCmd || !cmd.trim()}
                onClick={() => void runCmd()}
              >
                Executar
              </button>
              <button
                type="button"
                className="btn pm-btn-ghost"
                onClick={() => {
                  setCmd('sv_cheats 1');
                  void window.sfDesktop?.matchDedicatedExec?.('sv_cheats 1');
                }}
              >
                Cheats ON
              </button>
              <button
                type="button"
                className="btn pm-btn-ghost"
                onClick={() => {
                  void window.sfDesktop?.matchDedicatedExec?.('sv_cheats 0');
                }}
              >
                Cheats OFF
              </button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

export function MatchHistoryPanel(props: { open: boolean; serverId?: number }) {
  const [rows, setRows] = useState<Array<Record<string, unknown>>>([]);
  const [ranking, setRanking] = useState<
    Array<{ userId: number; displayName: string; username: string; rating: number }>
  >([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!props.open) return;
    setLoading(true);
    void (async () => {
      try {
        if (props.serverId) {
          const [hist, rank] = await Promise.all([
            api<{ matches?: Array<Record<string, unknown>> }>(
              `/api/private-match/server/${props.serverId}/history`,
            ),
            api<{ ranking?: Array<{ userId: number; displayName: string; username: string; rating: number }> }>(
              `/api/private-match/server/${props.serverId}/ranking`,
            ),
          ]);
          if (hist.matches?.length) setRows(hist.matches);
          setRanking(rank.ranking || []);
        }
        if (window.sfDesktop?.matchHistoryList && !props.serverId) {
          const r = await window.sfDesktop.matchHistoryList({ limit: 40 });
          setRows((r?.matches as Array<Record<string, unknown>>) || []);
        }
      } finally {
        setLoading(false);
      }
    })();
  }, [props.open, props.serverId]);

  const clear = async () => {
    await window.sfDesktop?.matchHistoryClear?.();
    setRows([]);
  };

  return (
    <section className="pm-section">
      <div className="pm-vote-head">
        <h3>Histórico de partidas</h3>
        <button type="button" className="btn pm-btn-ghost" onClick={() => void clear()}>
          Limpar
        </button>
      </div>
      {loading ? <PmSpinner label="A carregar histórico…" /> : null}
      {ranking.length ? (
        <ol className="pm-ranking-list">
          {ranking.slice(0, 15).map((p, i) => (
            <li key={p.userId}>
              <span>{i + 1}.</span>
              <strong>{p.displayName || p.username}</strong>
              <em>{p.rating.toLocaleString('pt-BR')}</em>
            </li>
          ))}
        </ol>
      ) : null}
      {!loading && !rows.length ? <p className="pm-muted">Sem partidas guardadas neste servidor.</p> : null}
      <ul className="pm-history-list">
        {rows.map((r) => {
          const ended = Number(r.endedAt) || 0;
          const map = String(r.map || '');
          return (
            <li key={String(r.id)}>
              <div>
                <strong>{String(r.name || 'Partida')}</strong>
                <span>
                  {MAP_LABEL[map] || map || '—'} · {String(r.format || '')} ·{' '}
                  {Number(r.scoreCt) || 0}:{Number(r.scoreT) || 0}
                </span>
              </div>
              <time>{ended ? new Date(ended).toLocaleString() : ''}</time>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function MatchAdminPanel(props: {
  match: PrivateMatch;
  gsiSnap?: import('../lib/cs2Gsi').Cs2GsiSnapshot | null;
}) {
  const adminForm = useAdminCvarFormState(props.match.adminSettings || defaultAdminSettings());
  const [welcome, setWelcome] = useState(props.match.welcomeMessage || 'Partida Privada Castino.Tech');
  const [welcomeColor, setWelcomeColor] = useState(props.match.welcomeColor || 'green');
  const [freeCmd, setFreeCmd] = useState('');
  const [freeSuggestOpen, setFreeSuggestOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [sounds, setSounds] = useState<KillSoundsSettings>(defaultKillSoundsSettings());
  const [soundMsg, setSoundMsg] = useState('');
  const freeSuggestions = suggestConsoleCommands(freeCmd, 10);

  useEffect(() => {
    // Só sincroniza ao mudar de partida — NÃO em cada match.updated (presence a cada 4s
    // apagava o que o host estava a escrever e o Aplicar gravava valores velhos).
    adminForm.syncFrom(props.match.adminSettings || defaultAdminSettings(), { force: true });
    setWelcome(props.match.welcomeMessage || 'Partida Privada Castino.Tech');
    setWelcomeColor(props.match.welcomeColor || 'green');
    void (async () => {
      try {
        const r = await window.sfDesktop?.matchSoundPrefsGet?.();
        if (r?.settings && typeof r.settings === 'object') {
          setSounds({
            ...defaultKillSoundsSettings(),
            ...(r.settings as KillSoundsSettings),
            events: {
              ...defaultKillSoundsSettings().events,
              ...((r.settings as KillSoundsSettings).events || {}),
            },
          });
        } else {
          setSounds(defaultKillSoundsSettings());
        }
      } catch {
        setSounds(defaultKillSoundsSettings());
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.match.id]);

  // Host: dedicated status + GSI → presença no painel (vivo/morto/SPEC/desconectado)
  useEffect(() => {
    const m = props.match;
    const live =
      m.status === 'live' || m.status === 'connecting' || m.status === 'host_booting';
    if (!live || m.mode !== 'host_listen') return;
    if (!window.sfDesktop?.matchDedicatedSnapshot) return;
    let stop = false;
    const tick = async () => {
      try {
        const snap = await window.sfDesktop!.matchDedicatedSnapshot!();
        if (stop) return;
        const inSrv = (snap?.playersInServer || []) as Array<{ name?: string; steamid?: string }>;
        const gsiRoster = props.gsiSnap?.roster || [];
        const rows = m.players
          .filter((p) => !p.simulated && p.userId > 0)
          .map((p) => {
            const sid = String(p.steamid || '').replace(/\D/g, '');
            const nameKey = (p.displayName || p.username || '').trim().toLowerCase();
            const hit =
              inSrv.find((x) => sid && String(x.steamid || '').replace(/\D/g, '') === sid) ||
              inSrv.find((x) => (x.name || '').trim().toLowerCase() === nameKey);
            const gsi =
              gsiRoster.find((g) => sid && String(g.steamid || '').replace(/\D/g, '') === sid) ||
              gsiRoster.find((g) => (g.name || '').trim().toLowerCase() === nameKey);
            const health = typeof gsi?.health === 'number' ? gsi.health : null;
            const selfPlayer = props.gsiSnap?.player;
            const selfSid = String(selfPlayer?.steamid || '').replace(/\D/g, '');
            const isSelfGsi = !!(sid && selfSid && sid === selfSid);
            const selfHealth =
              isSelfGsi && Number.isFinite(Number(selfPlayer?.health))
                ? Number(selfPlayer?.health)
                : null;
            const hp = health ?? selfHealth;
            const gTeamRaw = String(
              gsi?.team || (isSelfGsi ? selfPlayer?.team : '') || '',
            ).toUpperCase();
            const gameTeam =
              gTeamRaw === 'CT' || gTeamRaw === 'T' || gTeamRaw === 'SPEC'
                ? (gTeamRaw as 'CT' | 'T' | 'SPEC')
                : p.team === 'SPEC'
                  ? 'SPEC'
                  : '';
            const inServer = !!(hit || gsi || isSelfGsi || p.connected || p.inServer);
            // HP fresco do GSI; se sumiu do roster (saiu), NÃO forçar morto — mantém null
            const alive =
              hp != null
                ? hp > 0
                : hit || gsi || isSelfGsi
                  ? p.alive ?? null
                  : null;
            return {
              userId: p.userId,
              steamid: sid,
              name: p.displayName || p.username,
              // Sticky: mantém inServer se já estava / connected (warmup→live não pode derrubar)
              inServer,
              alive,
              health: hp,
              gameTeam:
                gameTeam ||
                (p.gameTeam === 'CT' || p.gameTeam === 'T' || p.gameTeam === 'SPEC'
                  ? p.gameTeam
                  : ''),
            };
          });
        await api(`/api/private-match/${m.id}/presence`, {
          method: 'POST',
          body: JSON.stringify({ players: rows }),
        });
        // Sempre alimenta Ao vivo com roster da partida (+ GSI se houver)
        const gsiSelf = props.gsiSnap?.player;
        const rosterStats = m.players
          .filter(
            (p) =>
              !p.simulated &&
              p.userId > 0 &&
              (p.inviteStatus === 'host' || p.inviteStatus === 'accepted') &&
              p.team !== 'SPEC',
          )
          .map((p) => {
            const sid = String(p.steamid || '').replace(/\D/g, '');
            const nameKey = (p.displayName || p.username || '').trim().toLowerCase();
            const g =
              gsiRoster.find((x) => sid && String(x.steamid || '').replace(/\D/g, '') === sid) ||
              gsiRoster.find((x) => (x.name || '').trim().toLowerCase() === nameKey);
            const self =
              gsiSelf &&
              sid &&
              String(gsiSelf.steamid || '').replace(/\D/g, '') === sid
                ? gsiSelf
                : null;
            const src = g || self;
            // Sem GSI deste jogador: não enviar K/D 0 (evita zerar métricas ao sair)
            if (!src) return null;
            return {
              userId: p.userId,
              name: p.displayName || p.username,
              steamid: sid || String(src?.steamid || ''),
              team: String(src?.team || p.gameTeam || p.team || ''),
              kills: Number(src?.kills) || 0,
              assists: Number(src?.assists) || 0,
              deaths: Number(src?.deaths) || 0,
              at: Date.now(),
            };
          })
          .filter((row): row is NonNullable<typeof row> => !!row);
        if (rosterStats.length) {
          await api(`/api/private-match/${m.id}/stats`, {
            method: 'POST',
            body: JSON.stringify({
              score_ct: props.gsiSnap?.map?.scoreCt,
              score_t: props.gsiSnap?.map?.scoreT,
              round: props.gsiSnap?.map?.round,
              merge: true,
              stats: rosterStats,
            }),
          });
        }
      } catch {
        /* ignore */
      }
    };
    void tick();
    const t = window.setInterval(() => void tick(), 4000);
    return () => {
      stop = true;
      window.clearInterval(t);
    };
  }, [
    props.match.id,
    props.match.status,
    props.match.mode,
    props.gsiSnap,
  ]);

  async function applySettings(extra?: { restart?: boolean }) {
    setBusy(true);
    setMsg('');
    try {
      const cvars = adminForm.toSettings();
      await api(`/api/private-match/${props.match.id}/admin-settings`, {
        method: 'POST',
        body: JSON.stringify(cvars),
      });
      if (!window.sfDesktop?.matchAdminSettings && !window.sfDesktop?.matchDedicatedExec) {
        setMsg(
          'Abre o Desktop SteamFarm (host) — estes botões só funcionam no Electron com dedicated a correr.',
        );
        return;
      }
      if (window.sfDesktop?.matchAdminSettings) {
        const r = await window.sfDesktop.matchAdminSettings({
          ...cvars,
          welcome_message: welcome,
          welcome_color: welcomeColor,
          restart: !!extra?.restart,
        });
        if (!r?.ok) {
          setMsg(`Falha: ${formatAdminExecError(r)}`);
          return;
        }
      } else if (window.sfDesktop?.matchDedicatedExec) {
        for (const c of expandAdminCvarCommands({
          ...cvars,
          restart: !!extra?.restart,
        })) {
          const r = await window.sfDesktop.matchDedicatedExec(c);
          if (r && r.ok === false) {
            setMsg(`Falha: ${formatAdminExecError(r)}`);
            return;
          }
        }
      }
      adminForm.markClean();
      setMsg(
        extra?.restart
          ? 'OK · plugin: teto 65k + wallet (kill/vitória no round seguinte)'
          : 'OK · plugin aplicou cvars. Kill/vitória usam a API de dinheiro (não o teto 16k).',
      );
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Falha');
    } finally {
      setBusy(false);
    }
  }

  async function applySounds() {
    setBusy(true);
    setSoundMsg('');
    try {
      if (!window.sfDesktop?.matchSoundSettings) {
        setSoundMsg('Atualiza o Desktop — IPC de sons em falta.');
        return;
      }
      const r = await window.sfDesktop.matchSoundSettings(sounds);
      if (!r?.ok) {
        setSoundMsg(`Falha: ${r?.error || 'erro'}`);
        return;
      }
      if (r.settings && typeof r.settings === 'object') {
        setSounds({
          ...defaultKillSoundsSettings(),
          ...(r.settings as KillSoundsSettings),
          events: {
            ...defaultKillSoundsSettings().events,
            ...((r.settings as KillSoundsSettings).events || {}),
          },
        });
      }
      setSoundMsg(
        sounds.enabled
          ? 'OK · sons ativos (Workshop Quake). Jogadores só ouvem — sem mute.'
          : 'OK · sons desligados.',
      );
    } catch (e) {
      setSoundMsg(e instanceof Error ? e.message : 'Falha');
    } finally {
      setBusy(false);
    }
  }

  async function bot(action: string) {
    setBusy(true);
    setMsg('');
    try {
      if (!window.sfDesktop?.matchAdminBots && !window.sfDesktop?.matchDedicatedExec) {
        setMsg('Bots só no Desktop com dedicated a correr.');
        return;
      }
      if (window.sfDesktop?.matchAdminBots) {
        const r = await window.sfDesktop.matchAdminBots(action);
        if (!r?.ok) {
          setMsg(`Falha bots: ${formatAdminExecError(r)}`);
          return;
        }
      } else if (window.sfDesktop?.matchDedicatedExec) {
        const map: Record<string, string> = {
          add_ct: 'bot_add_ct',
          add_t: 'bot_add_t',
          kick: 'bot_kick',
        };
        const r = await window.sfDesktop.matchDedicatedExec(map[action] || action);
        if (r && r.ok === false) {
          setMsg(`Falha bots: ${formatAdminExecError(r)}`);
          return;
        }
      }
      setMsg(
        action === 'add_ct'
          ? 'OK · bot CT (plugin confirmou)'
          : action === 'add_t'
            ? 'OK · bot TR (plugin confirmou)'
            : 'OK · bots removidos (plugin confirmou)',
      );
    } finally {
      setBusy(false);
    }
  }

  async function movePlayer(targetId: number, team: 'CT' | 'T' | 'SPEC') {
    setBusy(true);
    try {
      await api(`/api/private-match/${props.match.id}/host-team`, {
        method: 'POST',
        body: JSON.stringify({ target_id: targetId, team }),
      });
      setMsg(`Time → ${team}`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Falha');
    } finally {
      setBusy(false);
    }
  }

  async function runFree() {
    const c = freeCmd.trim();
    if (!c) {
      setMsg('Escreve um comando (ex: mp_maxmoney 60000).');
      return;
    }
    if (!window.sfDesktop?.matchDedicatedExec) {
      setMsg('Executar comando só no Desktop SteamFarm com dedicated a correr.');
      return;
    }
    setBusy(true);
    setMsg('');
    setFreeSuggestOpen(false);
    try {
      const r = await window.sfDesktop.matchDedicatedExec(c);
      if (!r?.ok) {
        setMsg(`Falha: ${formatAdminExecError(r)}`);
        return;
      }
      setMsg(`OK · plugin executou: ${c}`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Falha ao executar');
    } finally {
      setBusy(false);
    }
  }

  function pickSuggestion(cmd: string) {
    const rest = freeCmd.includes(' ') ? freeCmd.slice(freeCmd.indexOf(' ')) : ' ';
    setFreeCmd(cmd + (rest.startsWith(' ') ? rest : ` ${rest}`.trimEnd()));
    setFreeSuggestOpen(false);
  }

  function presenceLabel(p: PrivateMatch['players'][0]) {
    if (p.team === 'SPEC' || p.gameTeam === 'SPEC') return { key: 'spec', text: 'espectador' };
    if (!p.inServer && !p.connected) return { key: 'off', text: 'desconectado' };
    // Sticky inServer: se já esteve, não marcar morto só porque o GSI sumiu
    if (p.alive === false && typeof p.health === 'number') return { key: 'dead', text: 'morto' };
    if (p.alive === true) return { key: 'alive', text: 'vivo' };
    if (p.inServer || p.connected) return { key: 'on', text: 'no servidor' };
    return { key: 'off', text: 'desconectado' };
  }

  async function kickPlayer(p: PrivateMatch['players'][0]) {
    if (!window.sfDesktop?.matchDedicatedExec) {
      setMsg('Kick só no Desktop do host com dedicated a correr.');
      return;
    }
    setBusy(true);
    setMsg('');
    try {
      const safeName = String(p.displayName || p.username || '').replace(/"/g, '');
      if (!safeName) {
        setMsg('Sem nome para kick.');
        return;
      }
      const r = await window.sfDesktop.matchDedicatedExec(`kick "${safeName}"`);
      if (r && r.ok === false) {
        setMsg(`Kick falhou: ${formatAdminExecError(r)}`);
      } else {
        setMsg(`Kick enviado: ${safeName}`);
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Falha no kick');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="pm-section pm-admin">
      <h3>Admin · dedicated</h3>
      <p className="pm-solo-hint">
        Comandos vão pelo plugin (DLL 1.3.1+). No wizard, preenche o <strong>total</strong>{' '}
        desejado (ex.: kill 500). O jogo paga o padrão ($300 / ~$4000) e o plugin adiciona só a
        diferença com mensagem “dinheiro extra”. O teto sobe acima de $16k automaticamente.
        Reinicia o dedicated no Desktop para carregar o DLL.
      </p>
      <MatchAdminCvarForm
        values={adminForm.values}
        onChange={adminForm.setField}
        welcome={welcome}
        welcomeColor={welcomeColor}
        onWelcomeChange={setWelcome}
        onWelcomeColorChange={setWelcomeColor}
      />
      <div className="form-actions" style={{ justifyContent: 'flex-start', flexWrap: 'wrap', marginTop: 12 }}>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void applySettings()}>
          Aplicar
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => void applySettings({ restart: true })}
        >
          Aplicar + restart round
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => void bot('add_ct')}>
          Bot CT
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => void bot('add_t')}>
          Bot TR
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => void bot('kick')}>
          Remover bots
        </button>
      </div>
      {msg ? (
        <p
          className="pm-admin-msg"
          role="status"
          style={{
            marginTop: 10,
            padding: '8px 10px',
            borderRadius: 6,
            background: msg.startsWith('OK') || msg.startsWith('Time')
              ? 'rgba(46, 160, 67, 0.15)'
              : 'rgba(248, 81, 73, 0.12)',
            color: msg.startsWith('OK') || msg.startsWith('Time') ? '#3fb950' : '#f85149',
          }}
        >
          {msg}
        </p>
      ) : null}

      <div className="pm-admin-sounds" style={{ marginTop: 18 }}>
        <KillSoundsForm value={sounds} onChange={setSounds} disabled={busy} />
        <div style={{ marginTop: 10 }}>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void applySounds()}>
            Aplicar sons
          </button>
        </div>
        {soundMsg ? (
          <p
            className="pm-admin-msg"
            role="status"
            style={{
              marginTop: 8,
              padding: '8px 10px',
              borderRadius: 6,
              background: soundMsg.startsWith('OK')
                ? 'rgba(46, 160, 67, 0.15)'
                : 'rgba(248, 81, 73, 0.12)',
              color: soundMsg.startsWith('OK') ? '#3fb950' : '#f85149',
            }}
          >
            {soundMsg}
          </p>
        ) : null}
      </div>

      <div className="pm-admin-free" style={{ marginTop: 12, position: 'relative' }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            style={{ flex: 1 }}
            value={freeCmd}
            onChange={(e) => {
              setFreeCmd(e.target.value);
              setFreeSuggestOpen(true);
            }}
            onFocus={() => setFreeSuggestOpen(true)}
            onBlur={() => window.setTimeout(() => setFreeSuggestOpen(false), 150)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void runFree();
              } else if (e.key === 'Escape') {
                setFreeSuggestOpen(false);
              } else if (e.key === 'Tab' && freeSuggestOpen && freeSuggestions[0]) {
                e.preventDefault();
                pickSuggestion(freeSuggestions[0]);
              }
            }}
            placeholder="Comando (ex: mp_maxmoney 60000) — Tab completa"
            autoComplete="off"
            spellCheck={false}
          />
          <button type="button" className="btn" disabled={busy} onClick={() => void runFree()}>
            Executar
          </button>
        </div>
        {freeSuggestOpen && freeSuggestions.length > 0 ? (
          <ul
            className="pm-admin-cmd-suggest"
            style={{
              listStyle: 'none',
              margin: '4px 0 0',
              padding: 0,
              position: 'absolute',
              left: 0,
              right: 72,
              zIndex: 20,
              maxHeight: 220,
              overflow: 'auto',
              background: 'var(--sf-surface, #161b22)',
              border: '1px solid var(--sf-border, #30363d)',
              borderRadius: 6,
            }}
          >
            {freeSuggestions.map((s) => (
              <li key={s}>
                <button
                  type="button"
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    padding: '6px 10px',
                    background: 'transparent',
                    border: 0,
                    color: 'inherit',
                    cursor: 'pointer',
                    fontFamily: 'ui-monospace, Consolas, monospace',
                    fontSize: 13,
                  }}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pickSuggestion(s)}
                >
                  {s}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <h4 style={{ marginTop: 16 }}>Roster · times · estado</h4>
      <ul className="pm-admin-roster">
        {props.match.players
          .filter((p) => !p.simulated)
          .map((p) => {
            const st = presenceLabel(p);
            return (
              <li key={p.userId}>
                <span>
                  {p.displayName || p.username}{' '}
                  <small>
                    {p.steamid || 'sem Steam'} · {p.team || '?'}
                  </small>{' '}
                  <span className={`pm-presence is-${st.key}`}>{st.text}</span>
                </span>
                <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
                  <button type="button" className="btn" disabled={busy} onClick={() => void movePlayer(p.userId, 'CT')}>
                    CT
                  </button>
                  <button type="button" className="btn" disabled={busy} onClick={() => void movePlayer(p.userId, 'T')}>
                    TR
                  </button>
                  <button type="button" className="btn" disabled={busy} onClick={() => void movePlayer(p.userId, 'SPEC')}>
                    SPEC
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger"
                    disabled={busy || p.isHost}
                    title={p.isHost ? 'Não kickar o host' : `Kick ${p.displayName || p.username}`}
                    onClick={() => void kickPlayer(p)}
                  >
                    Kick
                  </button>
                </span>
              </li>
            );
          })}
      </ul>
    </section>
  );
}

export function MatchLobbyPanel(props: {
  match: PrivateMatch;
  userId?: number;
  members?: InviteMember[];
  busy?: boolean;
  bootInfo?: BootInfo | null;
  hostOpts?: HostServerOpts;
  needsConsoleKey?: boolean;
  gsiSnap?: import('../lib/cs2Gsi').Cs2GsiSnapshot | null;
  /** Incrementa ao aceitar/criar — força tab interna Lobby. */
  focusLobbyToken?: number;
  onOpenConsoleKey?: () => void;
  onReady: (ready: boolean) => void;
  onInvite: (targetId: number) => void;
  onStartVote: () => void;
  onEndVote: () => void;
  onVote: (mapId: string) => void;
  onPickSide?: (side: 'CT' | 'T') => void;
  onHostBoot: () => void;
  onValveStart: () => void;
  onReconnect: () => void;
  onEnd: () => void;
}) {
  const { match, userId } = props;
  const me = match.players.find((p) => p.userId === userId);
  const isHost = !!me?.isHost;
  const dedi = match.mode === 'host_listen';
  const [gslt, setGslt] = useState('');
  const [gsltInfo, setGsltInfo] = useState<{ hasToken?: boolean; tokenPreview?: string; url?: string }>(
    {},
  );
  const [gsltSaving, setGsltSaving] = useState(false);
  const [gsltEdit, setGsltEdit] = useState(false);
  const [tab, setTab] = useState<'lobby' | 'monitor' | 'history' | 'admin'>('lobby');
  /** Enquanto > Date.now(), não auto-saltar para Admin/Monitor (accept/criar). */
  const [forceLobbyUntil, setForceLobbyUntil] = useState(0);

  useEffect(() => {
    setTab('lobby');
    setForceLobbyUntil(Date.now() + 15000);
  }, [match.id, props.focusLobbyToken]);

  useEffect(() => {
    if (!dedi || !isHost || !window.sfDesktop?.matchGsltGet) return;
    void window.sfDesktop.matchGsltGet().then((r) => {
      if (r?.ok) {
        setGsltInfo(r);
        if (!r.hasToken) setGsltEdit(true);
      }
    });
  }, [dedi, isHost, props.bootInfo?.needsGslt, match.status]);

  useEffect(() => {
    if (match.status !== 'live' && match.status !== 'connecting' && match.status !== 'host_booting') {
      return;
    }
    // Aceitar convite: ficar no Lobby (não Monitor/Admin)
    if (Date.now() < forceLobbyUntil) {
      setTab('lobby');
      return;
    }
    // Convidados nunca auto-Monitor; host só Admin depois do force-lobby
    if (isHost && dedi) setTab('admin');
    else setTab('lobby');
  }, [match.status, isHost, dedi, forceLobbyUntil]);

  // Convidado: heartbeat GSI self → vivo/morto no lobby dos outros
  useEffect(() => {
    if (isHost || !userId) return;
    const live =
      match.status === 'live' || match.status === 'connecting' || match.status === 'host_booting';
    if (!live || match.mode !== 'host_listen') return;
    let stop = false;
    const tick = async () => {
      if (stop) return;
      try {
        const self = props.gsiSnap?.player;
        const sid = String(self?.steamid || me?.steamid || '').replace(/\D/g, '');
        const hp = Number.isFinite(Number(self?.health)) ? Number(self?.health) : null;
        const gTeamRaw = String(self?.team || '').toUpperCase();
        const gameTeam =
          gTeamRaw === 'CT' || gTeamRaw === 'T' || gTeamRaw === 'SPEC'
            ? (gTeamRaw as 'CT' | 'T' | 'SPEC')
            : '';
        await api(`/api/private-match/${match.id}/presence`, {
          method: 'POST',
          body: JSON.stringify({
            players: [
              {
                userId,
                steamid: sid,
                name: me?.displayName || me?.username,
                inServer: hp != null || !!me?.inServer || !!me?.connected,
                alive: hp == null ? me?.alive ?? null : hp > 0,
                health: hp,
                gameTeam: gameTeam || me?.team || '',
              },
            ],
          }),
        });
      } catch {
        /* ignore */
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), 4000);
    return () => {
      stop = true;
      window.clearInterval(id);
    };
  }, [
    isHost,
    userId,
    match.id,
    match.status,
    match.mode,
    props.gsiSnap?.player?.health,
    props.gsiSnap?.player?.steamid,
    props.gsiSnap?.player?.team,
    me?.steamid,
    me?.displayName,
    me?.username,
    me?.alive,
    me?.inServer,
    me?.connected,
    me?.team,
  ]);

  const saveGslt = async () => {
    if (!window.sfDesktop?.matchGsltSet || !gslt.trim()) return;
    setGsltSaving(true);
    try {
      const r = await window.sfDesktop.matchGsltSet(gslt.trim());
      if (r?.ok) {
        setGslt('');
        setGsltEdit(false);
        const g = await window.sfDesktop.matchGsltGet?.();
        if (g?.ok) setGsltInfo(g);
      }
    } finally {
      setGsltSaving(false);
    }
  };

  if (match.status === 'voting') {
    return (
      <PremierVetoPanel
        match={match}
        userId={userId}
        busy={props.busy}
        onBan={props.onVote}
        onPickSide={(side) => props.onPickSide?.(side)}
        onEnd={props.onEnd}
      />
    );
  }

  const inviteable = (props.members || []).filter(
    (m) => !match.players.some((p) => p.userId === m.id),
  );
  const lobbyPlayers = match.players.filter((p) => p.inviteStatus !== 'declined' && p.team !== 'SPEC');
  const readyCount = lobbyPlayers.filter((p) => p.ready).length;
  const readyTotal = lobbyPlayers.length;
  const allReady = readyTotal > 0 && readyCount === readyTotal;

  const booting =
    match.status === 'host_booting' ||
    props.bootInfo?.phase === 'booting' ||
    props.bootInfo?.phase === 'starting' ||
    props.bootInfo?.phase === 'connecting';
  const bootFailed = props.bootInfo?.phase === 'failed';
  const bootStep =
    props.bootInfo?.step ||
    props.bootInfo?.message ||
    (isHost ? 'A preparar dedicated…' : 'À espera do host…');

  return (
    <div className="pm-lobby">
      <header className="pm-lobby-head">
        <div>
          <span className={`pm-mode-badge ${dedi ? 'is-dedi' : 'is-valve'}`}>
            {dedi ? 'Dedicated' : 'Valve'}
          </span>
          <h2>{label(match)}</h2>
          <p>
            {match.format}
            {dedi ? ` · MR${match.mr}` : ''}
            {match.status === 'lobby' ? ' · À espera dos jogadores' : ` · ${match.status}`}
            {props.hostOpts?.hostname ? ` · ${props.hostOpts.hostname}` : ''}
          </p>
          {match.feed?.some((f) => f.type === 'system') ||
          match.status === 'host_booting' ||
          match.status === 'connecting' ||
          match.status === 'live' ? (
            <div className="comm-msg-system pm-system-notice" role="status">
              {match.feed?.find((f) => f.type === 'system')?.text ||
                match.welcomeMessage ||
                'Partida Privada Castino.Tech'}
            </div>
          ) : null}
        </div>
        {isHost ? (
          <button type="button" className="btn pm-btn-ghost" onClick={props.onEnd}>
            Encerrar
          </button>
        ) : null}
      </header>

      <div className="pm-tabs">
        <button
          type="button"
          className={tab === 'lobby' ? 'is-on' : ''}
          onClick={() => setTab('lobby')}
        >
          Lobby
        </button>
        <button
          type="button"
          className={tab === 'monitor' ? 'is-on' : ''}
          onClick={() => setTab('monitor')}
        >
          Monitor
        </button>
        {isHost &&
        dedi &&
        (match.status === 'host_booting' ||
          match.status === 'connecting' ||
          match.status === 'live') ? (
          <button
            type="button"
            className={tab === 'admin' ? 'is-on' : ''}
            onClick={() => setTab('admin')}
          >
            Admin
          </button>
        ) : null}
        <button
          type="button"
          className={tab === 'history' ? 'is-on' : ''}
          onClick={() => setTab('history')}
        >
          Histórico
        </button>
      </div>

      <div className="pm-lobby-scroll">
      {tab === 'history' ? <MatchHistoryPanel open serverId={match.serverId} /> : null}

      {tab === 'admin' && isHost && dedi ? (
        <MatchAdminPanel match={match} gsiSnap={props.gsiSnap} />
      ) : null}

      {tab === 'monitor' ? (
        <>
          {isHost ? (
            <DedicatedMonitor
              active={
                dedi &&
                (match.status === 'connecting' ||
                  match.status === 'live' ||
                  match.status === 'host_booting')
              }
              isHost={isHost}
            />
          ) : (
            <section className="pm-section">
              <h3>
                {match.status === 'live'
                  ? 'Em jogo'
                  : match.status === 'connecting'
                    ? 'A conectar'
                    : 'À espera do host'}
              </h3>
              <p className="pm-muted">
                O monitor do dedicated só está no PC do host. Usa o connect abaixo e o placar
                partilhado.
              </p>
            </section>
          )}
          {(match.status === 'connecting' || match.status === 'live') && match.connect ? (
            <section className="pm-section">
              <code className="pm-connect">{match.connect.connectString}</code>
              <button type="button" className="btn btn-primary pm-btn" onClick={props.onReconnect}>
                {isHost ? 'Reconnect / reiniciar dedicated' : 'Reconnect CS2'}
              </button>
            </section>
          ) : null}
          {match.status === 'live' && match.stats?.length ? (
            <section className="pm-section">
              <h3>Scoreboard</h3>
              <div className="pm-table-wrap">
                <table className="pm-table">
                  <thead>
                    <tr>
                      <th>Jogador</th>
                      <th>K</th>
                      <th>A</th>
                      <th>D</th>
                      <th>FK</th>
                      <th>ADR</th>
                    </tr>
                  </thead>
                  <tbody>
                    {match.stats.map((s, i) => (
                      <tr key={i}>
                        <td>{String(s.name || '')}</td>
                        <td>{String(s.kills ?? '')}</td>
                        <td>{String(s.assists ?? '')}</td>
                        <td>{String(s.deaths ?? '')}</td>
                        <td>{String(s.fk ?? '—')}</td>
                        <td>{String(s.adr ?? '—')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}
        </>
      ) : null}

      {tab !== 'lobby' ? null : (
        <>
          {props.needsConsoleKey ? (
            <section className="pm-section">
              <div className="pm-boot-status is-err">
                <strong>Tecla da consola</strong>
                <span>Guarda a tecla que abre a consola no teu CS2 antes do connect.</span>
                <button
                  type="button"
                  className="btn btn-primary pm-btn"
                  style={{ marginTop: 8 }}
                  onClick={props.onOpenConsoleKey}
                >
                  Escolher tecla
                </button>
              </div>
            </section>
          ) : null}

          {match.votedMap ? (
            <div className="pm-map-chosen">
              <img src={mapPhoto(match.votedMap)} alt="" />
              <span>
                Mapa: {MAP_LABEL[mapId(match.votedMap)] || match.votedMap}
                {match.veto?.startingSide ? ` · começa ${match.veto.startingSide}` : ''}
                {match.veto?.simulated ? ' · simulação' : ''}
              </span>
            </div>
          ) : null}

          {match.status === 'lobby' ? (
            <section className="pm-ready-hero">
              <div className="pm-ready-hero-copy">
                <h3>Sala de espera</h3>
                <p>
                  {allReady
                    ? 'Todos prontos — a contagem para o veto já começou.'
                    : 'Clica em Pronto para jogar quando estiveres preparado. O veto começa quando todos estiverem prontos.'}
                </p>
              </div>
              <div className="pm-ready-meter" aria-label="Progresso de prontos">
                <strong>
                  {readyCount}/{readyTotal}
                </strong>
                <span>prontos</span>
              </div>
            </section>
          ) : null}

          <div className="pm-roster-ready">
            {match.players
              .filter((p) => p.inviteStatus !== 'declined')
              .map((p) => (
                <div
                  key={p.userId}
                  className={`pm-ready-card${p.ready ? ' is-ready' : ''}${p.userId === userId ? ' is-me' : ''}`}
                >
                  {p.avatarUrl ? (
                    <img className="pm-av sm" src={p.avatarUrl} alt="" />
                  ) : (
                    <div className="pm-av sm">{avatarFallback(p.displayName)}</div>
                  )}
                  <div className="pm-slot-meta">
                    <strong>
                      {p.displayName}
                      {p.userId === userId ? ' (tu)' : ''}
                    </strong>
                    <span>
                      {p.isHost ? 'Host' : p.simulated ? 'Simulado' : 'Jogador'}
                      {p.inviteStatus === 'pending' ? ' · Convite' : ''}
                      {p.team === 'SPEC' ? ' · Espetador' : ''}
                    </span>
                  </div>
                  <span className={`pm-ready-pill${p.ready ? ' is-on' : ''}`}>
                    {p.inviteStatus === 'pending' ? 'Convite' : p.ready ? 'Pronto' : 'A aguardar'}
                  </span>
                </div>
              ))}
          </div>

          {match.status === 'lobby' && isHost && dedi ? (
            <section className="pm-section">
              {gsltInfo.hasToken && !gsltEdit ? (
                <div className="pm-gslt-ok">
                  <strong>GSLT OK</strong>
                  <span>{gsltInfo.tokenPreview}</span>
                  <button type="button" className="btn btn-sm" onClick={() => setGsltEdit(true)}>
                    Alterar
                  </button>
                </div>
              ) : (
                <>
                  <h3>GSLT · token do dedicated</h3>
                  <p className="pm-muted">
                    Obrigatório. Sem GSLT o CS2 mostra «AppID inválido». Cria em{' '}
                    <a
                      href={gsltInfo.url || 'https://steamcommunity.com/dev/managegameservers'}
                      target="_blank"
                      rel="noreferrer"
                    >
                      managegameservers
                    </a>{' '}
                    com <strong>App ID 730</strong>.
                  </p>
                  <div className="pm-invite-row">
                    <input
                      className="pm-gslt-input"
                      type="password"
                      autoComplete="off"
                      placeholder="Cola o GSLT aqui"
                      value={gslt}
                      onChange={(e) => setGslt(e.target.value)}
                    />
                    <button
                      type="button"
                      className="btn btn-primary pm-btn"
                      disabled={gsltSaving || !gslt.trim()}
                      onClick={() => void saveGslt()}
                    >
                      Guardar token
                    </button>
                    {gsltInfo.hasToken ? (
                      <button type="button" className="btn pm-btn-ghost" onClick={() => setGsltEdit(false)}>
                        Cancelar
                      </button>
                    ) : null}
                  </div>
                </>
              )}
              {props.hostOpts ? (
                <p className="pm-muted" style={{ marginTop: 8 }}>
                  Server: {props.hostOpts.hostname || '—'} · porta {props.hostOpts.port}
                  {props.hostOpts.cheats ? ' · sv_cheats ON' : ''}
                </p>
              ) : null}
            </section>
          ) : null}

          {match.status === 'lobby' && isHost ? (
            <details className="pm-invite-details">
              <summary>Convidar (opcional)</summary>
              {inviteable.length ? (
                <InvitePick
                  members={inviteable}
                  mode="chip"
                  busy={props.busy}
                  onInvite={props.onInvite}
                />
              ) : (
                <p className="pm-muted">Sem outros membros — podes iniciar sozinho.</p>
              )}
            </details>
          ) : null}

          {match.status === 'host_booting' || booting || bootFailed ? (
            <section className="pm-section">
              <h3>Mapa: {MAP_LABEL[mapId(match.votedMap)] || match.votedMap || '—'}</h3>
              {match.votedMap ? (
                <div className="pm-map-chosen">
                  <img src={mapPhoto(match.votedMap)} alt="" />
                  <span>{MAP_LABEL[mapId(match.votedMap)] || match.votedMap}</span>
                </div>
              ) : null}
              {!bootFailed ? (
                <PmSpinner
                  label={
                    props.bootInfo?.phase === 'connecting'
                      ? 'A conectar ao CS2…'
                      : props.bootInfo?.readyConfirmed
                        ? 'Dedicated ready'
                        : 'A subir dedicated…'
                  }
                  sub={bootStep}
                />
              ) : (
                <div className="pm-boot-status is-err">
                  <strong>Falhou</strong>
                  <span>{props.bootInfo?.message}</span>
                </div>
              )}
              {isHost && (props.bootInfo?.needsGslt || !gsltInfo.hasToken) ? (
                <div className="pm-boot-status is-err">
                  <strong>Falta GSLT</strong>
                  <span>Guarda o token e clica Iniciar dedicated.</span>
                  <div className="pm-invite-row" style={{ marginTop: 8 }}>
                    <input
                      className="pm-gslt-input"
                      type="password"
                      autoComplete="off"
                      placeholder="GSLT (App ID 730)"
                      value={gslt}
                      onChange={(e) => setGslt(e.target.value)}
                    />
                    <button
                      type="button"
                      className="btn btn-primary pm-btn"
                      disabled={gsltSaving || !gslt.trim()}
                      onClick={() => void saveGslt()}
                    >
                      Guardar
                    </button>
                  </div>
                </div>
              ) : null}
              {isHost ? (
                <button
                  type="button"
                  className="btn btn-primary pm-btn"
                  disabled={props.busy}
                  onClick={props.onHostBoot}
                >
                  {props.busy ? 'A iniciar…' : 'Iniciar dedicated · publicar'}
                </button>
              ) : null}
            </section>
          ) : null}

          {(match.status === 'connecting' || match.status === 'live') && match.connect ? (
            <section className="pm-section">
              <h3>{match.status === 'live' ? 'Em jogo' : 'A conectar'}</h3>
              {match.status === 'connecting' ? (
                <PmSpinner label="A enviar connect…" sub={bootStep} />
              ) : null}
              <code className="pm-connect">{match.connect.connectString}</code>
              <p className="pm-muted">
                Connect só depois do dedicated 100% ready (log + UDP). Usa a tecla da consola que
                guardaste.
              </p>
              <button type="button" className="btn btn-primary pm-btn" onClick={props.onReconnect}>
                {isHost ? 'Reconnect / reiniciar dedicated' : 'Reconnect CS2'}
              </button>
            </section>
          ) : null}
        </>
      )}
      </div>

      {tab === 'lobby' ? (
          <footer className="pm-lobby-foot">
            <div className="pm-ready-cta-wrap">
              {match.status === 'lobby' ? (
                <>
                  {!me?.ready ? (
                    <p className="pm-ready-cta-hint">
                      Clica para ficares pronto — o veto começa sozinho.
                    </p>
                  ) : (
                    <p className="pm-ready-cta-hint is-ready">Estás pronto. À espera dos outros…</p>
                  )}
                  <button
                    type="button"
                    className={`btn btn-primary pm-btn pm-ready-cta${me?.ready ? ' is-ready' : ' is-pulse'}`}
                    disabled={props.busy || me?.inviteStatus === 'pending'}
                    onClick={() => props.onReady(!me?.ready)}
                  >
                    {me?.ready ? 'Cancelar pronto' : 'Pronto para jogar'}
                  </button>
                </>
              ) : null}
            </div>
            <div className="pm-lobby-foot-secondary">
              {match.status === 'lobby' && isHost && !dedi ? (
                <button type="button" className="btn btn-primary pm-btn" onClick={props.onValveStart}>
                  Iniciar Valve
                </button>
              ) : null}
              <button type="button" className="btn pm-btn-ghost" onClick={props.onOpenConsoleKey}>
                Tecla consola
              </button>
            </div>
          </footer>
      ) : null}
    </div>
  );
}

export function MatchSessionBanner(props: {
  match: PrivateMatch | null;
  onReconnect: () => void;
  onOpen: () => void;
}) {
  const m = props.match;
  if (!m || m.status === 'ended' || m.status === 'lobby' || m.status === 'voting') return null;
  const dedi = m.mode === 'host_listen';
  return (
    <div className={`pm-banner ${m.status === 'live' ? 'is-live' : ''}`} role="status">
      <div>
        <strong>{label(m)}</strong>
        <span>
          {dedi ? 'Dedicated' : 'Valve'} · {m.status}
          {m.votedMap ? ` · ${MAP_LABEL[m.votedMap] || m.votedMap}` : ''}
        </span>
      </div>
      <div className="pm-banner-actions">
        {m.status === 'host_booting' ||
        ((m.status === 'connecting' || m.status === 'live') && m.connect) ? (
          <button type="button" className="btn btn-primary" onClick={props.onReconnect}>
            Reconnect
          </button>
        ) : null}
        <button type="button" className="btn" onClick={props.onOpen}>
          Abrir
        </button>
      </div>
    </div>
  );
}
