import { FormEvent, useEffect, useState } from 'react';
import { NativeDialog } from '../NativeDialog';
import { api } from '../../lib/api';
import { cryptoRememberKey, deriveVerifier, randomSaltB64 } from './waCrypto';
import type { WaSlot } from './waTypes';

export function WaWizardDialog({
  open,
  slotNum,
  onClose,
  onReadyForQr,
}: {
  open: boolean;
  slotNum: number;
  onClose: () => void;
  onReadyForQr: (slot: WaSlot) => void;
}) {
  const [step, setStep] = useState<'privacy' | 'password'>('privacy');
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setStep('privacy');
      setPass('');
      setPass2('');
      setError('');
    }
  }, [open]);

  useEffect(() => {
    if (!open || step !== 'password') return;
    const t = window.setTimeout(() => {
      const el = document.querySelector<HTMLInputElement>(
        '.comm-dialog[open] input[type="password"]',
      );
      el?.focus({ preventScroll: true });
    }, 60);
    return () => window.clearTimeout(t);
  }, [open, step]);

  async function savePass() {
    setError('');
    if (pass.length < 6) {
      setError('Mínimo 6 caracteres.');
      return;
    }
    if (pass !== pass2) {
      setError('Senhas não conferem.');
      return;
    }
    setBusy(true);
    try {
      await api(`/api/community/wa/slots`, {
        method: 'POST',
        body: JSON.stringify({ slot: slotNum }),
      });
      const saltB64 = randomSaltB64();
      const verifier = await deriveVerifier(pass, saltB64);
      const res = await api<{ slot: WaSlot }>(`/api/community/wa/${slotNum}/crypto`, {
        method: 'POST',
        body: JSON.stringify({ salt: saltB64, verifier }),
      });
      localStorage.setItem(cryptoRememberKey(res.slot.session_id), verifier);
      onReadyForQr(res.slot);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro');
    } finally {
      setBusy(false);
    }
  }

  return (
    <NativeDialog open={open} onClose={onClose} className="comm-dialog">
      <div className="comm-dialog-form">
        <h2>Conectar WhatsApp</h2>
        {step === 'privacy' ? (
          <div>
            <p className="comm-dialog-hint">
              Suas mensagens do painel ficam <strong>criptografadas</strong> com uma senha que só você
              conhece. Ao desconectar, apagamos sessão e cache deste WhatsApp.
            </p>
            <ul className="comm-wa-wizard-list">
              <li>Até 2 números por conta</li>
              <li>Sem sincronizar histórico antigo do celular</li>
              <li>Canais/newsletter não entram nas conversas</li>
            </ul>
            <div className="form-actions">
              <button type="button" className="btn btn-primary" onClick={() => setStep('password')}>
                Continuar
              </button>
              <button type="button" className="btn" onClick={onClose}>
                Cancelar
              </button>
            </div>
          </div>
        ) : (
          <div>
            <label>
              Senha de criptografia
              <input
                type="password"
                value={pass}
                onChange={(e) => setPass(e.target.value)}
                autoComplete="new-password"
                minLength={6}
                placeholder="Mín. 6 caracteres"
                autoFocus
              />
            </label>
            <label>
              Confirmar senha
              <input
                type="password"
                value={pass2}
                onChange={(e) => setPass2(e.target.value)}
                autoComplete="new-password"
                minLength={6}
              />
            </label>
            {error ? <p className="error">{error}</p> : null}
            <div className="form-actions">
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={() => void savePass()}
              >
                Salvar e mostrar QR
              </button>
              <button type="button" className="btn" onClick={onClose}>
                Cancelar
              </button>
            </div>
          </div>
        )}
      </div>
    </NativeDialog>
  );
}

export function WaUnlockDialog({
  open,
  slot,
  onClose,
  onUnlocked,
}: {
  open: boolean;
  slot: WaSlot | null;
  onClose: () => void;
  onUnlocked: (verifier: string) => void;
}) {
  const [pass, setPass] = useState('');
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setPass('');
      setError('');
    }
  }, [open]);

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (!slot) return;
    setBusy(true);
    setError('');
    try {
      const saltB64 = slot.crypto_salt || '';
      if (!saltB64 || !pass) {
        setError('Informe a senha.');
        return;
      }
      const verifier = await deriveVerifier(pass, saltB64);
      await api(`/api/community/wa/${slot.slot}/crypto/unlock`, {
        method: 'POST',
        body: JSON.stringify({ verifier }),
      });
      if (remember) localStorage.setItem(cryptoRememberKey(slot.session_id), verifier);
      onUnlocked(verifier);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Senha incorreta');
    } finally {
      setBusy(false);
    }
  }

  return (
    <NativeDialog open={open} onClose={onClose}>
      <form className="comm-dialog-form" onSubmit={(e) => void submit(e)}>
        <h2>Desbloquear WhatsApp</h2>
        <p className="comm-dialog-hint">Digite a senha de criptografia desta conexão.</p>
        <label>
          Senha
          <input
            type="password"
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            autoComplete="current-password"
            autoFocus
          />
        </label>
        {error ? (
          <p className="comm-dialog-hint comm-wa-unlock-error is-error" role="alert">
            {error}
          </p>
        ) : null}
        <label className="comm-check">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
          />
          Não pedir mais neste navegador
        </label>
        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={busy}>
            Desbloquear
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
        </div>
      </form>
    </NativeDialog>
  );
}

export function WaQrDialog({
  open,
  slotNum,
  qrPng,
  statusText,
  onClose,
  onRefresh,
}: {
  open: boolean;
  slotNum: number;
  qrPng: string;
  statusText: string;
  onClose: () => void;
  onRefresh: () => void;
}) {
  return (
    <NativeDialog open={open} onClose={onClose} className="comm-dialog comm-dialog-wa-qr">
      <div className="comm-dialog-form" onPointerDown={(e) => e.stopPropagation()}>
        <div className="comm-dialog-head" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <h2 style={{ flex: 1, margin: 0 }}>Conectar WhatsApp {slotNum}</h2>
          <button
            type="button"
            className="comm-dialog-x"
            aria-label="Fechar"
            onClick={onClose}
            onPointerDown={(e) => {
              e.stopPropagation();
              onClose();
            }}
          >
            ×
          </button>
        </div>
        <p className="muted">
          Escaneie o QR em WhatsApp → Aparelhos conectados. Até 2 números por usuário.
        </p>
        <div className="comm-wa-qr-wrap">
          {qrPng ? (
            <img
              src={qrPng.startsWith('data:') ? qrPng : `data:image/png;base64,${qrPng}`}
              alt="QR WhatsApp"
              draggable={false}
            />
          ) : (
            <p className="muted">{statusText || 'Gerando QR…'}</p>
          )}
        </div>
        {statusText ? <p className="muted">{statusText}</p> : null}
        <div className="form-actions">
          <button type="button" className="btn btn-primary" onClick={onRefresh}>
            Atualizar QR
          </button>
          <button
            type="button"
            className="btn"
            onClick={onClose}
            onPointerDown={(e) => {
              e.stopPropagation();
              onClose();
            }}
          >
            Fechar
          </button>
        </div>
      </div>
    </NativeDialog>
  );
}

export function WaNewChatDialog({
  open,
  slotNum,
  onClose,
  onStarted,
}: {
  open: boolean;
  slotNum: number;
  onClose: () => void;
  onStarted: (jid: string, name: string) => void;
}) {
  const [phone, setPhone] = useState('');
  const [q, setQ] = useState('');
  const [contacts, setContacts] = useState<Array<{ jid: string; name?: string; notify?: string }>>(
    [],
  );
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPhone('');
    setQ('');
    setError('');
    void (async () => {
      try {
        const data = await api<{ contacts?: Array<{ jid: string; name?: string; notify?: string }> }>(
          `/api/community/wa/${slotNum}/contacts`,
        );
        setContacts(data.contacts || []);
      } catch {
        setContacts([]);
      }
    })();
  }, [open, slotNum]);

  async function startPhone() {
    setBusy(true);
    setError('');
    try {
      const data = await api<{ jid?: string; name?: string; error?: string }>(
        `/api/community/wa/${slotNum}/start-chat`,
        { method: 'POST', body: JSON.stringify({ phone }) },
      );
      const jid = data.jid || '';
      if (!jid) throw new Error(data.error || 'Não foi possível iniciar');
      onStarted(jid, data.name || phone);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro');
    } finally {
      setBusy(false);
    }
  }

  const filtered = contacts.filter((c) => {
    if (!q.trim()) return true;
    const hay = `${c.name || ''} ${c.notify || ''} ${c.jid}`.toLowerCase();
    return hay.includes(q.trim().toLowerCase());
  });

  return (
    <NativeDialog open={open} onClose={onClose}>
      <div className="comm-dialog-form">
        <h2>Nova conversa</h2>
        <label>
          Número com DDI
          <input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="5511999999999"
            autoComplete="tel"
          />
        </label>
        {error ? <p className="error">{error}</p> : null}
        <div className="form-actions" style={{ marginTop: 8 }}>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !phone.trim()}
            onClick={() => void startPhone()}
          >
            Iniciar
          </button>
        </div>
        <p className="comm-label" style={{ marginTop: 12 }}>
          Contatos
        </p>
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Buscar contato…"
          style={{ width: '100%', marginBottom: 8 }}
        />
        <div className="comm-wa-contact-list">
          {filtered.slice(0, 80).map((c) => (
            <button
              key={c.jid}
              type="button"
              className="comm-wa-contact-item"
              onClick={() => {
                onStarted(c.jid, c.name || c.notify || c.jid);
                onClose();
              }}
            >
              <strong>{c.name || c.notify || c.jid.split('@')[0]}</strong>
              <span className="muted">{c.jid.split('@')[0]}</span>
            </button>
          ))}
        </div>
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>
            Fechar
          </button>
        </div>
      </div>
    </NativeDialog>
  );
}

export function WaStatusPostDialog({
  open,
  onClose,
  onPost,
}: {
  open: boolean;
  onClose: () => void;
  onPost: (text: string) => Promise<void>;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (open) {
      setText('');
      setError('');
    }
  }, [open]);

  async function submit() {
    if (!text.trim()) {
      setError('Escreva um texto.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await onPost(text.trim());
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao publicar');
    } finally {
      setBusy(false);
    }
  }

  return (
    <NativeDialog open={open} onClose={onClose}>
      <div className="comm-dialog-form">
        <h2>Novo status</h2>
        <label>
          Texto
          <textarea
            rows={4}
            maxLength={700}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="O que você está pensando?"
            style={{ width: '100%' }}
          />
        </label>
        {error ? <p className="error">{error}</p> : null}
        <p className="muted" style={{ fontSize: '.8rem' }}>
          Será enviado aos seus contatos/conversas recentes.
        </p>
        <div className="form-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void submit()}
          >
            Publicar
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
        </div>
      </div>
    </NativeDialog>
  );
}
