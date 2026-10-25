import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import { api } from '../lib/api';
import { useAuthStore } from '../store/auth';
import { useBrandStore } from '../store/brand';
import type { AuthUser } from '@steamfarm/shared';

function safeNext(raw: string | null): string {
  const n = (raw || '').trim();
  if (!n.startsWith('/') || n.startsWith('//')) return '/comunidade';
  return n;
}

export function RegisterPage() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const setUser = useAuthStore((s) => s.setUser);
  const brandName = useBrandStore((s) => s.name);
  const brandLogo = useBrandStore((s) => s.logo_url);
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [captchaToken, setCaptchaToken] = useState('');
  const [captchaQuestion, setCaptchaQuestion] = useState('');
  const [captchaAnswer, setCaptchaAnswer] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const next = safeNext(params.get('next'));

  const loadCaptcha = useCallback(async () => {
    try {
      const d = await api<{ captcha_token: string; question: string }>('/api/auth/captcha');
      setCaptchaToken(d.captcha_token);
      setCaptchaQuestion(d.question);
      setCaptchaAnswer('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao carregar captcha');
    }
  }, []);

  useEffect(() => {
    void loadCaptcha();
  }, [loadCaptcha]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const data = await api<{ user: AuthUser }>('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          username,
          password,
          display_name: displayName,
          captcha_token: captchaToken,
          captcha_answer: captchaAnswer,
        }),
      });
      setUser(data.user);
      nav(next, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro');
      void loadCaptcha();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={onSubmit}>
        <div className="auth-brand">
          <img src={brandLogo || '/logo.png'} alt="" width={40} height={40} />
          <h1>Criar conta</h1>
        </div>
        <p>{brandName}</p>
        <label htmlFor="reg-user">Usuário</label>
        <input
          id="reg-user"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          required
        />
        <label htmlFor="reg-display">Nome de exibição</label>
        <input
          id="reg-display"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          autoComplete="nickname"
        />
        <label htmlFor="reg-pass">Senha</label>
        <input
          id="reg-pass"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          minLength={6}
          required
        />
        <label htmlFor="reg-captcha">Anti-robô</label>
        <div className="auth-captcha">
          <span className="auth-captcha-q">{captchaQuestion || 'Carregando…'}</span>
          <input
            id="reg-captcha"
            value={captchaAnswer}
            onChange={(e) => setCaptchaAnswer(e.target.value)}
            inputMode="numeric"
            placeholder="Resposta"
            required
            autoComplete="off"
          />
          <button
            type="button"
            className="auth-captcha-refresh"
            title="Nova pergunta"
            onClick={() => void loadCaptcha()}
            disabled={busy}
          >
            <RefreshCw size={14} />
          </button>
        </div>
        {error ? <div className="error">{error}</div> : null}
        <button type="submit" disabled={busy || !captchaToken}>
          {busy ? 'Registrando…' : 'Registrar'}
        </button>
        <div className="links">
          <Link to={`/login?next=${encodeURIComponent(next)}`}>Já tenho conta</Link>
        </div>
      </form>
    </div>
  );
}
