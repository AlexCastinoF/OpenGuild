import { FormEvent, useEffect, useMemo, useState } from 'react';
import { PERMISSION_GROUPS } from '@steamfarm/shared';
import { api } from '../lib/api';

type Role = {
  id: number;
  name: string;
  color: string;
  permissions: string[] | unknown;
  is_default?: boolean;
  hoist?: boolean;
  member_card_color?: string | null;
};

type Member = { id: number; label: string; role: string };

export function RolesDialog({
  open,
  onClose,
  serverId,
  members,
  canManage,
}: {
  open: boolean;
  onClose: () => void;
  serverId: number;
  members: Member[];
  canManage: boolean;
}) {
  const [roles, setRoles] = useState<Role[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [color, setColor] = useState('#949ba4');
  const [perms, setPerms] = useState<string[]>([]);
  const [assignUserId, setAssignUserId] = useState<number | ''>('');
  const [assignRoleIds, setAssignRoleIds] = useState<number[]>([]);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<'edit' | 'assign'>('edit');

  const selected = useMemo(
    () => roles.find((r) => r.id === selectedId) || null,
    [roles, selectedId],
  );

  async function load() {
    const d = await api<{ roles: Role[] }>(`/api/community/servers/${serverId}/roles`);
    setRoles(d.roles);
    if (!selectedId && d.roles[0]) {
      selectRole(d.roles[0]);
    } else if (selectedId) {
      const next = d.roles.find((r) => r.id === selectedId);
      if (next) selectRole(next);
    }
  }

  function selectRole(r: Role) {
    setSelectedId(r.id);
    setName(r.name);
    setColor(r.color || '#949ba4');
    const p = Array.isArray(r.permissions) ? (r.permissions as string[]) : [];
    setPerms(p);
  }

  useEffect(() => {
    if (!open) return;
    void load().catch((e) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, serverId]);

  function togglePerm(key: string) {
    setPerms((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  }

  async function createRole(e: FormEvent) {
    e.preventDefault();
    if (!canManage) return;
    const d = await api<{ role: Role }>(`/api/community/servers/${serverId}/roles`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Novo cargo', color: '#5865f2', permissions: [] }),
    });
    await load();
    const created = (await api<{ roles: Role[] }>(`/api/community/servers/${serverId}/roles`)).roles.find(
      (r) => r.id === d.role.id,
    );
    if (created) selectRole(created);
  }

  async function saveRole(e: FormEvent) {
    e.preventDefault();
    if (!selectedId || !canManage) return;
    setError('');
    try {
      await api(`/api/community/servers/${serverId}/roles/${selectedId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name, color, permissions: perms }),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro');
    }
  }

  async function deleteRole() {
    if (!selectedId || !canManage || selected?.is_default) return;
    if (!confirm(`Excluir cargo ${name}?`)) return;
    await api(`/api/community/servers/${serverId}/roles/${selectedId}`, { method: 'DELETE' });
    setSelectedId(null);
    await load();
  }

  async function saveAssign(e: FormEvent) {
    e.preventDefault();
    if (!assignUserId || !canManage) return;
    await api(`/api/community/servers/${serverId}/members/${assignUserId}/roles`, {
      method: 'PATCH',
      body: JSON.stringify({ role_ids: assignRoleIds }),
    });
    alert('Cargos atribuídos.');
  }

  if (!open) return null;

  return (
    <dialog className="comm-dialog" open style={{ width: 'min(820px, 96vw)' }}>
      <div className="comm-dialog-form">
        <h2>Cargos do servidor</h2>
        <p>
          <button type="button" className={`btn${tab === 'edit' ? ' btn-primary' : ''}`} onClick={() => setTab('edit')}>
            Editar cargos
          </button>{' '}
          <button type="button" className={`btn${tab === 'assign' ? ' btn-primary' : ''}`} onClick={() => setTab('assign')}>
            Atribuir a membro
          </button>
        </p>
        {error ? <p className="error">{error}</p> : null}

        {tab === 'edit' ? (
          <div style={{ display: 'grid', gridTemplateColumns: '200px 1fr', gap: 16, minHeight: 360 }}>
            <div>
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 6 }}>
                {roles.map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      className={`comm-ch${selectedId === r.id ? ' is-on' : ''}`}
                      style={{ width: '100%', borderLeft: `3px solid ${r.color}` }}
                      onClick={() => selectRole(r)}
                    >
                      {r.name}
                    </button>
                  </li>
                ))}
              </ul>
              {canManage ? (
                <button type="button" className="btn btn-primary" style={{ marginTop: 10 }} onClick={(e) => void createRole(e)}>
                  + Cargo
                </button>
              ) : null}
            </div>
            {selected ? (
              <form onSubmit={(e) => void saveRole(e)}>
                <label>
                  Nome
                  <input value={name} onChange={(e) => setName(e.target.value)} disabled={!canManage || !!selected.is_default} />
                </label>
                <label>
                  Cor
                  <input type="color" value={color} onChange={(e) => setColor(e.target.value)} disabled={!canManage} />
                </label>
                <div style={{ maxHeight: 240, overflow: 'auto', marginTop: 8 }}>
                  {PERMISSION_GROUPS.map((g) => (
                    <div key={g.group} style={{ marginBottom: 12 }}>
                      <strong style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>{g.group}</strong>
                      {g.permissions.map((p) => (
                        <label key={p.key} style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '4px 0' }}>
                          <input
                            type="checkbox"
                            checked={perms.includes(p.key)}
                            disabled={!canManage}
                            onChange={() => togglePerm(p.key)}
                          />
                          {p.label}
                        </label>
                      ))}
                    </div>
                  ))}
                </div>
                {canManage ? (
                  <div className="form-actions">
                    <button type="submit" className="btn btn-primary">
                      Salvar cargo
                    </button>
                    {!selected.is_default ? (
                      <button type="button" className="btn" onClick={() => void deleteRole()}>
                        Excluir
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </form>
            ) : (
              <p className="muted">Selecione um cargo</p>
            )}
          </div>
        ) : (
          <form onSubmit={(e) => void saveAssign(e)}>
            <label>
              Membro
              <select
                value={assignUserId}
                onChange={(e) => setAssignUserId(e.target.value ? Number(e.target.value) : '')}
              >
                <option value="">—</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
            <div style={{ marginTop: 8 }}>
              {roles
                .filter((r) => !r.is_default)
                .map((r) => (
                  <label key={r.id} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <input
                      type="checkbox"
                      checked={assignRoleIds.includes(r.id)}
                      onChange={() =>
                        setAssignRoleIds((prev) =>
                          prev.includes(r.id) ? prev.filter((x) => x !== r.id) : [...prev, r.id],
                        )
                      }
                    />
                    <span style={{ color: r.color }}>{r.name}</span>
                  </label>
                ))}
            </div>
            <div className="form-actions">
              <button type="submit" className="btn btn-primary" disabled={!canManage}>
                Salvar atribuição
              </button>
            </div>
          </form>
        )}

        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>
            Fechar
          </button>
        </div>
      </div>
    </dialog>
  );
}
