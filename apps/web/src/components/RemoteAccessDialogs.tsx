import { useEffect, useMemo, useState } from 'react';
import { Monitor, MonitorUp, ShieldAlert, X } from 'lucide-react';
import { NativeDialog } from './NativeDialog';
import type { RemoteSession } from '../lib/remoteAccess';

function RemoteAvatar({ name, url }: { name: string; url?: string }) {
  const initial = (name || '?').trim().charAt(0).toUpperCase() || '?';
  if (url) {
    return <img className="remote-access-av" src={url} alt="" />;
  }
  return (
    <span className="remote-access-av is-fallback" aria-hidden>
      {initial}
    </span>
  );
}

function labelOf(s: RemoteSession, side: 'requester' | 'target') {
  const u = side === 'requester' ? s.requester : s.target;
  return (u?.display_name || u?.username || 'Membro').trim();
}

function avatarOf(s: RemoteSession, side: 'requester' | 'target') {
  const u = side === 'requester' ? s.requester : s.target;
  return (u?.avatar_url || '').trim();
}

function useExpireCountdown(expiresAt?: number) {
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (!expiresAt) {
      setLeft(0);
      return;
    }
    const tick = () => {
      const sec = Math.max(0, Math.ceil(Number(expiresAt) - Date.now() / 1000));
      setLeft(sec);
    };
    tick();
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, [expiresAt]);
  return left;
}

export function RemoteRequestModal({
  open,
  session,
  busy,
  error,
  onAccept,
  onDeny,
}: {
  open: boolean;
  session: RemoteSession | null;
  busy?: boolean;
  error?: string;
  onAccept: () => void;
  onDeny: () => void;
}) {
  const left = useExpireCountdown(session?.expires_at);
  const requester = session ? labelOf(session, 'requester') : '';
  const requesterAv = session ? avatarOf(session, 'requester') : '';
  const isControlMe = session?.direction === 'control_target';

  const headline = useMemo(() => {
    if (!session) return '';
    return isControlMe ? 'Pedem controlo do seu PC' : 'Pedem que você ajude no PC deles';
  }, [session, isControlMe]);

  const detail = useMemo(() => {
    if (!session) return '';
    return isControlMe
      ? `${requester} quer aceder a esta máquina com rato e teclado (RallyDesk).`
      : `${requester} quer que você aceda à máquina dele com rato e teclado.`;
  }, [session, isControlMe, requester]);

  if (!session) return null;

  return (
    <NativeDialog open={open} onClose={() => undefined} className="comm-dialog remote-access-dialog">
      <div className="remote-access-modal">
        <header className="remote-access-modal-head">
          <div className={`remote-access-modal-icon${isControlMe ? ' is-warn' : ' is-help'}`}>
            {isControlMe ? <ShieldAlert size={22} aria-hidden /> : <MonitorUp size={22} aria-hidden />}
          </div>
          <div className="remote-access-modal-titles">
            <p className="remote-access-kicker">Acesso remoto</p>
            <h2>{headline}</h2>
          </div>
        </header>

        <div className="remote-access-modal-peer">
          <RemoteAvatar name={requester} url={requesterAv} />
          <div>
            <strong>{requester}</strong>
            <span className="muted">{detail}</span>
          </div>
        </div>

        <ul className="remote-access-points">
          <li>Só avança se você aceitar.</li>
          <li>Pode encerrar a sessão a qualquer momento.</li>
          <li>Requer o app Desktop SteamFarm nesta máquina.</li>
        </ul>

        {left > 0 ? (
          <p className="remote-access-expire" role="timer">
            Expira em <strong>{left}s</strong>
            <span
              className="remote-access-expire-bar"
              style={{ ['--left' as string]: `${Math.min(100, (left / 60) * 100)}%` }}
            />
          </p>
        ) : (
          <p className="remote-access-expire is-urgent">Este pedido está a expirar…</p>
        )}

        {error ? <p className="form-error remote-access-error">{error}</p> : null}

        <div className="remote-access-actions">
          <button type="button" className="btn btn-danger remote-access-deny" disabled={busy} onClick={onDeny}>
            Recusar
          </button>
          <button type="button" className="btn btn-primary remote-access-accept" disabled={busy} onClick={onAccept}>
            Aceitar
          </button>
        </div>
      </div>
    </NativeDialog>
  );
}

export function RemoteActiveBanner({
  session,
  myUserId,
  busy,
  error,
  onEnd,
}: {
  session: RemoteSession | null;
  myUserId?: number;
  busy?: boolean;
  error?: string;
  onEnd: () => void;
}) {
  if (!session || !['accepted', 'active', 'pending'].includes(session.status)) return null;
  if (session.status === 'pending' && session.target_id === myUserId) return null;

  const peerId =
    session.requester_id === myUserId ? session.target_id : session.requester_id;
  const peer =
    session.requester_id === peerId
      ? session.requester
      : session.target_id === peerId
        ? session.target
        : null;
  const peerLabel = (peer?.display_name || peer?.username || 'membro').trim();
  const peerAv = (peer?.avatar_url || '').trim();
  const iAmHost = session.host_user_id === myUserId;

  const statusLabel =
    session.status === 'pending'
      ? 'Aguardando resposta…'
      : session.status === 'accepted'
        ? 'A preparar ligação remota…'
        : iAmHost
          ? `${peerLabel} pode controlar este PC`
          : `A controlar o PC de ${peerLabel}`;

  const statusTone =
    session.status === 'pending' ? 'pending' : session.status === 'accepted' ? 'prep' : 'live';

  return (
    <div className={`remote-access-banner is-${statusTone}`} role="status" data-comm-remote-banner>
      <div className="remote-access-banner-main">
        <span className="remote-access-banner-ico" aria-hidden>
          <Monitor size={16} />
        </span>
        {peerLabel ? <RemoteAvatar name={peerLabel} url={peerAv} /> : null}
        <div className="remote-access-banner-copy">
          <strong>{statusLabel}</strong>
          {error ? <span className="form-error">{error}</span> : null}
        </div>
      </div>
      {session.status !== 'pending' ? (
        <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={onEnd}>
          <X size={14} aria-hidden />
          Encerrar
        </button>
      ) : null}
    </div>
  );
}
