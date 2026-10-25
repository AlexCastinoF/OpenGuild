import { FormEvent, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Eye, EyeOff, Lock, ShieldCheck, User } from 'lucide-react';
import { api } from '../lib/api';
import { useAuthStore } from '../store/auth';
import { useBrandStore } from '../store/brand';
import type { AuthUser } from '@steamfarm/shared';
import '../styles/auth-login.css';

function safeNext(raw: string | null): string {
  const n = (raw || '').trim();
  if (!n.startsWith('/') || n.startsWith('//')) return '/comunidade';
  return n;
}

function isDesktopApp() {
  return typeof window !== 'undefined' && !!window.sfDesktop;
}

const REMEMBER_USER_KEY = 'sf-login-remember-user';

export function LoginPage() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const setUser = useAuthStore((s) => s.setUser);
  const brandName = useBrandStore((s) => s.name);
  const brandShort = useBrandStore((s) => s.short_name);
  const brandLogo = useBrandStore((s) => s.logo_url);
  const rootRef = useRef<HTMLDivElement>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [remember, setRemember] = useState(true);
  const [openAtLogin, setOpenAtLogin] = useState(false);
  const [error, setError] = useState('');
  const [hint, setHint] = useState('');
  const [localTarget, setLocalTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [registerEnabled, setRegisterEnabled] = useState(true);
  const desktop = isDesktopApp();
  const next = safeNext(params.get('next'));

  useEffect(() => {
    try {
      const saved = localStorage.getItem(REMEMBER_USER_KEY);
      if (saved) {
        setUsername(saved);
        setRemember(true);
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) return;

    let raf = 0;
    const onMove = (e: PointerEvent) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const r = el.getBoundingClientRect();
        const x = ((e.clientX - r.left) / r.width) * 100;
        const y = ((e.clientY - r.top) / r.height) * 100;
        el.style.setProperty('--mx', `${x}%`);
        el.style.setProperty('--my', `${y}%`);
      });
    };
    el.addEventListener('pointermove', onMove, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener('pointermove', onMove);
    };
  }, []);

  useEffect(() => {
    void api<{ needs_setup?: boolean; register_enabled?: boolean; user?: AuthUser | null }>(
      '/api/auth/status',
    )
      .then((s) => {
        setNeedsSetup(!!s.needs_setup);
        setRegisterEnabled(s.register_enabled !== false);
        if (s.user) {
          setUser(s.user);
          nav(next, { replace: true });
        }
      })
      .catch(() => undefined);
  }, [nav, next, setUser]);

  useEffect(() => {
    if (!desktop) return;
    const desk = window.sfDesktop;
    if (!desk) return;
    void (async () => {
      try {
        const settings = await desk.getSettings?.();
        if (settings && typeof settings.openAtLogin === 'boolean') {
          setOpenAtLogin(!!settings.openAtLogin);
        }
        const creds = await desk.getSavedCreds?.();
        if (creds?.username) {
          setUsername(creds.username);
          setPassword(creds.password || '');
          setRemember(true);
        }
        const cfg = await desk.getConfig?.();
        if (cfg?.serverUrl) setLocalTarget(cfg.serverUrl);
        if (cfg?.isDev || /localhost|127\.0\.0\.1/.test(String(cfg?.serverUrl || ''))) {
          setHint(
            'Electron local entra na API de desenvolvimento (não em chat.example.com). Usa o username da conta local, por exemplo admin.',
          );
        }
      } catch {
        /* ignore */
      }
    })();
  }, [desktop]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setHint('');
    setBusy(true);
    try {
      try {
        if (remember && username.trim()) localStorage.setItem(REMEMBER_USER_KEY, username.trim());
        else localStorage.removeItem(REMEMBER_USER_KEY);
      } catch {
        /* ignore */
      }

      if (desktop && window.sfDesktop?.login) {
        const res = (await window.sfDesktop.login(username, password, remember)) as {
          status?: number;
          ok?: boolean;
          user?: AuthUser;
          error?: string;
          message?: string | string[];
          serverUrl?: string;
        };
        await window.sfDesktop.setSettings?.({ openAtLogin });
        if (res?.user || res?.ok) {
          if (res.user) setUser(res.user);
          else {
            const me = await api<{ user: AuthUser }>('/api/auth/me').catch(() => null);
            if (me?.user) setUser(me.user);
          }
          nav(next, { replace: true });
          return;
        }
        if (res?.status && res.status >= 400) {
          const nested = Array.isArray(res.message) ? res.message.join(', ') : res.message;
          setError(res.error || nested || 'Usuário ou senha inválidos');
          if (res.serverUrl && /localhost|127\.0\.0\.1/.test(res.serverUrl)) {
            setHint(
              'Este app está no servidor local. O username é o da base local (ex.: admin), não um nome de perfil da produção.',
            );
          }
          return;
        }
      }

      const data = await api<{ user: AuthUser }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password, desktop: desktop || undefined }),
      });
      if (desktop && window.sfDesktop) {
        if (remember) {
          const saved = (await (
            window.sfDesktop as unknown as {
              saveCreds?: (u: string, p: string) => Promise<{ ok?: boolean; reason?: string } | undefined>;
            }
          ).saveCreds?.(username, password)) as { ok?: boolean; reason?: string } | undefined;
          // Sem criptografia do sistema o desktop não grava a senha; avisa em vez de falhar em silêncio
          if (saved && saved.ok === false && saved.reason === 'encryption_unavailable') {
            window.alert(
              'Não foi possível guardar a senha com segurança neste computador. Você precisará entrar de novo na próxima abertura.',
            );
          }
        } else {
          await (
            window.sfDesktop as unknown as { clearCreds?: () => Promise<unknown> }
          ).clearCreds?.();
        }
        await window.sfDesktop.setSettings?.({ openAtLogin });
      }
      setUser(data.user);
      nav(next, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro');
    } finally {
      setBusy(false);
    }
  }

  const registerTo = `/register?next=${encodeURIComponent(next)}`;

  return (
    <div className="sf-login" ref={rootRef}>
      <div className="sf-login-stage" aria-hidden="true">
        <div className="sf-login-aurora" />
        <div className="sf-login-spotlight" />
        <div className="sf-login-grid" />
        <div className="sf-login-rings">
          <i />
          <i />
          <i />
        </div>
        <div className="sf-login-beam sf-login-beam-a" />
        <div className="sf-login-beam sf-login-beam-b" />
        <div className="sf-login-blob sf-login-blob-a" />
        <div className="sf-login-blob sf-login-blob-b" />
        <div className="sf-login-blob sf-login-blob-c" />
        <div className="sf-login-particles">
          {Array.from({ length: 28 }).map((_, i) => (
            <span key={i} style={{ ['--i' as string]: i }} />
          ))}
        </div>
        <div className="sf-login-hex">
          <b />
          <b />
          <b />
          <b />
        </div>
        <div className="sf-login-noise" />
        <div className="sf-login-vignette" />
      </div>

      <div className="sf-login-layout">
        <aside className="sf-login-hero">
          <div className="sf-login-hero-brand">
            <img src={brandLogo || '/logo.png'} alt="" />
            <div>
              <strong>{brandShort || 'SteamFarm'}</strong>
              <em>{brandName.includes(brandShort) ? brandName.replace(brandShort, '').trim() || 'Comunidade' : brandName}</em>
            </div>
          </div>
          <h2>O hub do seu time competitivo.</h2>
          <p>
            Voz, tela, WhatsApp e operação Steam num só lugar — visual de launcher, ritmo de
            produção.
          </p>
          <ul className="sf-login-signals">
            <li>
              <span />
              Canais de voz com stage
            </li>
            <li>
              <span />
              WhatsApp multi-sessão
            </li>
            <li>
              <span />
              Contas Steam na mesma base
            </li>
          </ul>
        </aside>

        <form
          className={`sf-login-card${busy ? ' is-busy' : ''}${error ? ' is-error' : ''}`}
          onSubmit={onSubmit}
          autoComplete="on"
        >
          <div className="sf-login-card-shine" aria-hidden />

          <div className="sf-login-card-top">
            <div className="sf-login-brand">
              <img src={brandLogo || '/logo.png'} alt="" width={36} height={36} />
              <strong>{brandShort || 'SteamFarm'}</strong>
            </div>
            <span className="sf-login-secure" title="Sessão autenticada com cookie seguro">
              <ShieldCheck size={13} aria-hidden />
              Seguro
            </span>
          </div>

          <h1>Bem-vindo de volta</h1>
          <p className="sf-login-sub">
            Entre na sua conta para continuar jogando.
            {localTarget ? (
              <>
                {' '}
                <span className="sf-login-local-target">Servidor: {localTarget}</span>
              </>
            ) : null}
          </p>

          <label className="sf-login-field" style={{ ['--d' as string]: '1' }}>
            <span>Usuário</span>
            <div className="sf-login-input">
              <User size={16} aria-hidden />
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoFocus
                autoComplete="username"
                name="username"
                placeholder="seu usuário"
                required
              />
            </div>
          </label>

          <label className="sf-login-field" style={{ ['--d' as string]: '2' }}>
            <span>Senha</span>
            <div className="sf-login-input">
              <Lock size={16} aria-hidden />
              <input
                type={showPass ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                name="password"
                placeholder="••••••••"
                required
              />
              <button
                type="button"
                className="sf-login-eye"
                aria-label={showPass ? 'Ocultar senha' : 'Mostrar senha'}
                onClick={() => setShowPass((v) => !v)}
              >
                {showPass ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </label>

          <div className="sf-login-row" style={{ ['--d' as string]: '3' }}>
            <label className="sf-login-check">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
              />
              <span>Lembrar de mim</span>
            </label>
            <button
              type="button"
              className="sf-login-forgot"
              onClick={() =>
                setHint('Para redefinir a senha, fale com um administrador da plataforma.')
              }
            >
              Esqueci minha senha
            </button>
          </div>

          {desktop ? (
            <label className="sf-login-check sf-login-check-block" style={{ ['--d' as string]: '3' }}>
              <input
                type="checkbox"
                checked={openAtLogin}
                onChange={(e) => {
                  const on = e.target.checked;
                  setOpenAtLogin(on);
                  if (on) setRemember(true);
                  void window.sfDesktop?.setSettings?.({ openAtLogin: on });
                }}
              />
              <span>Iniciar com o Windows</span>
            </label>
          ) : null}

          {error ? (
            <div className="sf-login-error" role="alert">
              {error}
            </div>
          ) : null}
          {hint ? <div className="sf-login-hint">{hint}</div> : null}

          <button type="submit" className="sf-login-submit" disabled={busy}>
            <span className="sf-login-submit-bg" aria-hidden />
            <span className="sf-login-submit-label">
              {busy ? (
                <>
                  <i className="sf-login-spinner" aria-hidden />
                  Entrando…
                </>
              ) : (
                'Entrar'
              )}
            </span>
          </button>

          <p className="sf-login-foot">
            {registerEnabled ? (
              <>
                Ainda não tem uma conta? <Link to={registerTo}>Criar conta</Link>
              </>
            ) : (
              <span>Cadastro fechado no momento.</span>
            )}
            {needsSetup ? (
              <>
                {' · '}
                <Link to="/setup">Setup inicial</Link>
              </>
            ) : null}
          </p>
        </form>
      </div>
    </div>
  );
}
