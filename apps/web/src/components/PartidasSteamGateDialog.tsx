import { useEffect, useRef, useState } from 'react';
import { Link2, RefreshCw } from 'lucide-react';
import { api } from '../lib/api';
import { clearSteamLinkPending, isSteamLinkPending, startSteamLink } from '../lib/steamLink';
import { NativeDialog } from './NativeDialog';

export type PartidasSteamMe = {
  steam_linked: boolean;
  steam_id64: string;
  steam_persona: string;
  steam_avatar: string;
};

export async function fetchSteamMe(): Promise<PartidasSteamMe> {
  return api<PartidasSteamMe>('/api/steam/me');
}

/** Modal mínimo: ligar / trocar conta Steam para Partidas CS2. */
export function PartidasSteamGateDialog({
  open,
  onClose,
  onLinked,
}: {
  open: boolean;
  onClose: () => void;
  onLinked?: (me: PartidasSteamMe) => void;
}) {
  const [me, setMe] = useState<PartidasSteamMe | null>(null);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);
  const waitRef = useRef(false);

  async function reload() {
    try {
      const m = await fetchSteamMe();
      setMe(m);
      if (m.steam_linked) {
        waitRef.current = false;
        clearSteamLinkPending();
        setError('');
        onLinked?.(m);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro Steam');
    }
  }

  async function connectSteam() {
    setError('');
    setBusy(true);
    try {
      const r = await startSteamLink('/comunidade?desktop=1');
      if (r.mode === 'external') {
        waitRef.current = true;
        setInfo('Conclui o login Steam no browser. Esta janela atualiza sozinha.');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao abrir Steam');
    } finally {
      setBusy(false);
    }
  }

  async function switchAccount() {
    setBusy(true);
    setError('');
    try {
      await api('/api/steam/unlink', { method: 'POST', body: '{}' });
      setMe((prev) =>
        prev
          ? { ...prev, steam_linked: false, steam_id64: '', steam_persona: '', steam_avatar: '' }
          : prev,
      );
      await connectSteam();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao trocar conta');
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    void reload();
    const onFocus = () => {
      if (waitRef.current || isSteamLinkPending()) void reload();
    };
    const onLinkedEv = () => {
      waitRef.current = false;
      void reload();
    };
    window.addEventListener('focus', onFocus);
    window.addEventListener('sf-steam-linked', onLinkedEv);
    const t = window.setInterval(() => {
      if (waitRef.current || isSteamLinkPending()) void reload();
    }, 2000);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('sf-steam-linked', onLinkedEv);
      window.clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <NativeDialog open={open} onClose={onClose} className="comm-dialog">
      <div className="comm-dialog-form" onClick={(e) => e.stopPropagation()}>
        <h2>Steam necessária · Partidas CS2</h2>
        <p className="comm-dialog-hint">
          {error ||
            info ||
            'Precisas de uma conta Steam ligada para o dedicated te meter no time certo (CT/TR).'}
        </p>

        {me?.steam_linked ? (
          <>
            <div className="comm-steam-linked">
              <img src={me.steam_avatar || '/icon.svg'} alt="" referrerPolicy="no-referrer" />
              <div>
                <strong>{me.steam_persona || 'Steam'}</strong>
                <p>{me.steam_id64}</p>
              </div>
            </div>
            <div className="form-actions" style={{ justifyContent: 'flex-start', flexWrap: 'wrap' }}>
              <button type="button" className="btn btn-primary" onClick={onClose}>
                Continuar
              </button>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => void switchAccount()}
              >
                Trocar conta
              </button>
            </div>
          </>
        ) : (
          <div className="form-actions" style={{ justifyContent: 'flex-start', flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => void connectSteam()}
            >
              <Link2 size={16} /> {busy ? 'A abrir…' : 'Ligar Steam'}
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => void reload()}
              title="Atualizar"
            >
              <RefreshCw size={16} />
            </button>
            <button type="button" className="btn" onClick={onClose}>
              Fechar
            </button>
          </div>
        )}
      </div>
    </NativeDialog>
  );
}
