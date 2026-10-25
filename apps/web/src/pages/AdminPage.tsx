import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { WebTopNav } from '../components/WebTopNav';

type Tab = 'servers' | 'channels' | 'requests' | 'storage' | 'users' | 'brand';

type ServerRow = {
  id: number;
  name: string;
  owner_label?: string;
  owner_username?: string;
  members: number;
  channels: number;
  is_listed: boolean;
  is_blocked: boolean;
};

type ChannelRow = {
  id: number;
  server_id: number;
  server_name: string;
  name: string;
  kind: string;
};

type StorageFile = {
  root_id: string;
  root_label: string;
  name: string;
  size: number;
  mtime: number;
  kind: string;
};

type AdminUser = {
  id: number;
  username: string;
  label: string;
  role: string;
  premium_themes: boolean;
  is_disabled: boolean;
  work_status: string;
  has_theme: boolean;
  servers: Array<{ id: number; name: string; role: string }>;
};

function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function AdminPage() {
  const [tab, setTab] = useState<Tab>('servers');
  const [error, setError] = useState('');
  const [servers, setServers] = useState<ServerRow[]>([]);
  const [channels, setChannels] = useState<ChannelRow[]>([]);
  const [requests, setRequests] = useState<
    Array<{ id: number; server_name: string; user: { label: string }; message: string }>
  >([]);
  const [files, setFiles] = useState<StorageFile[]>([]);
  const [totalBytes, setTotalBytes] = useState(0);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [search, setSearch] = useState('');
  const [userQ, setUserQ] = useState('');
  const [editId, setEditId] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const [brandName, setBrandName] = useState('SteamFarm Comunidade');
  const [brandShort, setBrandShort] = useState('SteamFarm');
  const [brandLogo, setBrandLogo] = useState('');
  const [brandFavicon, setBrandFavicon] = useState('');
  const [brandAppIcon, setBrandAppIcon] = useState('');
  const [brandAppIco, setBrandAppIco] = useState('');
  const [brandRev, setBrandRev] = useState(0);
  const [brandSaving, setBrandSaving] = useState(false);

  useEffect(() => {
    document.body.classList.add('page-admin');
    document.body.classList.remove('page-community');
    return () => document.body.classList.remove('page-admin');
  }, []);

  function reload() {
    setError('');
    if (tab === 'brand') {
      api<{
        name: string;
        short_name: string;
        logo_url: string;
        favicon_url: string;
        app_icon_url: string;
        app_ico_url: string;
        revision: number;
      }>('/api/community/admin/brand')
        .then((d) => {
          setBrandName(d.name || '');
          setBrandShort(d.short_name || '');
          setBrandLogo(d.logo_url || '');
          setBrandFavicon(d.favicon_url || '');
          setBrandAppIcon(d.app_icon_url || '');
          setBrandAppIco(d.app_ico_url || '');
          setBrandRev(d.revision || 0);
        })
        .catch((e) => setError(e.message));
    }
    if (tab === 'servers') {
      api<{ servers: ServerRow[] }>('/api/community/admin/servers')
        .then((d) => setServers(d.servers))
        .catch((e) => setError(e.message));
    }
    if (tab === 'channels') {
      api<{ channels: ChannelRow[] }>('/api/community/admin/channels')
        .then((d) => setChannels(d.channels))
        .catch((e) => setError(e.message));
    }
    if (tab === 'requests') {
      api<{ requests: typeof requests }>('/api/community/join-requests')
        .then((d) => setRequests(d.requests))
        .catch((e) => setError(e.message));
    }
    if (tab === 'storage') {
      api<{ files: StorageFile[]; total_bytes: number }>('/api/community/admin/storage')
        .then((d) => {
          setFiles(d.files || []);
          setTotalBytes(d.total_bytes || 0);
        })
        .catch((e) => setError(e.message));
    }
    if (tab === 'users') {
      const q = userQ.trim() ? `?q=${encodeURIComponent(userQ.trim())}` : '';
      api<{ users: AdminUser[] }>(`/api/community/admin/users${q}`)
        .then((d) => setUsers(d.users || []))
        .catch((e) => setError(e.message));
    }
  }

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const filteredServers = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return servers;
    return servers.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        (s.owner_label || '').toLowerCase().includes(q) ||
        (s.owner_username || '').toLowerCase().includes(q) ||
        String(s.id) === q,
    );
  }, [servers, search]);

  async function patchServer(
    id: number,
    data: { name?: string; is_listed?: boolean; is_blocked?: boolean },
  ) {
    setError('');
    try {
      await api(`/api/community/admin/servers/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      });
      setEditId(null);
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao atualizar servidor');
    }
  }

  async function deleteServer(id: number, name: string) {
    if (!confirm(`Excluir servidor "${name}" e todo o conteúdo?`)) return;
    setError('');
    try {
      await api(`/api/community/admin/servers/${id}`, { method: 'DELETE' });
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao excluir servidor');
    }
  }

  async function deleteChannel(id: number, name: string) {
    if (!confirm(`Excluir canal #${name}?`)) return;
    setError('');
    try {
      await api(`/api/community/admin/channels/${id}`, { method: 'DELETE' });
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao excluir canal');
    }
  }

  async function handleReq(id: number, action: 'approve' | 'deny') {
    await api(`/api/community/join-requests/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ action }),
    });
    setRequests((prev) => prev.filter((r) => r.id !== id));
  }

  async function deleteFile(rootId: string, name: string) {
    if (!confirm(`Excluir arquivo ${name}?`)) return;
    setError('');
    try {
      await api(`/api/community/admin/storage/${rootId}/${encodeURIComponent(name)}`, {
        method: 'DELETE',
      });
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao excluir arquivo');
    }
  }

  async function cleanupStorage(rootId: string) {
    if (!confirm(`Limpar versões antigas em ${rootId} (mantém a mais recente)?`)) return;
    setError('');
    try {
      await api('/api/community/admin/storage/cleanup', {
        method: 'POST',
        body: JSON.stringify({ root_id: rootId, keep: 1 }),
      });
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao limpar');
    }
  }

  async function patchUser(id: number, data: Record<string, unknown>) {
    setError('');
    try {
      await api(`/api/community/admin/users/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      });
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao atualizar usuário');
    }
  }

  async function changeUserPassword(id: number, label: string) {
    const pwd = window.prompt(`Nova senha para ${label} (mín. 6 caracteres):`, '');
    if (pwd === null) return;
    const trimmed = pwd.trim();
    if (trimmed.length < 6) {
      setError('Senha muito curta (mínimo 6 caracteres).');
      return;
    }
    const again = window.prompt('Confirme a nova senha:', '');
    if (again === null) return;
    if (again.trim() !== trimmed) {
      setError('As senhas não coincidem.');
      return;
    }
    await patchUser(id, { password: trimmed });
  }

  async function deleteUser(id: number, label: string) {
    if (!confirm(`Excluir usuário ${label}? Esta ação é permanente.`)) return;
    setError('');
    try {
      await api(`/api/community/admin/users/${id}`, { method: 'DELETE' });
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao excluir usuário');
    }
  }

  async function kickUser(userId: number, serverId: number, serverName: string) {
    if (!confirm(`Remover usuário do servidor ${serverName}?`)) return;
    setError('');
    try {
      await api(`/api/community/admin/users/${userId}/kick`, {
        method: 'POST',
        body: JSON.stringify({ server_id: serverId }),
      });
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao kick');
    }
  }

  const tabs: Array<[Tab, string]> = [
    ['brand', 'Marca'],
    ['servers', 'Servidores'],
    ['channels', 'Canais'],
    ['users', 'Usuários'],
    ['storage', 'Exes / Disco'],
    ['requests', 'Pedidos'],
  ];

  async function uploadBrand(file: File, kind: string): Promise<string> {
    const fd = new FormData();
    fd.append('kind', kind);
    fd.append('file', file);
    const res = await fetch('/api/community/media', { method: 'POST', credentials: 'include', body: fd });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; url?: string; error?: string };
    if (!res.ok || !data.ok || !data.url) throw new Error(data.error || 'Falha no upload');
    return data.url;
  }

  async function saveBrand() {
    setBrandSaving(true);
    setError('');
    try {
      const d = await api<{
        name: string;
        short_name: string;
        logo_url: string;
        favicon_url: string;
        app_icon_url: string;
        app_ico_url: string;
        revision: number;
      }>('/api/community/admin/brand', {
        method: 'POST',
        body: JSON.stringify({
          name: brandName,
          short_name: brandShort,
          logo_url: brandLogo,
          favicon_url: brandFavicon,
          app_icon_url: brandAppIcon,
          app_ico_url: brandAppIco,
        }),
      });
      setBrandName(d.name);
      setBrandShort(d.short_name);
      setBrandLogo(d.logo_url);
      setBrandFavicon(d.favicon_url);
      setBrandAppIcon(d.app_icon_url);
      setBrandAppIco(d.app_ico_url);
      setBrandRev(d.revision);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao salvar marca');
    } finally {
      setBrandSaving(false);
    }
  }

  return (
    <>
      <WebTopNav />
      <div className="comm-page" style={{ padding: '24px 20px 48px' }}>
        <div className="saas-hero" style={{ maxWidth: 1180, margin: '0 auto 20px' }}>
          <div>
            <p className="saas-kicker">Administração</p>
            <h1>Painel do super admin</h1>
            <p className="muted">Marca, servidores, usuários, armazenamento e pedidos.</p>
          </div>
          <div className="saas-hero-actions">
            <Link className="btn" to="/comunidade">
              Abrir comunidade
            </Link>
          </div>
        </div>

        <div style={{ maxWidth: 1180, margin: '0 auto', display: 'grid', gap: 16 }}>
          <div className="form-actions" style={{ justifyContent: 'flex-start', gap: 8, flexWrap: 'wrap' }}>
            {tabs.map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={`btn${tab === id ? ' btn-primary' : ''}`}
                onClick={() => setTab(id)}
              >
                {label}
              </button>
            ))}
          </div>

          {error ? <div className="error">{error}</div> : null}

          {tab === 'brand' ? (
            <div className="saas-panel" style={{ display: 'grid', gap: 16, padding: 20 }}>
              <div className="saas-panel-head">
                <h2>Personalização de marca</h2>
                <span className="muted">rev {brandRev}</span>
              </div>
              <p className="muted" style={{ margin: 0 }}>
                Nome, logo e ícones usados na web e no app Electron (janela, bandeja e atalhos Windows).
                Para o Windows, envie PNG no “Ícone app” — o desktop gera um .ico válido sozinho. Campo “.ico”
                só se o arquivo for ICO de verdade (PNG renomeado vira folha em branco no Explorer).
                O ícone embutido no instalador .exe só muda no próximo build do desktop.
              </p>
              <div style={{ display: 'grid', gap: 12, maxWidth: 560 }}>
                <label className="field">
                  <span>Nome do produto</span>
                  <input value={brandName} onChange={(e) => setBrandName(e.target.value)} maxLength={80} />
                </label>
                <label className="field">
                  <span>Nome curto</span>
                  <input value={brandShort} onChange={(e) => setBrandShort(e.target.value)} maxLength={40} />
                </label>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(200px,1fr))', gap: 16 }}>
                {(
                  [
                    ['Logo (web)', brandLogo, setBrandLogo, 'brand-logo', 'image/*'],
                    ['Favicon', brandFavicon, setBrandFavicon, 'brand-favicon', 'image/*'],
                    ['Ícone app (PNG)', brandAppIcon, setBrandAppIcon, 'brand-icon', 'image/png,image/jpeg,image/webp'],
                    ['Ícone Windows (.ico)', brandAppIco, setBrandAppIco, 'brand-ico', '.ico,image/x-icon,image/vnd.microsoft.icon'],
                  ] as const
                ).map(([label, url, setUrl, kind, accept]) => (
                  <div key={kind} style={{ display: 'grid', gap: 8 }}>
                    <strong>{label}</strong>
                    <div
                      style={{
                        width: 72,
                        height: 72,
                        borderRadius: 12,
                        background: 'rgba(0,0,0,.25)',
                        display: 'grid',
                        placeItems: 'center',
                        overflow: 'hidden',
                      }}
                    >
                      {url ? (
                        <img src={url} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </div>
                    <input
                      type="file"
                      accept={accept}
                      onChange={async (e) => {
                        const f = e.target.files?.[0];
                        e.target.value = '';
                        if (!f) return;
                        setError('');
                        try {
                          const u = await uploadBrand(f, kind);
                          setUrl(u);
                        } catch (err) {
                          setError(err instanceof Error ? err.message : 'Upload falhou');
                        }
                      }}
                    />
                    <input
                      value={url}
                      onChange={(e) => setUrl(e.target.value)}
                      placeholder="/uploads/brand/…"
                      style={{ fontSize: 12 }}
                    />
                  </div>
                ))}
              </div>
              <div className="form-actions">
                <button type="button" className="btn btn-primary" disabled={brandSaving} onClick={() => void saveBrand()}>
                  {brandSaving ? 'Salvando…' : 'Salvar marca'}
                </button>
              </div>
            </div>
          ) : null}

          {tab === 'servers' ? (
            <div className="saas-panel users-table-panel">
              <div className="saas-panel-head">
                <h2>Servidores</h2>
                <input
                  type="search"
                  placeholder="Buscar servidor ou dono…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  autoComplete="off"
                />
              </div>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>ID</th>
                      <th>Servidor</th>
                      <th>Dono</th>
                      <th className="num">Membros</th>
                      <th className="num">Canais</th>
                      <th>Listado</th>
                      <th>Bloqueado</th>
                      <th>Ações</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredServers.map((s) => (
                      <tr key={s.id}>
                        <td>{s.id}</td>
                        <td>
                          {editId === s.id ? (
                            <input
                              value={editName}
                              onChange={(e) => setEditName(e.target.value)}
                              style={{ width: '100%' }}
                            />
                          ) : (
                            <strong>{s.name}</strong>
                          )}
                        </td>
                        <td>{s.owner_label || s.owner_username || s.id}</td>
                        <td className="num">{s.members}</td>
                        <td className="num">{s.channels}</td>
                        <td>{s.is_listed ? 'sim' : 'não'}</td>
                        <td>{s.is_blocked ? 'sim' : 'não'}</td>
                        <td>
                          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                            {editId === s.id ? (
                              <>
                                <button
                                  type="button"
                                  className="btn btn-sm btn-primary"
                                  onClick={() => void patchServer(s.id, { name: editName })}
                                >
                                  Salvar
                                </button>
                                <button type="button" className="btn btn-sm" onClick={() => setEditId(null)}>
                                  Cancelar
                                </button>
                              </>
                            ) : (
                              <button
                                type="button"
                                className="btn btn-sm"
                                onClick={() => {
                                  setEditId(s.id);
                                  setEditName(s.name);
                                }}
                              >
                                Renomear
                              </button>
                            )}
                            <button
                              type="button"
                              className="btn btn-sm"
                              onClick={() => void patchServer(s.id, { is_listed: !s.is_listed })}
                            >
                              {s.is_listed ? 'Deslistar' : 'Listar'}
                            </button>
                            <button
                              type="button"
                              className="btn btn-sm"
                              onClick={() => void patchServer(s.id, { is_blocked: !s.is_blocked })}
                            >
                              {s.is_blocked ? 'Desbloquear' : 'Bloquear'}
                            </button>
                            <Link className="btn btn-sm" to={`/comunidade/${s.id}`}>
                              Abrir
                            </Link>
                            <button
                              type="button"
                              className="btn btn-sm btn-danger"
                              onClick={() => void deleteServer(s.id, s.name)}
                            >
                              Excluir
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                    {!filteredServers.length ? (
                      <tr>
                        <td colSpan={8} className="muted">
                          Nenhum servidor.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          {tab === 'channels' ? (
            <div className="saas-panel users-table-panel">
              <div className="saas-panel-head">
                <h2>Canais</h2>
              </div>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>ID</th>
                      <th>Servidor</th>
                      <th>Canal</th>
                      <th>Tipo</th>
                      <th>Ações</th>
                    </tr>
                  </thead>
                  <tbody>
                    {channels.map((c) => (
                      <tr key={c.id}>
                        <td>{c.id}</td>
                        <td>{c.server_name}</td>
                        <td>{c.name}</td>
                        <td>{c.kind}</td>
                        <td>
                          <button
                            type="button"
                            className="btn btn-sm btn-danger"
                            onClick={() => void deleteChannel(c.id, c.name)}
                          >
                            Excluir
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          {tab === 'storage' ? (
            <div className="saas-panel users-table-panel">
              <div className="saas-panel-head">
                <h2>Exes / Disco</h2>
                <span className="muted">Total listado: {fmtBytes(totalBytes)}</span>
              </div>
              <div className="form-actions" style={{ justifyContent: 'flex-start', padding: '0 1rem' }}>
                {['desktop-releases', 'vps-desktop', 'vps-flask-desktop', 'uploads'].map((id) => (
                  <button
                    key={id}
                    type="button"
                    className="btn btn-sm"
                    onClick={() => void cleanupStorage(id)}
                  >
                    Limpar {id}
                  </button>
                ))}
              </div>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Pasta</th>
                      <th>Arquivo</th>
                      <th>Tipo</th>
                      <th className="num">Tamanho</th>
                      <th>Ações</th>
                    </tr>
                  </thead>
                  <tbody>
                    {files.map((f) => (
                      <tr key={`${f.root_id}:${f.name}`}>
                        <td>{f.root_label}</td>
                        <td>
                          <code>{f.name}</code>
                        </td>
                        <td>{f.kind}</td>
                        <td className="num">{fmtBytes(f.size)}</td>
                        <td>
                          <button
                            type="button"
                            className="btn btn-sm btn-danger"
                            onClick={() => void deleteFile(f.root_id, f.name)}
                          >
                            Excluir
                          </button>
                        </td>
                      </tr>
                    ))}
                    {!files.length ? (
                      <tr>
                        <td colSpan={5} className="muted">
                          Nenhum arquivo nas pastas conhecidas (ok em ambiente sem releases).
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          {tab === 'users' ? (
            <div className="saas-panel users-table-panel">
              <div className="saas-panel-head">
                <h2>Usuários</h2>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    reload();
                  }}
                  style={{ display: 'flex', gap: 8 }}
                >
                  <input
                    type="search"
                    placeholder="Buscar usuário…"
                    value={userQ}
                    onChange={(e) => setUserQ(e.target.value)}
                  />
                  <button type="submit" className="btn btn-sm btn-primary">
                    Buscar
                  </button>
                </form>
              </div>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>ID</th>
                      <th>Usuário</th>
                      <th>Role</th>
                      <th>Premium temas</th>
                      <th>Status</th>
                      <th>Servidores</th>
                      <th>Ações</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((u) => (
                      <tr key={u.id}>
                        <td>{u.id}</td>
                        <td>
                          <strong>{u.label}</strong>
                          <div className="muted">@{u.username}</div>
                        </td>
                        <td>{u.role}</td>
                        <td>{u.premium_themes ? 'sim' : 'não'}</td>
                        <td>
                          {u.is_disabled ? 'desativado' : u.work_status || 'disponível'}
                          {u.has_theme ? ' · tema' : ''}
                        </td>
                        <td>
                          <div style={{ display: 'grid', gap: 4 }}>
                            {u.servers.map((s) => (
                              <div key={s.id} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                                <span>
                                  {s.name} ({s.role})
                                </span>
                                {s.role !== 'owner' ? (
                                  <button
                                    type="button"
                                    className="btn btn-sm"
                                    onClick={() => void kickUser(u.id, s.id, s.name)}
                                  >
                                    Kick
                                  </button>
                                ) : null}
                              </div>
                            ))}
                            {!u.servers.length ? <span className="muted">—</span> : null}
                          </div>
                        </td>
                        <td>
                          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                            <button
                              type="button"
                              className="btn btn-sm"
                              onClick={() => void changeUserPassword(u.id, u.label)}
                            >
                              Alterar senha
                            </button>
                            <button
                              type="button"
                              className="btn btn-sm"
                              onClick={() =>
                                void patchUser(u.id, { premium_themes: !u.premium_themes })
                              }
                            >
                              {u.premium_themes ? 'Revogar premium' : 'Dar premium'}
                            </button>
                            <button
                              type="button"
                              className="btn btn-sm"
                              onClick={() =>
                                void patchUser(u.id, {
                                  role: u.role === 'super_admin' ? 'user' : 'super_admin',
                                })
                              }
                            >
                              {u.role === 'super_admin' ? 'Remover super' : 'Tornar super'}
                            </button>
                            <button
                              type="button"
                              className="btn btn-sm"
                              onClick={() => void patchUser(u.id, { is_disabled: !u.is_disabled })}
                            >
                              {u.is_disabled ? 'Reativar' : 'Desativar'}
                            </button>
                            <button
                              type="button"
                              className="btn btn-sm"
                              onClick={() => void patchUser(u.id, { work_status: '' })}
                            >
                              Limpar status
                            </button>
                            {u.has_theme ? (
                              <button
                                type="button"
                                className="btn btn-sm"
                                onClick={() =>
                                  void api(`/api/community/admin/users/${u.id}/theme`, {
                                    method: 'DELETE',
                                  }).then(reload)
                                }
                              >
                                Limpar tema
                              </button>
                            ) : null}
                            <button
                              type="button"
                              className="btn btn-sm btn-danger"
                              onClick={() => void deleteUser(u.id, u.label)}
                            >
                              Excluir
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                    {!users.length ? (
                      <tr>
                        <td colSpan={7} className="muted">
                          Nenhum usuário.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          {tab === 'requests' ? (
            <div className="saas-panel">
              <div className="saas-panel-head">
                <h2>Pedidos de entrada</h2>
              </div>
              <div style={{ padding: '0 1rem 1.25rem', display: 'grid', gap: 10 }}>
                {requests.map((r) => (
                  <div
                    key={r.id}
                    style={{ border: '1px solid var(--line)', padding: 12, borderRadius: 10 }}
                  >
                    <strong>{r.user.label}</strong> → {r.server_name}
                    <div className="muted">{r.message || 'Sem mensagem'}</div>
                    <div className="form-actions" style={{ justifyContent: 'flex-start', marginTop: 8 }}>
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        onClick={() => void handleReq(r.id, 'approve')}
                      >
                        Aprovar
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => void handleReq(r.id, 'deny')}
                      >
                        Negar
                      </button>
                    </div>
                  </div>
                ))}
                {!requests.length ? <p className="muted">Nenhum pedido pendente.</p> : null}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}
