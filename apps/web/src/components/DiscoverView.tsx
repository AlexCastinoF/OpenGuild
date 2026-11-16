import { FormEvent, useEffect, useState, useMemo } from 'react';
import { Search, Compass, Users, Sparkles, X, Clock, CheckCircle2 } from 'lucide-react';
import { api } from '../lib/api';
import { NativeDialog } from './CommunityDialogs';

export type ListedServer = {
  id: number;
  name: string;
  description: string;
  icon_url: string;
  banner_url: string;
  is_member?: boolean;
  join_pending?: boolean;
  member_count?: number;
  admins?: Array<{ label: string; username: string; avatar_url: string; role: string }>;
};

interface DiscoverViewProps {
  brandName?: string;
  onOpenInvite: () => void;
  onSelectServer: (serverId: number) => void;
}

export function DiscoverView({ brandName = 'RallyDesk', onOpenInvite, onSelectServer }: DiscoverViewProps) {
  const [servers, setServers] = useState<ListedServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [searchQuery, setSearchQuery] = useState('');

  // Join request modal state
  const [joinTarget, setJoinTarget] = useState<ListedServer | null>(null);
  const [joinMessage, setJoinMessage] = useState('');
  const [submittingJoin, setSubmittingJoin] = useState(false);
  const [joinSuccess, setJoinSuccess] = useState('');
  const [joinError, setJoinError] = useState('');

  useEffect(() => {
    loadServers();
  }, []);

  async function loadServers() {
    setLoading(true);
    setError('');
    try {
      const data = await api<{ servers: ListedServer[] }>('/api/community/discover');
      setServers(data.servers || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível carregar os servidores.');
    } finally {
      setLoading(false);
    }
  }

  const filteredServers = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return servers;
    return servers.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        (s.description && s.description.toLowerCase().includes(q)),
    );
  }, [servers, searchQuery]);

  async function handleSubmitJoin(e: FormEvent) {
    e.preventDefault();
    if (!joinTarget) return;
    setSubmittingJoin(true);
    setJoinError('');

    try {
      await api(`/api/community/servers/${joinTarget.id}/join-requests`, {
        method: 'POST',
        body: JSON.stringify({ message: joinMessage.trim() || 'Gostaria de entrar na comunidade.' }),
      });

      // Update local state to show pending
      setServers((prev) =>
        prev.map((s) => (s.id === joinTarget.id ? { ...s, join_pending: true } : s)),
      );

      setJoinSuccess(`Solicitação enviada para ${joinTarget.name}!`);
      setTimeout(() => {
        setJoinTarget(null);
        setJoinMessage('');
        setJoinSuccess('');
      }, 1500);
    } catch (err) {
      setJoinError(err instanceof Error ? err.message : 'Falha ao enviar solicitação.');
    } finally {
      setSubmittingJoin(false);
    }
  }

  return (
    <div className="comm-discover-wrap" data-theme-surface="chat">
      {/* Discover Top Header */}
      <header className="comm-discover-header">
        <div className="comm-discover-header-text">
          <div className="comm-discover-kicker">
            <Sparkles size={14} /> EXPLORAR COMUNIDADES
          </div>
          <h1 className="comm-discover-title">Descobrir Servidores</h1>
          <p className="comm-discover-subtitle">
            Encontre novas comunidades públicas para jogar, conversar e compartilhar.
          </p>
        </div>

        <div className="comm-discover-controls">
          {/* Real-time search filter */}
          <div className="comm-discover-search-box">
            <Search size={18} className="comm-discover-search-icon" />
            <input
              type="text"
              className="comm-discover-search-input"
              placeholder="Buscar por nome ou tema..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery ? (
              <button
                type="button"
                className="comm-discover-search-clear"
                onClick={() => setSearchQuery('')}
                title="Limpar busca"
              >
                <X size={15} />
              </button>
            ) : null}
          </div>

          {/* Button to join via invite code (moved here as requested) */}
          <button
            type="button"
            className="btn btn-secondary comm-discover-invite-btn"
            onClick={onOpenInvite}
            title="Entrar com convite"
          >
            <Compass size={18} />
            <span>Entrar com convite</span>
          </button>
        </div>
      </header>

      {/* Main Server Cards List */}
      <div className="comm-discover-body">
        {loading ? (
          <div className="comm-discover-loading">
            <div className="comm-discover-spinner" />
            <p>Carregando comunidades...</p>
          </div>
        ) : error ? (
          <div className="comm-discover-error-wrap">
            <p className="comm-discover-error-msg">{error}</p>
            <button type="button" className="btn btn-sm" onClick={loadServers}>
              Tentar novamente
            </button>
          </div>
        ) : filteredServers.length === 0 ? (
          <div className="comm-discover-empty">
            <Search size={42} className="comm-discover-empty-icon" />
            <h3>Nenhum servidor encontrado</h3>
            <p>
              {searchQuery
                ? `Não encontramos nenhum resultado para "${searchQuery}". Tente pesquisar outro termo.`
                : 'Nenhum servidor público listado no momento.'}
            </p>
          </div>
        ) : (
          <div className="comm-discover-grid">
            {filteredServers.map((s) => (
              <article className="comm-discover-card" key={s.id}>
                <div
                  className={`comm-discover-card-banner ${s.banner_url ? 'has-image' : 'is-default'}`}
                  style={s.banner_url ? { backgroundImage: `url(${s.banner_url})` } : undefined}
                />
                <div className="comm-discover-card-content">
                  <div className="comm-discover-card-top-row">
                    {s.icon_url ? (
                      <img src={s.icon_url} alt="" className="comm-discover-card-icon" />
                    ) : (
                      <div className="comm-discover-card-icon-fallback">
                        {s.name.slice(0, 2).toUpperCase()}
                      </div>
                    )}
                    <span className="comm-discover-member-badge">
                      <Users size={12} />
                      <span>{s.member_count ?? s.admins?.length ?? 1} membros</span>
                    </span>
                  </div>

                  <h2 className="comm-discover-card-name" title={s.name}>
                    {s.name}
                  </h2>

                  <p className="comm-discover-card-desc">
                    {s.description || 'Comunidade pública aberta para novos membros.'}
                  </p>

                  <div className="comm-discover-card-actions">
                    {s.is_member ? (
                      <button
                        type="button"
                        className="btn btn-secondary comm-discover-card-btn"
                        onClick={() => onSelectServer(s.id)}
                      >
                        Abrir Servidor
                      </button>
                    ) : s.join_pending ? (
                      <span className="comm-discover-pending-pill">
                        <Clock size={14} /> Solicitação pendente
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-primary comm-discover-card-btn"
                        onClick={() => {
                          setJoinTarget(s);
                          setJoinMessage('');
                          setJoinError('');
                          setJoinSuccess('');
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
        )}
      </div>

      {/* Join Request Dialog */}
      <NativeDialog open={!!joinTarget} onClose={() => setJoinTarget(null)}>
        <form className="comm-dialog-form" onSubmit={(e) => void handleSubmitJoin(e)}>
          <h2>Solicitar entrada</h2>
          <p className="comm-dialog-hint muted">{joinTarget?.name}</p>

          {joinSuccess ? (
            <div className="comm-discover-success-box">
              <CheckCircle2 size={18} />
              <span>{joinSuccess}</span>
            </div>
          ) : (
            <>
              <label>
                <span>Mensagem para os moderadores (opcional)</span>
                <textarea
                  value={joinMessage}
                  onChange={(e) => setJoinMessage(e.target.value)}
                  placeholder="Olá! Gostaria de participar da comunidade..."
                  rows={3}
                />
              </label>

              {joinError ? (
                <p className="comm-dialog-hint" style={{ color: 'var(--comm-danger, #ff4c4c)' }}>
                  {joinError}
                </p>
              ) : null}

              <div className="form-actions">
                <button type="submit" className="btn btn-primary" disabled={submittingJoin}>
                  {submittingJoin ? 'Enviando...' : 'Enviar solicitação'}
                </button>
                <button type="button" className="btn" onClick={() => setJoinTarget(null)}>
                  Cancelar
                </button>
              </div>
            </>
          )}
        </form>
      </NativeDialog>
    </div>
  );
}
