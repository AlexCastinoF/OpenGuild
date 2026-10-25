import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuthStore } from '../store/auth';
import type { AuthUser } from '@steamfarm/shared';

type InvitePreview = {
  ok: boolean;
  valid?: boolean;
  reason?: string;
  already_member?: boolean;
  code?: string;
  server?: {
    id: number;
    name: string;
    icon_url: string;
    banner_url: string;
    description: string;
    member_count: number;
  };
};

export function InvitePage() {
  const { code } = useParams();
  const nav = useNavigate();
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const [authReady, setAuthReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [registerEnabled, setRegisterEnabled] = useState(true);

  const nextPath = `/convite/${encodeURIComponent(code || '')}`;

  useEffect(() => {
    let stop = false;
    api<{ register_enabled?: boolean; user?: AuthUser | null }>('/api/auth/status')
      .then((s) => {
        if (stop) return;
        setRegisterEnabled(s.register_enabled !== false);
        if (s.user) setUser(s.user);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!stop) setAuthReady(true);
      });
    return () => {
      stop = true;
    };
  }, [setUser]);

  useEffect(() => {
    if (!code || !authReady) return;
    let stop = false;
    setLoading(true);
    setError('');
    api<InvitePreview>(`/api/community/invite/${encodeURIComponent(code)}`)
      .then((d) => {
        if (stop) return;
        if (!d.valid) {
          const reasons: Record<string, string> = {
            invalid: 'Este convite não existe ou é inválido.',
            expired: 'Este convite expirou.',
            exhausted: 'Este convite atingiu o limite de usos.',
          };
          setError(reasons[d.reason || ''] || 'Convite inválido.');
          setPreview(d);
          return;
        }
        setPreview(d);
        if (user && d.already_member && d.server?.id) {
          nav(`/comunidade/${d.server.id}`, { replace: true });
        }
      })
      .catch((e) => {
        if (!stop) setError(e instanceof Error ? e.message : 'Erro ao carregar convite');
      })
      .finally(() => {
        if (!stop) setLoading(false);
      });
    return () => {
      stop = true;
    };
  }, [code, user, nav, authReady]);

  async function accept() {
    if (!code || busy) return;
    setBusy(true);
    setError('');
    try {
      const d = await api<{ server_id: number }>('/api/community/join', {
        method: 'POST',
        body: JSON.stringify({ code }),
      });
      nav(`/comunidade/${d.server_id}`, { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Não foi possível entrar');
      setBusy(false);
    }
  }

  function decline() {
    nav('/comunidade', { replace: true });
  }

  const server = preview?.server;

  return (
    <section className="comm-invite-page">
      {loading || !authReady ? <div className="comm-invite-loading">Carregando convite…</div> : null}
      {!loading && authReady && error && !server ? (
        <div className="comm-invite-error">{error}</div>
      ) : null}
      {!loading && authReady && server ? (
        <div className="comm-invite-card">
          <div
            className={`comm-invite-banner${server.banner_url ? ' has-image' : ' is-default'}`}
            style={
              server.banner_url
                ? { backgroundImage: `url("${server.banner_url.replace(/"/g, '')}")` }
                : undefined
            }
          />
          <div className="comm-invite-body">
            <div className="comm-invite-server">
              {server.icon_url ? (
                <img
                  className="comm-invite-icon"
                  src={server.icon_url}
                  alt=""
                  width={72}
                  height={72}
                  referrerPolicy="no-referrer"
                />
              ) : null}
              <div>
                <p className="comm-invite-kicker">Convite para</p>
                <h1>{server.name}</h1>
                <p className="muted">{server.member_count || 0} membro(s)</p>
              </div>
            </div>

            {user ? (
              <>
                <p className="comm-invite-msg">
                  {preview?.already_member
                    ? 'Você já faz parte deste servidor.'
                    : `Olá, ${user.label || user.username}. Deseja entrar neste servidor?`}
                </p>
                {error ? <div className="error">{error}</div> : null}
                <div className="comm-invite-actions">
                  {!preview?.already_member ? (
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={busy}
                      onClick={() => void accept()}
                    >
                      {busy ? 'Entrando…' : 'Entrar no servidor'}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => nav(`/comunidade/${server.id}`)}
                    >
                      Abrir servidor
                    </button>
                  )}
                  <button type="button" className="btn" onClick={decline} disabled={busy}>
                    Agora não
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="comm-invite-msg">
                  Entre com sua conta para aceitar o convite, ou crie uma conta nova.
                </p>
                <div className="comm-invite-actions">
                  <Link className="btn btn-primary" to={`/login?next=${encodeURIComponent(nextPath)}`}>
                    Entrar com sua conta
                  </Link>
                  {registerEnabled ? (
                    <Link className="btn" to={`/register?next=${encodeURIComponent(nextPath)}`}>
                      Criar conta
                    </Link>
                  ) : null}
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}
