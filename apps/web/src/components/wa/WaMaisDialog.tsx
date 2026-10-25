import { FormEvent, useEffect, useMemo, useState } from 'react';
import { NativeDialog } from '../NativeDialog';
import { api } from '../../lib/api';
import type { WaSlot } from './waTypes';

export type WaPrefs = {
  sendTyping: boolean;
  showTyping: boolean;
  sendReadReceipts: boolean;
};

const PREFS_KEY = 'sf-wa-prefs-v1';

export function loadWaPrefs(): WaPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') as Partial<WaPrefs>;
    return {
      sendTyping: raw.sendTyping !== false,
      showTyping: raw.showTyping !== false,
      sendReadReceipts: raw.sendReadReceipts !== false,
    };
  } catch {
    return { sendTyping: true, showTyping: true, sendReadReceipts: true };
  }
}

export function saveWaPrefs(p: WaPrefs) {
  localStorage.setItem(PREFS_KEY, JSON.stringify(p));
}

export function WaMaisDialog({
  open,
  slot,
  slotInfo,
  onClose,
}: {
  open: boolean;
  slot: number | null;
  slotInfo: WaSlot | null;
  onClose: () => void;
}) {
  const [prefs, setPrefs] = useState(loadWaPrefs);
  const [name, setName] = useState('');
  const [about, setAbout] = useState('');
  const [displayName, setDisplayName] = useState('…');
  const [displayPhone, setDisplayPhone] = useState('');
  const [status, setStatus] = useState('');
  const [avatarUrl, setAvatarUrl] = useState('');
  const [busy, setBusy] = useState(false);

  const meJid = slotInfo?.me_jid || '';

  async function loadProfile(force = false) {
    if (!slot) return;
    setStatus(force ? 'Consultando no WhatsApp…' : 'Carregando perfil…');
    try {
      const q = force ? '?refresh=1' : '';
      const remote = await api<{
        pushName?: string;
        username?: string;
        about?: string;
        phoneDisplay?: string;
        meJid?: string;
        avatarDataUrl?: string;
        hasAvatar?: boolean;
        privacy?: { readReceipts?: string };
      }>(`/api/community/wa/${slot}/profile${q}`);
      setName(remote.pushName || remote.username || '');
      setAbout(remote.about || '');
      setDisplayName(remote.pushName || remote.username || slotInfo?.push_name || 'Sem nome');
      setDisplayPhone(remote.phoneDisplay || slotInfo?.me_jid || '');
      if (remote.avatarDataUrl) setAvatarUrl(remote.avatarDataUrl);
      else if (remote.meJid || meJid) {
        setAvatarUrl(
          `/api/community/wa/${slot}/avatar?jid=${encodeURIComponent(remote.meJid || meJid)}&t=${Date.now()}`,
        );
      }
      if (remote.privacy?.readReceipts) {
        const on = String(remote.privacy.readReceipts).toLowerCase() !== 'none';
        setPrefs((p) => ({ ...p, sendReadReceipts: on && p.sendReadReceipts !== false }));
      }
      setStatus(
        remote.hasAvatar
          ? 'Foto e dados atualizados do WhatsApp.'
          : remote.pushName || remote.username
            ? 'Nome carregado.'
            : 'Consulte de novo se o nome/foto não aparecer.',
      );
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'Falha ao consultar perfil');
      setDisplayName(slotInfo?.push_name || 'Sem nome');
      setDisplayPhone(slotInfo?.me_jid || '');
    }
  }

  useEffect(() => {
    if (open && slot) {
      setPrefs(loadWaPrefs());
      void loadProfile(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, slot]);

  async function saveProfile(e: FormEvent) {
    e.preventDefault();
    if (!slot) return;
    setBusy(true);
    try {
      if (name.trim()) {
        await api(`/api/community/wa/${slot}/invoke`, {
          method: 'POST',
          body: JSON.stringify({
            coordinator: 'profile',
            method: 'setPushName',
            args: [name.trim()],
          }),
        });
      }
      await api(`/api/community/wa/${slot}/invoke`, {
        method: 'POST',
        body: JSON.stringify({
          coordinator: 'profile',
          method: 'setStatus',
          args: [about.trim()],
        }),
      });
      await loadProfile(true);
      alert('Perfil atualizado.');
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Falha ao salvar perfil');
    } finally {
      setBusy(false);
    }
  }

  async function savePrefs() {
    if (!slot) return;
    setBusy(true);
    try {
      saveWaPrefs(prefs);
      try {
        await api(`/api/community/wa/${slot}/invoke`, {
          method: 'POST',
          body: JSON.stringify({
            coordinator: 'privacy',
            method: 'setPrivacySetting',
            args: ['readReceipts', prefs.sendReadReceipts ? 'all' : 'none'],
          }),
        });
      } catch {
        /* optional */
      }
      alert('Configurações salvas.');
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Falha ao salvar');
    } finally {
      setBusy(false);
    }
  }

  const letter = useMemo(
    () => (displayName || displayPhone || '?')[0]?.toUpperCase() || '?',
    [displayName, displayPhone],
  );

  return (
    <NativeDialog open={open} onClose={onClose} className="comm-dialog">
      <form className="comm-dialog-form comm-wa-mais" onSubmit={(e) => void saveProfile(e)}>
        <header>
          <h2>Mais · WhatsApp</h2>
          <p className="comm-dialog-hint">Perfil da conta conectada e preferências do painel.</p>
        </header>

        <section className="comm-wa-mais-section">
          <h3>Meu perfil</h3>
          <div className="comm-wa-mais-profile">
            <div className="comm-wa-mais-photo">
              {avatarUrl ? (
                <img
                  src={avatarUrl}
                  alt=""
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.display = 'none';
                  }}
                />
              ) : null}
              <span className="comm-wa-mais-photo-ph">{letter}</span>
            </div>
            <div className="comm-wa-mais-id">
              <strong>{displayName}</strong>
              <em>{displayPhone}</em>
            </div>
          </div>
          <p className="muted" style={{ fontSize: '.75rem', margin: 0 }}>
            {status}
          </p>
          <label className="comm-field">
            <span className="comm-field-label">Nome (push name)</span>
            <input
              type="text"
              maxLength={25}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="comm-field">
            <span className="comm-field-label">Recado (about / status)</span>
            <textarea
              rows={2}
              maxLength={139}
              value={about}
              onChange={(e) => setAbout(e.target.value)}
            />
          </label>
          <div className="comm-wa-mais-actions">
            <button type="button" className="btn" disabled={busy} onClick={() => void loadProfile(true)}>
              Consultar
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              Salvar perfil
            </button>
          </div>
        </section>

        <section className="comm-wa-mais-section">
          <h3>Configurações gerais</h3>
          <label className="comm-check">
            <input
              type="checkbox"
              checked={prefs.sendTyping}
              onChange={(e) => setPrefs((p) => ({ ...p, sendTyping: e.target.checked }))}
            />
            <span>Enviar «digitando…»</span>
          </label>
          <label className="comm-check">
            <input
              type="checkbox"
              checked={prefs.showTyping}
              onChange={(e) => setPrefs((p) => ({ ...p, showTyping: e.target.checked }))}
            />
            <span>Mostrar quando o outro está digitando</span>
          </label>
          <label className="comm-check">
            <input
              type="checkbox"
              checked={prefs.sendReadReceipts}
              onChange={(e) => setPrefs((p) => ({ ...p, sendReadReceipts: e.target.checked }))}
            />
            <span>Enviar confirmação de leitura (ticks azuis)</span>
          </label>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void savePrefs()}>
            Salvar configurações
          </button>
        </section>

        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>
            Fechar
          </button>
        </div>
      </form>
    </NativeDialog>
  );
}
