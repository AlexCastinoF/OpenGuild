import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { getSocket } from './socket';
import { pushNotify } from './commNotify';

export type RemoteDirection = 'control_target' | 'invite_helper';

export type RemoteUserBrief = {
  id: number;
  username?: string;
  display_name?: string;
  avatar_url?: string;
};

export type RemoteSession = {
  id: string;
  server_id: number;
  requester_id: number;
  target_id: number;
  direction: RemoteDirection;
  status: string;
  host_user_id: number;
  controller_user_id: number;
  host_rustdesk_id?: string;
  expires_at?: number;
  session_password?: string;
  requester?: RemoteUserBrief;
  target?: RemoteUserBrief;
};

type RemotePayload = {
  ok?: boolean;
  session?: RemoteSession | null;
  role?: 'host' | 'controller';
  session_password?: string;
};

function labelOf(u?: RemoteUserBrief | null) {
  if (!u) return 'Alguém';
  return (u.display_name || u.username || `User ${u.id}`).trim();
}

function isDesktopApp() {
  return typeof window !== 'undefined' && !!window.sfDesktop;
}

async function registerAgentIfPossible() {
  if (!isDesktopApp() || !window.sfDesktop?.remoteStatus) return;
  try {
    const st = await window.sfDesktop.remoteStatus();
    const id = String(st?.rustdeskId || '').trim();
    if (!id) return;
    await api('/api/remote/agent/register', {
      method: 'POST',
      body: JSON.stringify({ rustdesk_id: id }),
    });
  } catch {
    /* ignore */
  }
}

export function useRemoteAccess(opts: {
  userId?: number;
  serverId?: number;
  enabled?: boolean;
}) {
  const { userId, serverId, enabled = true } = opts;
  const [incoming, setIncoming] = useState<RemoteSession | null>(null);
  const [active, setActive] = useState<RemoteSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const passwordRef = useRef('');

  const clearIncoming = useCallback(() => setIncoming(null), []);

  const endSession = useCallback(async (sessionId?: string) => {
    const id = sessionId || active?.id;
    if (!id) return;
    setBusy(true);
    try {
      await api(`/api/remote/${id}/end`, { method: 'POST', body: '{}' });
      try {
        await window.sfDesktop?.remoteEnd?.();
      } catch {
        /* ignore */
      }
      setActive(null);
      setIncoming(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'erro');
    } finally {
      setBusy(false);
    }
  }, [active?.id]);

  const requestAccess = useCallback(
    async (targetId: number, direction: RemoteDirection) => {
      if (!serverId) throw new Error('no_server');
      setError('');
      setBusy(true);
      try {
        if (!isDesktopApp()) {
          throw new Error('Abra o app Desktop para iniciar acesso remoto.');
        }
        await registerAgentIfPossible();
        const res = await api<RemotePayload & { target_agent_online?: boolean }>('/api/remote/request', {
          method: 'POST',
          body: JSON.stringify({
            server_id: serverId,
            target_id: targetId,
            direction,
          }),
        });
        if (res.session) setActive(res.session);
        return res;
      } finally {
        setBusy(false);
      }
    },
    [serverId],
  );

  const respond = useCallback(
    async (accept: boolean) => {
      if (!incoming) return;
      setBusy(true);
      setError('');
      try {
        if (accept && !isDesktopApp()) {
          throw new Error('Aceitar acesso remoto exige o app Desktop.');
        }
        const res = await api<RemotePayload>(`/api/remote/${incoming.id}/respond`, {
          method: 'POST',
          body: JSON.stringify({ accept }),
        });
        setIncoming(null);
        if (!accept) {
          setActive(null);
          return;
        }
        const session = res.session;
        if (!session) return;
        setActive(session);
        // Host prepara via evento WS remote.prepare (também no próprio respond se for o host)
        const password = String(res.session_password || session.session_password || '').trim();
        passwordRef.current = password;
        if (userId && session.host_user_id === userId && password) {
          pushNotify({
            kind: 'community.remote_access',
            threadKey: `remote:${session.id}:prep`,
            title: 'A preparar acesso remoto',
            body: 'Se o Windows pedir permissão (UAC), aceite para continuar.',
          });
          const prep = await window.sfDesktop?.remotePrepareHost?.({ password });
          if (!prep?.ok || !prep.rustdesk_id) {
            await api(`/api/remote/${session.id}/end`, { method: 'POST', body: '{}' }).catch(() => undefined);
            setActive(null);
            throw new Error(prep?.error || 'Falha ao preparar RustDesk no host.');
          }
          await api(`/api/remote/${session.id}/host-ready`, {
            method: 'POST',
            body: JSON.stringify({
              rustdesk_id: prep.rustdesk_id,
              session_password: password,
            }),
          });
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'erro');
      } finally {
        setBusy(false);
      }
    },
    [incoming, userId],
  );

  // Bootstrap agent + active session
  useEffect(() => {
    if (!enabled || !userId) return;
    void registerAgentIfPossible();
    const hb = window.setInterval(() => {
      void api('/api/remote/agent/heartbeat', { method: 'POST', body: '{}' }).catch(() => undefined);
    }, 60_000);
    void api<RemotePayload>('/api/remote/active')
      .then((d) => {
        if (d.session && ['pending', 'accepted', 'active'].includes(d.session.status)) {
          if (d.session.status === 'pending' && d.session.target_id === userId) {
            setIncoming(d.session);
          } else {
            setActive(d.session);
          }
        }
      })
      .catch(() => undefined);
    return () => window.clearInterval(hb);
  }, [enabled, userId]);

  // Socket events
  useEffect(() => {
    if (!enabled || !userId) return;
    const sock = getSocket();

    const onRequest = (payload: RemotePayload) => {
      const s = payload.session;
      if (!s || s.target_id !== userId) return;
      setIncoming(s);
      setActive(s);
      const who = labelOf(s.requester);
      const body =
        s.direction === 'control_target'
          ? `${who} quer aceder à sua máquina (controlo total).`
          : `${who} pede que você aceda à máquina dele.`;
      pushNotify({
        kind: 'community.remote_access',
        threadKey: `remote:${s.id}`,
        title: 'Pedido de acesso remoto',
        body,
        onClick: () => {
          void window.sfDesktop?.focusWindow?.();
        },
      });
    };

    const onDenied = (payload: RemotePayload) => {
      const s = payload.session;
      if (!s) return;
      if (s.requester_id === userId || s.target_id === userId) {
        setIncoming(null);
        setActive(null);
        pushNotify({
          kind: 'community.remote_access',
          threadKey: `remote:${s.id}:denied`,
          title: 'Acesso remoto recusado',
          body: 'O pedido foi recusado ou expirou.',
        });
      }
    };

    const onReady = async (payload: RemotePayload) => {
      const s = payload.session;
      if (!s) return;
      setActive(s);
      if (payload.role === 'controller' || s.controller_user_id === userId) {
        const password = String(payload.session_password || s.session_password || passwordRef.current || '');
        const hostId = String(s.host_rustdesk_id || '');
        if (hostId && isDesktopApp()) {
          try {
            const conn = await window.sfDesktop?.remoteConnect?.({ host_id: hostId, password });
            if (conn && conn.ok === false) {
              throw new Error(conn.error || 'Falha ao ligar ao RustDesk');
            }
          } catch (e) {
            const msg = e instanceof Error ? e.message : 'erro';
            setError(msg);
            setActive(null);
            pushNotify({
              kind: 'community.remote_access',
              threadKey: `remote:${s.id}:connfail`,
              title: 'Falha na ligação remota',
              body: msg,
            });
            await api(`/api/remote/${s.id}/end`, { method: 'POST', body: '{}' }).catch(() => undefined);
            return;
          }
        }
      }
    };

    const onEnded = (payload: RemotePayload) => {
      const s = payload.session;
      if (!s) return;
      if (s.requester_id === userId || s.target_id === userId) {
        setIncoming(null);
        setActive(null);
        void window.sfDesktop?.remoteEnd?.();
      }
    };

    const onAccepted = (payload: RemotePayload) => {
      if (payload.session) setActive(payload.session);
    };

    const onActive = (payload: RemotePayload) => {
      if (payload.session) setActive(payload.session);
    };

    const onPrepare = async (payload: RemotePayload) => {
      const s = payload.session;
      if (!s || s.host_user_id !== userId) return;
      setActive(s);
      const password = String(payload.session_password || s.session_password || '').trim();
      passwordRef.current = password;
      if (!isDesktopApp()) {
        pushNotify({
          kind: 'community.remote_access',
          threadKey: `remote:${s.id}:nodesktop`,
          title: 'Acesso remoto',
          body: 'Abra o app Desktop para partilhar a sua máquina.',
        });
        return;
      }
      try {
        pushNotify({
          kind: 'community.remote_access',
          threadKey: `remote:${s.id}:prep`,
          title: 'A preparar acesso remoto',
          body: 'Se o Windows pedir permissão (UAC), aceite para continuar.',
        });
        const prep = await window.sfDesktop?.remotePrepareHost?.({ password });
        if (!prep?.ok || !prep.rustdesk_id) {
          throw new Error(prep?.error || 'prepare_failed');
        }
        await api(`/api/remote/${s.id}/host-ready`, {
          method: 'POST',
          body: JSON.stringify({
            rustdesk_id: prep.rustdesk_id,
            session_password: password,
          }),
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : 'erro');
        setActive(null);
        pushNotify({
          kind: 'community.remote_access',
          threadKey: `remote:${s.id}:prepfail`,
          title: 'Falha ao preparar acesso remoto',
          body: e instanceof Error ? e.message : 'erro',
        });
        await api(`/api/remote/${s.id}/end`, { method: 'POST', body: '{}' }).catch(() => undefined);
      }
    };

    sock.on('remote.request', onRequest);
    sock.on('remote.prepare', onPrepare);
    sock.on('remote.denied', onDenied);
    sock.on('remote.ready', onReady);
    sock.on('remote.ended', onEnded);
    sock.on('remote.accepted', onAccepted);
    sock.on('remote.active', onActive);
    return () => {
      sock.off('remote.request', onRequest);
      sock.off('remote.prepare', onPrepare);
      sock.off('remote.denied', onDenied);
      sock.off('remote.ready', onReady);
      sock.off('remote.ended', onEnded);
      sock.off('remote.accepted', onAccepted);
      sock.off('remote.active', onActive);
    };
  }, [enabled, userId]);

  return {
    incoming,
    active,
    busy,
    error,
    setError,
    clearIncoming,
    requestAccess,
    respond,
    endSession,
    isDesktop: isDesktopApp(),
  };
}
