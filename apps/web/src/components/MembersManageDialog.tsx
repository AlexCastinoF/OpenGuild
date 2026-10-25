import { useEffect, useMemo, useState } from 'react';
import { PhoneOff, Save, Shield, UserX, Users } from 'lucide-react';
import { api } from '../lib/api';
import { NativeDialog } from './CommunityDialogs';

type Role = {
  id: number;
  name: string;
  color: string;
  is_default?: boolean;
};

type Member = {
  id: number;
  label: string;
  username: string;
  avatar_url: string;
  role: string;
  ramal?: string;
  custom_roles?: Array<{ id: number; name: string; color: string }>;
};

export function MembersManageDialog({
  open,
  onClose,
  serverId,
  members,
  canManage,
  voiceChannelByUser,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  serverId: number;
  members: Member[];
  canManage: boolean;
  voiceChannelByUser: Record<number, number>;
  onDone: () => void;
}) {
  const [tab, setTab] = useState<'members' | 'roles'>('members');
  const [roles, setRoles] = useState<Role[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [picked, setPicked] = useState<number[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const assignable = useMemo(() => roles.filter((r) => !r.is_default), [roles]);
  const selected = members.find((m) => m.id === selectedId) || null;

  useEffect(() => {
    if (!open) return;
    setTab('members');
    setError('');
    void api<{ roles: Role[] }>(`/api/community/servers/${serverId}/roles`)
      .then((d) => setRoles(d.roles || []))
      .catch((e) => setError(e.message));
  }, [open, serverId]);

  useEffect(() => {
    if (!selected) {
      setPicked([]);
      return;
    }
    setPicked((selected.custom_roles || []).map((r) => r.id));
  }, [selected]);

  async function saveRoles() {
    if (!selected || !canManage) return;
    setBusy(true);
    setError('');
    try {
      await api(`/api/community/servers/${serverId}/members/${selected.id}/roles`, {
        method: 'PATCH',
        body: JSON.stringify({ role_ids: picked }),
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro ao salvar cargos');
    } finally {
      setBusy(false);
    }
  }

  async function kick() {
    if (!selected || !canManage) return;
    if (!confirm(`Expulsar ${selected.label}?`)) return;
    setBusy(true);
    try {
      await api(`/api/community/servers/${serverId}/members/${selected.id}/kick`, {
        method: 'POST',
        body: '{}',
      });
      setSelectedId(null);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro ao expulsar');
    } finally {
      setBusy(false);
    }
  }

  async function disconnectVoice() {
    if (!selected || !canManage) return;
    setBusy(true);
    try {
      await api(`/api/community/servers/${serverId}/members/${selected.id}/voice-disconnect`, {
        method: 'POST',
        body: JSON.stringify({
          channel_id: voiceChannelByUser[selected.id] || undefined,
        }),
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro ao desconectar');
    } finally {
      setBusy(false);
    }
  }

  return (
    <NativeDialog open={open} onClose={onClose} className="comm-dialog comm-dialog-wide">
      <div className="comm-members-manage" onClick={(e) => e.stopPropagation()}>
        <header className="comm-members-manage-head">
          <div>
            <h2>Gestão de membros</h2>
            <p className="muted">Atribua cargos, expulse membros e desconecte da voz.</p>
          </div>
        </header>

        <nav className="comm-settings-tabs" role="tablist">
          <button
            type="button"
            className={`comm-settings-tab${tab === 'members' ? ' is-on' : ''}`}
            onClick={() => setTab('members')}
          >
            <Users size={16} /> Membros
          </button>
          <button
            type="button"
            className={`comm-settings-tab${tab === 'roles' ? ' is-on' : ''}`}
            onClick={() => setTab('roles')}
          >
            <Shield size={16} /> Cargos do servidor
          </button>
        </nav>

        {tab === 'members' ? (
          <div className="comm-members-manage-body">
            <aside className="comm-members-manage-list">
              <ul>
                {members.map((m) => (
                  <li key={m.id}>
                    <button
                      type="button"
                      className={`comm-members-manage-item${selectedId === m.id ? ' is-on' : ''}`}
                      onClick={() => setSelectedId(m.id)}
                    >
                      <img
                        className="comm-avatar"
                        src={m.avatar_url || '/icon.svg'}
                        alt=""
                        width={32}
                        height={32}
                      />
                      <span>
                        <strong>{m.label}</strong>
                        <em>
                          {m.role}
                          {voiceChannelByUser[m.id] ? ' · em voz' : ''}
                        </em>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </aside>
            <div className="comm-members-manage-detail">
              {!selected ? (
                <p className="muted">Selecione um membro na lista.</p>
              ) : (
                <>
                  <h3>{selected.label}</h3>
                  <p className="muted">
                    @{selected.username} · {selected.role}
                    {selected.ramal ? ` · ramal ${selected.ramal}` : ''}
                  </p>

                  {canManage && selected.role !== 'owner' ? (
                    <>
                      <p className="comm-label">Cargos</p>
                      {!assignable.length ? (
                        <p className="muted">
                          Nenhum cargo customizado. Crie em «Cargos do servidor».
                        </p>
                      ) : (
                        <div className="comm-profile-role-picks">
                          {assignable.map((r) => (
                            <label key={r.id} className="comm-check comm-role-assign">
                              <input
                                type="checkbox"
                                checked={picked.includes(r.id)}
                                onChange={() =>
                                  setPicked((prev) =>
                                    prev.includes(r.id)
                                      ? prev.filter((id) => id !== r.id)
                                      : [...prev, r.id],
                                  )
                                }
                              />
                              <span className="comm-role-dot" style={{ background: r.color }} />
                              <span>{r.name}</span>
                            </label>
                          ))}
                        </div>
                      )}
                      <div className="form-actions" style={{ justifyContent: 'flex-start' }}>
                        <button
                          type="button"
                          className="btn btn-primary"
                          disabled={busy || !assignable.length}
                          onClick={() => void saveRoles()}
                        >
                          <Save size={14} /> Salvar cargos
                        </button>
                        {voiceChannelByUser[selected.id] ? (
                          <button
                            type="button"
                            className="btn"
                            disabled={busy}
                            onClick={() => void disconnectVoice()}
                          >
                            <PhoneOff size={14} /> Desconectar da voz
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="btn btn-danger"
                          disabled={busy}
                          onClick={() => void kick()}
                        >
                          <UserX size={14} /> Expulsar
                        </button>
                      </div>
                    </>
                  ) : (
                    <p className="muted">
                      {selected.role === 'owner'
                        ? 'O dono do servidor não pode ter cargos alterados aqui.'
                        : 'Sem permissão para gerenciar este membro.'}
                    </p>
                  )}
                </>
              )}
            </div>
          </div>
        ) : (
          <div className="comm-members-manage-roles-hint">
            <p>
              Para criar e editar permissões dos cargos, use o botão <strong>Cargos</strong> na sidebar
              (Configurações do servidor → aba Cargos).
            </p>
            <ul className="comm-roles-list" style={{ maxHeight: 280 }}>
              {roles.map((r) => (
                <li key={r.id}>
                  <div className="comm-role-pick" style={{ cursor: 'default' }}>
                    <span className="comm-role-dot" style={{ background: r.color }} />
                    {r.name}
                    {r.is_default ? <em className="muted"> · padrão</em> : null}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {error ? <p className="comm-dialog-hint" style={{ color: 'var(--comm-danger)' }}>{error}</p> : null}
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>
            Fechar
          </button>
        </div>
      </div>
    </NativeDialog>
  );
}
