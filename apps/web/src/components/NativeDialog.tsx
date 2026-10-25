import { ReactNode, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

function isDesktopApp() {
  return typeof window !== 'undefined' && !!(window as Window & { sfDesktop?: unknown }).sfDesktop;
}

let desktopDialogDepth = 0;

function focusEditableIn(el: HTMLElement) {
  // Nunca focar botões — no wizard o 1.º botão rouba o foco e parece que não dá para digitar
  const editable = el.querySelector<HTMLElement>(
    'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([disabled]), textarea:not([disabled]), select:not([disabled])',
  );
  if (editable) {
    editable.focus({ preventScroll: true });
    return true;
  }
  // Sem input: foca o dialog para o teclado não ficar no chat atrás do scrim
  if (typeof el.focus === 'function') {
    el.focus({ preventScroll: true });
  }
  return false;
}

/** Abre/fecha dialog nativo. No Electron: portal + show() + scrim (sem showModal). */
export function NativeDialog({
  open,
  onClose,
  className = 'comm-dialog',
  children,
}: {
  open: boolean;
  onClose: () => void;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  const desktop = isDesktopApp();
  const depthRef = useRef(0);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open) {
      if (desktop && !depthRef.current) {
        desktopDialogDepth += 1;
        depthRef.current = desktopDialogDepth;
      }
      // Acima do YouTube PiP (100000) e do overlay Pronto (100080)
      const z = 100100 + depthRef.current * 2;
      if (scrimRef.current) scrimRef.current.style.zIndex = String(z);
      el.style.zIndex = String(z + 1);
      if (!el.open) {
        // showModal + overflow:hidden no shell Electron quebra hit-testing
        if (desktop) el.show();
        else el.showModal();
      }
      const runFocus = () => focusEditableIn(el);
      requestAnimationFrame(runFocus);
      const t1 = window.setTimeout(runFocus, 50);
      const t2 = window.setTimeout(runFocus, 200);
      return () => {
        window.clearTimeout(t1);
        window.clearTimeout(t2);
      };
    }
    if (el.open) el.close();
    if (depthRef.current) {
      desktopDialogDepth = Math.max(0, desktopDialogDepth - 1);
    }
    depthRef.current = 0;
  }, [open, desktop]);

  // Escape no Electron (show() não trata Escape como showModal)
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onCloseRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);

  const node = (
    <>
      {open && desktop ? (
        <div
          ref={scrimRef}
          className="comm-dialog-scrim"
          onClick={() => onCloseRef.current()}
          onPointerDown={(e) => {
            if (e.target === e.currentTarget) onCloseRef.current();
          }}
          aria-hidden
        />
      ) : null}
      <dialog
        ref={ref}
        tabIndex={-1}
        className={`${className}${desktop ? ' is-desktop-dialog' : ''}`}
        onClose={() => onCloseRef.current()}
        onClick={(e) => {
          if (e.target === ref.current) onCloseRef.current();
        }}
        onCancel={(e) => {
          e.preventDefault();
          onCloseRef.current();
        }}
        onMouseDown={(e) => {
          // Garante foco no input clicado (Electron + dialog.show() por vezes falha)
          const t = e.target as HTMLElement | null;
          if (!t) return;
          const field = t.closest('input, textarea, select') as HTMLElement | null;
          if (field && !field.hasAttribute('disabled')) {
            requestAnimationFrame(() => {
              if (document.activeElement !== field) field.focus({ preventScroll: true });
            });
          }
        }}
      >
        {children}
      </dialog>
    </>
  );

  // Portal evita overflow/transform do shell Electron a engolir o dialog
  if (typeof document !== 'undefined') {
    return createPortal(node, document.body);
  }
  return node;
}
