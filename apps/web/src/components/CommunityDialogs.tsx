import {
  CSSProperties,
  FormEvent,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  AppWindow,
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
import { detectGpuAndCapabilities, type DetectedGpuProfile } from '../lib/gpuCapabilities';
import { CustomSelect } from './CustomSelect';

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

import { ServerSettingsDialog, type Role } from './ServerSettingsDialog';
export { ServerSettingsDialog, type Role };

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
              <CustomSelect
                value={micId}
                onChange={(val) => setMicId(val)}
                options={[
                  { value: '', label: 'Padrão do sistema' },
                  ...mics.map((d) => ({
                    value: d.deviceId,
                    label: d.label || `Mic ${d.deviceId.slice(0, 6)}`,
                  })),
                ]}
                placeholder="Padrão do sistema"
              />
            </label>
            <label>
              Alto-falante / fone
              <CustomSelect
                value={speakerId}
                onChange={(val) => setSpeakerId(val)}
                options={[
                  { value: '', label: 'Padrão do sistema' },
                  ...speakers.map((d) => ({
                    value: d.deviceId,
                    label: d.label || `Out ${d.deviceId.slice(0, 6)}`,
                  })),
                ]}
                placeholder="Padrão do sistema"
              />
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
    sourceId?: string;
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
  const [videoCodec, setVideoCodec] = useState<'h264' | 'av1' | 'vp8'>('h264');
  const [preset, setPreset] = useState<'eco' | 'balanced' | 'high' | 'custom'>('balanced');
  const [publicWatch, setPublicWatch] = useState(true);
  const [publicWatchMax, setPublicWatchMax] = useState(50);
  const [publicWatchCustomNames, setPublicWatchCustomNames] = useState(true);
  const [publicWatchChat, setPublicWatchChat] = useState(true);
  const [publicWatchChatPost, setPublicWatchChatPost] = useState(true);
  const [gpuProfile, setGpuProfile] = useState<DetectedGpuProfile | null>(null);

  // Seletor nativo de telas e janelas (RallyDesk)
  const [sources, setSources] = useState<Array<{ id: string; name: string; thumbnailDataUrl?: string; kind?: string }>>([]);
  const [sourceType, setSourceType] = useState<'screen' | 'window'>('screen');
  const [selectedSourceId, setSelectedSourceId] = useState<string>('');
  const [loadingSources, setLoadingSources] = useState(false);

  useEffect(() => {
    if (!open) return;
    const isDesktop = typeof window !== 'undefined' && !!window.sfDesktop;

    if (isDesktop && window.sfDesktop?.getPickerSources) {
      setLoadingSources(true);
      window.sfDesktop.getPickerSources().then((srcs: any) => {
        if (Array.isArray(srcs) && srcs.length) {
          setSources(srcs);
          const firstScreen = srcs.find((s: any) => s.kind === 'screen' || s.id.startsWith('screen')) || srcs[0];
          setSelectedSourceId(firstScreen.id);
        }
      }).catch(() => undefined).finally(() => setLoadingSources(false));
    }

    void detectGpuAndCapabilities().then((detected) => {
      setGpuProfile(detected);
      try {
        const hasSaved = !!localStorage.getItem(LS.quality);
        if (!hasSaved) {
          setPreset(detected.preset);
          setQuality(detected.quality);
          setFps(detected.fps);
          setVideoCodec(detected.videoCodec);
          setBitrateMode(detected.bitrateMode);
        }
      } catch {
        /* ignore */
      }
    });
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
            sourceId: selectedSourceId || undefined,
          });
          onClose();
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="comm-live-wiz-head">
          <div>
            <h2>Configurar transmissão</h2>
            <p className="comm-dialog-hint">
              Escolha o que compartilhar e a qualidade desejada — a transmissão começa imediatamente.
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
            {/* Seletor Integrado de Fontes (Telas e Janelas) */}
            <div className="comm-share-sources-wrap">
              <div className="comm-share-sources-head">
                <span>O que você quer transmitir?</span>
                <div className="comm-share-sources-tabs">
                  <button
                    type="button"
                    className={`comm-share-source-tab${sourceType === 'screen' ? ' is-on' : ''}`}
                    onClick={() => setSourceType('screen')}
                  >
                    <Monitor size={14} /> Telas ({sources.filter((s) => s.kind === 'screen' || s.id.startsWith('screen')).length || 1})
                  </button>
                  <button
                    type="button"
                    className={`comm-share-source-tab${sourceType === 'window' ? ' is-on' : ''}`}
                    onClick={() => setSourceType('window')}
                  >
                    <AppWindow size={14} /> Janelas ({sources.filter((s) => s.kind === 'window' || s.id.startsWith('window')).length})
                  </button>
                </div>
              </div>

              <div className="comm-share-grid">
                {(() => {
                  const filtered = sources.filter((s) =>
                    sourceType === 'screen'
                      ? s.kind === 'screen' || s.id.startsWith('screen')
                      : s.kind === 'window' || s.id.startsWith('window')
                  );
                  if (!filtered.length) {
                    if (sourceType === 'screen') {
                      return (
                        <div
                          className={`comm-share-card is-selected`}
                          onClick={() => setSelectedSourceId('screen:0')}
                        >
                          <div className="comm-share-thumb-placeholder">🖥️</div>
                          <div className="comm-share-card-name">Monitor 1 (Principal)</div>
                          <span className="comm-share-badge">✓ Selecionado</span>
                        </div>
                      );
                    }
                    return (
                      <div style={{ padding: '16px', color: '#64748b', fontSize: 13, gridColumn: '1 / -1', textAlign: 'center' }}>
                        {loadingSources ? 'Carregando janelas...' : 'Nenhuma janela capturável encontrada no momento.'}
                      </div>
                    );
                  }
                  return filtered.map((s) => {
                    const isSel = selectedSourceId === s.id;
                    return (
                      <div
                        key={s.id}
                        className={`comm-share-card${isSel ? ' is-selected' : ''}`}
                        onClick={() => setSelectedSourceId(s.id)}
                      >
                        {s.thumbnailDataUrl ? (
                          <img
                            src={s.thumbnailDataUrl}
                            alt={s.name}
                            className="comm-share-thumb"
                            loading="lazy"
                          />
                        ) : (
                          <div className="comm-share-thumb-placeholder">
                            {sourceType === 'screen' ? '🖥️' : '🪟'}
                          </div>
                        )}
                        <div className="comm-share-card-name" title={s.name}>
                          {s.name}
                        </div>
                        {isSel ? <span className="comm-share-badge">✓ Selecionado</span> : null}
                      </div>
                    );
                  });
                })()}
              </div>
            </div>

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
            {gpuProfile ? (
              <div
                style={{
                  background: 'rgba(255, 255, 255, 0.04)',
                  border: '1px solid rgba(255, 255, 255, 0.1)',
                  borderRadius: 8,
                  padding: '10px 12px',
                  marginBottom: 12,
                  fontSize: 13,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginBottom: 4,
                  }}
                >
                  <span style={{ fontWeight: 600, color: '#f3f4f6' }}>
                    🎮 GPU: {gpuProfile.gpu.name}
                  </span>
                  <span
                    style={{
                      fontSize: 11,
                      padding: '2px 8px',
                      borderRadius: 12,
                      background:
                        gpuProfile.badgeTone === 'emerald'
                          ? 'rgba(16, 185, 129, 0.2)'
                          : gpuProfile.badgeTone === 'amber'
                          ? 'rgba(245, 158, 11, 0.2)'
                          : 'rgba(59, 130, 246, 0.2)',
                      color:
                        gpuProfile.badgeTone === 'emerald'
                          ? '#34d399'
                          : gpuProfile.badgeTone === 'amber'
                          ? '#fbbf24'
                          : '#60a5fa',
                      fontWeight: 600,
                    }}
                  >
                    {gpuProfile.gpu.encoderTier.toUpperCase()}
                  </span>
                </div>
                <div style={{ color: '#9ca3af', fontSize: 12, lineHeight: 1.4 }}>
                  {gpuProfile.reason}
                </div>
              </div>
            ) : null}
            <div className="comm-field" style={{ marginBottom: 12 }}>
              <span className="comm-field-label">Perfil Automático de Transmissão (Multi-GPU / CS2)</span>
              <CustomSelect
                value={preset}
                onChange={(val) => {
                  const p = val as 'eco' | 'balanced' | 'high' | 'custom';
                  setPreset(p);
                  if (p === 'eco') {
                    setQuality('720');
                    setFps(30);
                    setVideoCodec('h264');
                    setBitrateMode('auto');
                  } else if (p === 'balanced') {
                    setQuality('1080');
                    setFps(gpuProfile?.fps || 30);
                    setVideoCodec('h264');
                    setBitrateMode('fixed');
                  } else if (p === 'high') {
                    setQuality('1080');
                    setFps(60);
                    setVideoCodec('h264');
                    setBitrateMode('fixed');
                  }
                }}
                options={[
                  { value: 'balanced', label: 'Equilibrado (1080p 30/60 FPS • H.264 NVENC / VCN)' },
                  { value: 'eco', label: 'Econômico (720p 30 FPS • H.264 Adaptativo - Baixo Consumo / APUs)' },
                  { value: 'high', label: 'Alta Qualidade (1080p 60 FPS • H.264 / AV1 HW)' },
                  { value: 'custom', label: 'Personalizado' },
                ]}
              />
            </div>
            <div className="comm-field" style={{ marginBottom: 10 }}>
              <span className="comm-field-label">Codec de Vídeo WebRTC</span>
              <CustomSelect
                value={videoCodec}
                onChange={(val) => setVideoCodec(val as 'h264' | 'av1' | 'vp8')}
                options={[
                  { value: 'h264', label: 'H.264 (Acelerado por HW • NVENC / AMF / MFT - Padrão)' },
                  { value: 'av1', label: 'AV1 (Alta Eficiência • RTX 40 Series / Intel Arc)' },
                  { value: 'vp8', label: 'VP8 (Software Fallback)' },
                ]}
              />
            </div>
            <div className="comm-live-share-quality">
              <div className="comm-field">
                <span className="comm-field-label">Resolução</span>
                <CustomSelect
                  value={quality}
                  onChange={(val) => setQuality(val)}
                  options={[
                    { value: 'source', label: 'Fonte (nativo)' },
                    { value: '480', label: '480p' },
                    { value: '720', label: '720p' },
                    { value: '1080', label: '1080p' },
                  ]}
                />
              </div>
              <div className="comm-field">
                <span className="comm-field-label">FPS</span>
                <CustomSelect
                  value={String(fps)}
                  onChange={(val) => setFps(Number(val))}
                  options={[
                    { value: '15', label: '15' },
                    { value: '30', label: '30' },
                    { value: '60', label: '60' },
                  ]}
                />
              </div>
              <div className="comm-field">
                <span className="comm-field-label">Modo de bitrate</span>
                <CustomSelect
                  value={bitrateMode}
                  onChange={(val) => setBitrateMode(val as 'auto' | 'fixed')}
                  options={[
                    { value: 'fixed', label: 'Fixo (recomendado)' },
                    { value: 'auto', label: 'Automático' },
                  ]}
                />
              </div>
            </div>
            <p className="comm-dialog-note muted">
              A resolução e o FPS escolhidos ficam travados na transmissão. Em &quot;Automático&quot;,
              só o bitrate pode variar — a imagem não muda sozinha para outra qualidade.
            </p>
            <div className="comm-field">
              <span className="comm-field-label">Áudio da tela</span>
              <CustomSelect
                value={audioMode}
                onChange={(val) => setAudioMode(val as 'off' | 'app' | 'system')}
                options={[
                  { value: 'off', label: 'Desligado' },
                  { value: 'app', label: 'Só da janela / aplicativo' },
                  { value: 'system', label: 'Sistema inteiro (pode causar eco)' },
                ]}
              />
            </div>
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
