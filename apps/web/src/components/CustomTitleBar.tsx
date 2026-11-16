import React, { useEffect, useState, useCallback } from 'react';
import { Minus, Square, X } from 'lucide-react';
import { useBrandStore } from '../store/brand';
import '../styles/custom-titlebar.css';

async function getTauriWindow() {
  if (typeof window === 'undefined') return null;
  const anyWin = window as unknown as { __TAURI__?: { window?: { getCurrentWindow?: () => { minimize?: () => Promise<void>; toggleMaximize?: () => Promise<void>; isMaximized?: () => Promise<boolean>; close?: () => Promise<void> } } } };
  if (anyWin.__TAURI__?.window?.getCurrentWindow) {
    return anyWin.__TAURI__.window.getCurrentWindow();
  }
  return null;
}

export function CustomTitleBar() {
  const [isMaximized, setIsMaximized] = useState(false);
  const brand = useBrandStore();

  const syncMaximized = useCallback(async () => {
    try {
      if (window.sfDesktop?.windowIsMaximized) {
        const max = await window.sfDesktop.windowIsMaximized();
        setIsMaximized(!!max);
        return;
      }
      const win = await getTauriWindow();
      if (win?.isMaximized) {
        const max = await win.isMaximized();
        setIsMaximized(!!max);
      }
    } catch (_) {}
  }, []);

  useEffect(() => {
    void syncMaximized();

    const onResize = () => {
      void syncMaximized();
    };

    window.addEventListener('resize', onResize);

    let unlisten: (() => void) | undefined;
    const anyWin = window as unknown as { __TAURI__?: { event?: { listen?: (name: string, cb: () => void) => Promise<() => void> } } };
    if (anyWin.__TAURI__?.event?.listen) {
      void anyWin.__TAURI__.event
        .listen('tauri://resize', onResize)
        .then((fn) => {
          unlisten = fn;
        })
        .catch(() => {});
    }

    return () => {
      window.removeEventListener('resize', onResize);
      if (unlisten) unlisten();
    };
  }, [syncMaximized]);

  const handleMinimize = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      if (window.sfDesktop?.windowMinimize) {
        await window.sfDesktop.windowMinimize();
        return;
      }
      const win = await getTauriWindow();
      if (win?.minimize) {
        await win.minimize();
      }
    } catch (err) {
      console.warn('[CustomTitleBar] minimize failed:', err);
    }
  };

  const handleToggleMaximize = async (e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    try {
      if (window.sfDesktop?.windowToggleMaximize) {
        const nextState = await window.sfDesktop.windowToggleMaximize();
        setIsMaximized(nextState);
        return;
      }
      const win = await getTauriWindow();
      if (win?.toggleMaximize) {
        await win.toggleMaximize();
        setTimeout(syncMaximized, 80);
      }
    } catch (err) {
      console.warn('[CustomTitleBar] toggleMaximize failed:', err);
    }
  };

  const handleClose = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      if (window.sfDesktop?.windowClose) {
        await window.sfDesktop.windowClose();
        return;
      }
      const win = await getTauriWindow();
      if (win?.close) {
        await win.close();
      }
    } catch (err) {
      console.warn('[CustomTitleBar] close failed:', err);
    }
  };

  const titleText = brand.name || 'RallyDesk';

  return (
    <header
      className={`custom-titlebar${isMaximized ? ' is-maximized' : ''}`}
      data-theme-surface="header"
      data-tauri-drag-region
      onDoubleClick={() => void handleToggleMaximize()}
      role="banner"
      aria-label="Barra de título da janela"
    >
      {/* Lado esquerdo: Ícone e Título da Marca */}
      <div className="custom-titlebar-brand" data-tauri-drag-region>
        <span className="custom-titlebar-icon" aria-hidden>
          <img
            src={brand.logo_url || '/logo.png'}
            alt="RallyDesk"
            style={{ width: '18px', height: '18px', borderRadius: '5px', objectFit: 'cover' }}
          />
        </span>
        <span className="custom-titlebar-title" data-tauri-drag-region>
          {titleText}
        </span>
      </div>

      {/* Centro: Espaço expansível para arrastar a janela */}
      <div className="custom-titlebar-drag" data-tauri-drag-region />

      {/* Lado direito: Botões Minimizar, Maximizar / Restaurar e Fechar */}
      <div
        className="custom-titlebar-controls"
        data-tauri-drag-region="false"
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="custom-titlebar-btn"
          title="Minimizar"
          aria-label="Minimizar"
          onClick={handleMinimize}
        >
          <Minus size={14} strokeWidth={1.8} />
        </button>

        <button
          type="button"
          className="custom-titlebar-btn"
          title={isMaximized ? 'Restaurar' : 'Maximizar'}
          aria-label={isMaximized ? 'Restaurar' : 'Maximizar'}
          onClick={(e) => void handleToggleMaximize(e)}
        >
          {isMaximized ? (
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4">
              <rect x="3.5" y="1.5" width="7" height="7" rx="0.5" />
              <path d="M1.5 3.5v7h7" />
            </svg>
          ) : (
            <Square size={11} strokeWidth={1.8} />
          )}
        </button>

        <button
          type="button"
          className="custom-titlebar-btn is-close"
          title="Fechar"
          aria-label="Fechar"
          onClick={handleClose}
        >
          <X size={15} strokeWidth={1.8} />
        </button>
      </div>
    </header>
  );
}
