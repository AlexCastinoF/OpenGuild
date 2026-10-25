import { DragEvent, FormEvent, useEffect, useRef, useState } from 'react';
import { Mic, Paperclip, Send, SmilePlus } from 'lucide-react';
import type { WaHubApi } from './useWaHub';
import { messageHasMedia, WaMessageMedia } from './WaMessageMedia';
import { WaMessageContent } from './WaMessageContent';
import { WaCaptionModal } from './WaCaptionModal';
import { WaRecPanel } from './WaRecPanel';
import type { WaMessage } from './waTypes';
import { avatarLetter } from './waCrypto';
import { WA_REACT_EMOJIS } from './waReactions';

function msgText(m: WaMessage) {
  return (m.text || m.body || m.caption || '').trim();
}

function msgTs(m: WaMessage) {
  const t = m.timestampSeconds || m.ts || m.timestamp || 0;
  if (!t) return '';
  const d = new Date(t < 1e12 ? t * 1000 : t);
  const now = new Date();
  const time = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return time;
  return `${d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} ${time}`;
}

function Ticks({ m }: { m: WaMessage }) {
  if (!m.fromMe) return null;
  const ack = String(m.ackStatus || 'sent');
  const title = ack === 'read' ? 'Lido' : ack === 'delivered' ? 'Entregue' : 'Enviado';
  const cls = ack === 'read' ? 'is-read' : ack === 'delivered' ? 'is-delivered' : 'is-sent';
  const marks = ack === 'sent' ? '✓' : '✓✓';
  return (
    <span className={`comm-wa-ticks ${cls}`} title={title} data-ack={ack}>
      {marks}
    </span>
  );
}

function senderLabel(m: WaMessage, chatName: string, isGroup: boolean) {
  if (m.fromMe) return 'Você';
  if (isGroup) return m.pushName || m.participant?.split('@')[0] || chatName || 'Contato';
  return m.pushName || chatName || 'Contato';
}

function WaBubbleAvatar({
  mine,
  slot,
  jid,
  label,
}: {
  mine: boolean;
  slot: number;
  jid: string;
  label: string;
}) {
  const [broken, setBroken] = useState(false);
  if (mine) {
    return <span className="comm-wa-av-ph comm-wa-bubble-av">{avatarLetter(label || 'Eu')}</span>;
  }
  if (!jid || broken) {
    return <span className="comm-wa-av-ph comm-wa-bubble-av">{avatarLetter(label)}</span>;
  }
  return (
    <img
      className="comm-wa-av comm-wa-bubble-av"
      src={`/api/community/wa/${slot}/avatar?jid=${encodeURIComponent(jid)}`}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setBroken(true)}
    />
  );
}

function needsCaption(file: File) {
  return (
    file.type.startsWith('image/') ||
    file.type.startsWith('video/') ||
    file.type.startsWith('application/') ||
    !file.type.startsWith('audio/')
  );
}

export function WaChatPane({ wa }: { wa: WaHubApi }) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [recording, setRecording] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [reactFor, setReactFor] = useState<string | null>(null);
  const [reactPos, setReactPos] = useState<{ top: number; left: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const lastMsgKey = wa.messages.length
    ? `${wa.messages[wa.messages.length - 1]?.id}:${wa.messages.length}`
    : `0:${wa.chatJid || ''}`;

  useEffect(() => {
    stickToBottomRef.current = true;
  }, [wa.chatJid]);

  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const el = scrollerRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
      return;
    }
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [lastMsgKey, wa.chatJid]);

  useEffect(() => {
    setRecording(false);
    setPendingFile(null);
    setReactFor(null);
  }, [wa.chatJid]);

  useEffect(() => {
    if (!reactFor) return;
    const close = (ev: MouseEvent) => {
      const t = ev.target as HTMLElement | null;
      if (t?.closest('.comm-wa-react-pop') || t?.closest('[data-wa-react-open]')) return;
      setReactFor(null);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [reactFor]);

  if (!wa.slot || !wa.unlocked) {
    return (
      <div className="comm-empty">
        <div className="comm-empty-card">
          <h1>WhatsApp</h1>
          <p>
            Conecte um número (até 2) com QR e senha local. Conversas e grupos ficam à esquerda.
            Histórico antigo do celular não é sincronizado.
          </p>
        </div>
      </div>
    );
  }

  if (!wa.chatJid) {
    return (
      <div className="comm-empty">
        <div className="comm-empty-card">
          <h1>WhatsApp</h1>
          <p>
            Conversas e grupos à esquerda. Nova conversa por número ou contatos. Histórico antigo não
            é sincronizado.
          </p>
        </div>
      </div>
    );
  }

  async function onSend(e: FormEvent) {
    e.preventDefault();
    if (!draft.trim() || sending || recording) return;
    setSending(true);
    try {
      const text = draft;
      setDraft('');
      await wa.sendText(text);
    } catch (err) {
      wa.setError(err instanceof Error ? err.message : 'Falha ao enviar');
      setDraft((d) => d || draft);
    } finally {
      setSending(false);
    }
  }

  function queueFile(file: File | null) {
    if (!file) return;
    if (needsCaption(file)) setPendingFile(file);
    else void sendMedia(file, '');
  }

  async function sendMedia(file: File, caption: string) {
    setSending(true);
    setPendingFile(null);
    try {
      await wa.sendFile(file, caption);
      setDraft('');
    } catch (err) {
      wa.setError(err instanceof Error ? err.message : 'Falha ao enviar mídia');
    } finally {
      setSending(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) queueFile(file);
  }

  return (
    <div
      className={`comm-chat comm-wa-chat${dragOver ? ' is-drop-target' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <header className="comm-main-head comm-wa-chat-head">
        <WaBubbleAvatar
          mine={false}
          slot={wa.slot}
          jid={wa.chatJid}
          label={wa.chatName || wa.chatJid}
        />
        <div className="comm-wa-chat-head-meta">
          <strong>{wa.chatName || wa.chatJid}</strong>
          {wa.isGroup ? <em className="muted">grupo</em> : <em className="muted">conversa</em>}
        </div>
      </header>

      <div
        className="comm-messages comm-wa-messages"
        ref={scrollerRef}
        onScroll={() => {
          const el = scrollerRef.current;
          if (!el) return;
          stickToBottomRef.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 96;
        }}
      >
        {wa.loadingMsgs ? (
          <p className="muted" style={{ padding: 12, alignSelf: 'center' }}>
            Carregando…
          </p>
        ) : null}
        {wa.messages.map((m) => {
          const text = msgText(m);
          const hasMedia = messageHasMedia(m);
          const who = senderLabel(m, wa.chatName, wa.isGroup);
          const avJid = m.fromMe
            ? ''
            : m.participant || m.participantAlt || m.chatJid || wa.chatJid || '';
          const isAudio =
            /audio|ptt|voice/i.test(String(m.type || '')) ||
            /audio/i.test(String(m.mediaType || ''));
          const typedOnly =
            !hasMedia &&
            ['contact', 'contact_array', 'location', 'live_location', 'poll', 'group_invite', 'event', 'revoke'].includes(
              String(m.type || '').toLowerCase(),
            );
          const chips = Array.isArray(m.reactions) ? m.reactions.filter((r) => r.emoji) : [];
          return (
            <div
              key={m.id}
              className={`comm-msg${m.fromMe ? ' is-mine' : ''}${hasMedia ? ' is-media' : ''}${
                isAudio ? ' is-audio' : ''
              }`}
              data-wa-id={m.id}
              data-wa-msg={m.id}
              data-wa-from-me={m.fromMe ? '1' : '0'}
            >
              <WaBubbleAvatar mine={!!m.fromMe} slot={wa.slot!} jid={avJid} label={who} />
              <div className="comm-msg-body">
                {wa.isGroup && !m.fromMe ? (
                  <strong className="comm-wa-bubble-name">{who}</strong>
                ) : null}
                {hasMedia ? (
                  <WaMessageMedia slot={wa.slot!} chatJid={wa.chatJid!} msg={m} />
                ) : null}
                {hasMedia && text ? <span className="comm-wa-bubble-text">{text}</span> : null}
                {!hasMedia ? <WaMessageContent msg={m} /> : null}
                {!text && !hasMedia && !typedOnly && !m.payloadDebug && !chips.length ? (
                  <span className="muted">[{m.type || 'msg'}]</span>
                ) : null}
                {chips.length ? (
                  <div className="comm-wa-reactions" aria-label="Reações">
                    {chips.map((r, i) => (
                      <span
                        key={`${r.emoji}-${r.participant || r.fromMe}-${i}`}
                        className={`comm-wa-reaction-chip${r.fromMe ? ' is-mine' : ''}`}
                        title={r.fromMe ? 'Você' : r.pushName || r.participant || 'Contato'}
                      >
                        {r.emoji}
                      </span>
                    ))}
                  </div>
                ) : null}
                <div className="comm-wa-msg-meta">
                  <time>{msgTs(m)}</time>
                  {m.fromMe && m.fromPhone ? (
                    <span className="comm-wa-from-phone" title="Enviado pelo celular">
                      celular
                    </span>
                  ) : null}
                  <Ticks m={m} />
                  {m.id && !String(m.id).startsWith('pending-') ? (
                    <button
                      type="button"
                      className="comm-icon-btn comm-wa-react-btn"
                      data-wa-react-open={m.id}
                      title="Reagir"
                      onClick={(e) => {
                        const rect = e.currentTarget.getBoundingClientRect();
                        setReactFor(m.id);
                        setReactPos({
                          left: Math.max(8, rect.left + rect.width / 2 - 120),
                          top: Math.max(8, rect.top - 52),
                        });
                      }}
                    >
                      <SmilePlus size={14} />
                    </button>
                  ) : null}
                </div>
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      <form
        className={`comm-compose comm-wa-compose${recording ? ' is-recording' : ''}`}
        onSubmit={(e) => void onSend(e)}
      >
        <input
          ref={fileRef}
          type="file"
          accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.zip"
          hidden
          onChange={(e) => queueFile(e.target.files?.[0] || null)}
        />
        <button
          type="button"
          className="comm-icon-btn"
          data-comm-wa-attach
          title="Anexar"
          disabled={sending || recording}
          onClick={() => fileRef.current?.click()}
        >
          <Paperclip size={18} />
        </button>
        <div className="comm-compose-input-wrap">
          <textarea
            name="body"
            maxLength={4000}
            rows={1}
            placeholder={dragOver ? 'Solte a mídia para enviar…' : 'Mensagem'}
            autoComplete="off"
            value={draft}
            disabled={recording}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
          />
        </div>
        <button
          type="button"
          className={`comm-icon-btn${recording ? ' is-recording' : ''}`}
          data-comm-wa-rec
          title="Gravar áudio"
          disabled={sending}
          onClick={() => setRecording(true)}
        >
          <Mic size={18} />
        </button>
        <button
          type="submit"
          className="btn btn-primary comm-wa-send"
          title="Enviar"
          disabled={sending || recording}
        >
          <Send size={16} />
        </button>
        <WaRecPanel
          active={recording}
          onCancel={() => setRecording(false)}
          onSend={async (file) => {
            setSending(true);
            try {
              await wa.sendFile(file, '', { ptt: true });
            } catch (err) {
              wa.setError(err instanceof Error ? err.message : 'Falha ao enviar áudio');
              throw err;
            } finally {
              setSending(false);
            }
          }}
        />
      </form>

      <WaCaptionModal
        file={pendingFile}
        onCancel={() => {
          setPendingFile(null);
          if (fileRef.current) fileRef.current.value = '';
        }}
        onSend={(caption) => {
          if (pendingFile) void sendMedia(pendingFile, caption);
        }}
      />

      {reactFor && reactPos ? (
        <div
          className="comm-wa-react-pop is-fixed"
          style={{ top: reactPos.top, left: reactPos.left }}
          role="dialog"
          aria-label="Escolher reação"
        >
          {WA_REACT_EMOJIS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              className="comm-wa-react-emoji"
              onClick={() => {
                const target = wa.messages.find((m) => m.id === reactFor);
                setReactFor(null);
                if (!target) return;
                void wa
                  .sendReaction(target.id, emoji, {
                    fromMe: !!target.fromMe,
                    participant: target.participant || '',
                    chatJid: wa.chatJid || undefined,
                  })
                  .catch((err) =>
                    wa.setError(err instanceof Error ? err.message : 'Falha ao reagir'),
                  );
              }}
            >
              {emoji}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
