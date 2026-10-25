import { FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { NativeDialog } from '../components/CommunityDialogs';
import { WebTopNav } from '../components/WebTopNav';
import { useBrandStore } from '../store/brand';

type Listed = {
  id: number;
  name: string;
  description: string;
  icon_url: string;
  banner_url: string;
  is_member?: boolean;
  join_pending?: boolean;
  admins?: Array<{ label: string; username: string; avatar_url: string; role: string }>;
};

export function DiscoverPage() {
  const nav = useNavigate();
  const brandName = useBrandStore((s) => s.name);
  const [servers, setServers] = useState<Listed[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [joinTarget, setJoinTarget] = useState<Listed | null>(null);
  const [joinMessage, setJoinMessage] = useState('');

  useEffect(() => {
    document.body.classList.add('page-community-discover');
    document.body.classList.remove('page-community');
    return () => document.body.classList.remove('page-community-discover');
  }, []);

  useEffect(() => {
    setLoading(true);
    api<{ servers: Listed[] }>('/api/community/discover')
      .then((d) => setServers(d.servers || []))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  async function submitJoin(e: FormEvent) {
    e.preventDefault();
    if (!joinTarget) return;
    setError('');
    setMsg('');
    try {
      await api(`/api/community/servers/${joinTarget.id}/join-requests`, {
        method: 'POST',
        body: JSON.stringify({ message: joinMessage.trim() || 'Quero entrar' }),
      });
      setMsg('Pedido enviado.');
      setJoinTarget(null);
      setJoinMessage('');
      const d = await api<{ servers: Listed[] }>('/api/community/discover');
      setServers(d.servers || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro');
    }
  }

  return (
    <>
      <WebTopNav />
      <div className="comm-page">
      <section className="comm-discover-page">
        <header className="comm-discover-head">
          <div>
            <p className="saas-kicker">{brandName}</p>
            <h1>Descobrir servidores</h1>
            <p className="muted">
              Servidores públicos listados pelos admins. Envie uma mensagem para solicitar entrada.
            </p>
          </div>
          <div className="comm-discover-head-actions">
            <Link className="btn" to="/comunidade">
              Voltar às reuniões
            </Link>
          </div>
        </header>

        {error ? <div className="error">{error}</div> : null}
        {msg ? <p className="muted">{msg}</p> : null}
        {loading ? <p className="comm-discover-loading muted">Carregando…</p> : null}

        {!loading && !servers.length ? (
          <p className="comm-discover-empty muted">
            Nenhum servidor público no momento. Peça ao admin para ativar «Aparecer na descoberta» nas
            configurações.
          </p>
        ) : null}

        <div className={`comm-discover-grid${loading || !servers.length ? ' is-empty' : ''}`}>
          {servers.map((s) => (
            <article className="comm-discover-card" key={s.id}>
              <div
                className={`comm-discover-card-banner${s.banner_url ? ' has-image' : ''}`}
                style={s.banner_url ? { backgroundImage: `url(${s.banner_url})` } : undefined}
              />
              <div className="comm-discover-card-body">
                <div className="comm-discover-card-title">
                  {s.icon_url ? (
                    <img className="comm-discover-icon" src={s.icon_url} alt="" />
                  ) : (
                    <span className="comm-discover-icon-fallback">{s.name.slice(0, 2).toUpperCase()}</span>
                  )}
                  <h2>{s.name}</h2>
                </div>
                <p className="comm-discover-desc">{s.description || 'Sem descrição'}</p>
                {s.admins?.length ? (
                  <div className="comm-discover-admins">
                    {s.admins.map((a, i) => (
                      <span className="comm-discover-admin" key={`${a.username}-${i}`}>
                        {a.avatar_url ? (
                          <img className="comm-avatar" src={a.avatar_url} alt="" width={32} height={32} />
                        ) : (
                          <span className="comm-avatar comm-avatar-fallback">
                            {(a.label || a.username || '?').slice(0, 1).toUpperCase()}
                          </span>
                        )}
                        <span>
                          {a.label || a.username}
                          <em>{a.role}</em>
                        </span>
                      </span>
                    ))}
                  </div>
                ) : null}
                <div className="comm-discover-card-actions">
                  {s.is_member ? (
                    <button type="button" className="btn btn-sm" onClick={() => nav(`/comunidade/${s.id}`)}>
                      Abrir
                    </button>
                  ) : s.join_pending ? (
                    <span className="comm-discover-pending muted">Solicitação pendente</span>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={() => {
                        setJoinTarget(s);
                        setJoinMessage('');
                      }}
                    >
                      Solicitar entrada
                    </button>
                  )}
                </div>
              </div>
            </article>
          ))}
        </div>
      </section>

      <NativeDialog open={!!joinTarget} onClose={() => setJoinTarget(null)}>
        <form className="comm-dialog-form" onSubmit={(e) => void submitJoin(e)}>
          <h2>Solicitar entrada</h2>
          <p className="comm-dialog-hint muted">{joinTarget?.name}</p>
          <label>
            Mensagem para o admin
            <textarea
              rows={4}
              maxLength={500}
              required
              placeholder="Olá! Gostaria de entrar no servidor porque…"
              value={joinMessage}
              onChange={(e) => setJoinMessage(e.target.value)}
            />
          </label>
          <p className="comm-dialog-note muted">Isso envia uma solicitação para os administradores.</p>
          <div className="form-actions">
            <button type="submit" className="btn btn-primary">
              Enviar solicitação
            </button>
            <button type="button" className="btn" onClick={() => setJoinTarget(null)}>
              Cancelar
            </button>
          </div>
        </form>
      </NativeDialog>
    </div>
    </>
  );
}
