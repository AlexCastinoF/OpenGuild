import { Link, useLocation } from 'react-router-dom';
import { useEffect, useRef, useState } from 'react';
import { Download } from 'lucide-react';
import { useAuthStore } from '../store/auth';
import { useBrandStore } from '../store/brand';
import { api } from '../lib/api';
import { YoutubeNavPlayer } from './youtube/YoutubePlayerHost';

const DEFAULT_AVATAR = '/icon.svg';

/** Cabeçalho web (igual Flask): marca, nav, Baixar app, nome logado. */
export function WebTopNav() {
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const brandName = useBrandStore((s) => s.name);
  const brandLogo = useBrandStore((s) => s.logo_url);
  const loc = useLocation();
  const [open, setOpen] = useState(false);
  const ddRef = useRef<HTMLDivElement>(null);
  const isDesktop = typeof window !== 'undefined' && !!window.sfDesktop;

  useEffect(() => {
    if (!open) return;
    function onDoc(ev: MouseEvent) {
      if (ddRef.current && ev.target instanceof Node && !ddRef.current.contains(ev.target)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  useEffect(() => {
    document.body.classList.toggle('has-app-nav', !isDesktop && !!user);
    document.body.classList.toggle('is-desktop-app', isDesktop);
    return () => {
      document.body.classList.remove('has-app-nav');
    };
  }, [user, isDesktop]);

  if (isDesktop || !user) return null;

  const face = (user.avatar_url || '').trim() || DEFAULT_AVATAR;
  const name = user.label || user.username || 'Conta';

  async function logout() {
    await api('/api/auth/logout', { method: 'POST', body: '{}' }).catch(() => undefined);
    setUser(null);
    window.location.href = '/login';
  }

  return (
    <header className="steam-top" data-theme-surface="header">
      <Link className="steam-logo" to="/comunidade" aria-label={brandName}>
        <img src={brandLogo || '/logo.png'} width={28} height={28} alt="" aria-hidden />
        <span>{brandName}</span>
      </Link>
      <nav className="steam-nav" aria-label="Principal">
        <div className="steam-nav-primary">
          <Link
            to="/comunidade"
            className={loc.pathname.startsWith('/comunidade') ? 'is-on' : undefined}
          >
            Comunidade
          </Link>
          <Link
            to="/descobrir"
            className={loc.pathname.startsWith('/descobrir') ? 'is-on' : undefined}
          >
            Descobrir
          </Link>
          <Link
            to="/youtube"
            className={loc.pathname.startsWith('/youtube') ? 'is-on' : undefined}
          >
            YouTube
          </Link>
          <YoutubeNavPlayer />
        </div>
      </nav>
      <div className="steam-user">
        <a className="steam-download-card" href="/desktop/download" title="Baixar app Windows">
          <Download className="steam-nav-ico" size={14} aria-hidden />
          <span>Baixar app</span>
        </a>
        <div className="steam-dd steam-dd-user" data-dd ref={ddRef}>
          <button
            type="button"
            className="steam-persona"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            <img
              className="avatar avatar-sq"
              src={face}
              alt=""
              width={32}
              height={32}
              loading="lazy"
              referrerPolicy="no-referrer"
              onError={(e) => {
                (e.target as HTMLImageElement).src = DEFAULT_AVATAR;
              }}
            />
            <span className="steam-persona-name">{name}</span>
          </button>
          {open ? (
            <div className="steam-dd-menu steam-dd-menu-right">
              <a href="/desktop/download">Baixar app</a>
              <button type="button" onClick={() => void logout()}>
                Sair
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </header>
  );
}
