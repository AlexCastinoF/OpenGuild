import { FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuthStore } from '../store/auth';
import type { AuthUser } from '@steamfarm/shared';

export function SetupPage() {
  const nav = useNavigate();
  const setUser = useAuthStore((s) => s.setUser);
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    void api<{ needs_setup?: boolean }>('/api/auth/status')
      .then((s) => {
        if (!s.needs_setup) nav('/login', { replace: true });
        else setChecking(false);
      })
      .catch(() => setChecking(false));
  }, [nav]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    try {
      const data = await api<{ user: AuthUser }>('/api/auth/setup', {
        method: 'POST',
        body: JSON.stringify({ username, password, display_name: displayName }),
      });
      setUser(data.user);
      nav('/comunidade');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro');
    }
  }

  if (checking) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <p>Verificando setup…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={onSubmit}>
        <h1>Setup inicial</h1>
        <p>Cria o primeiro super admin</p>
        <label>Usuário</label>
        <input value={username} onChange={(e) => setUsername(e.target.value)} />
        <label>Nome</label>
        <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        <label>Senha</label>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        {error ? <div className="error">{error}</div> : null}
        <button type="submit">Criar admin</button>
        <div className="links">
          <Link to="/login">Voltar ao login</Link>
        </div>
      </form>
    </div>
  );
}
