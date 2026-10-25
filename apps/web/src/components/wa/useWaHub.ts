import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../lib/api';
import {
  chatIsGroup,
  cryptoRememberKey,
  isNoiseChatJid,
  lastMessagePreview,
  lastMessageTs,
} from './waCrypto';
import { putWaMediaCache } from './waMediaCache';
import type { WaChat, WaMessage, WaReactionChip, WaSlot, WaStatusFeed, WaTab } from './waTypes';
import {
  applyReactionChip,
  ensureReactionParent,
  foldReactionsIntoMessages,
} from './waReactions';
import { sameWaChat } from './waJid';

const WA_HUB_STATE_KEY = 'sf-wa-hub-state';

const ACK_RANK: Record<string, number> = {
  sent: 1,
  server: 1,
  delivered: 2,
  read: 3,
  played: 3,
};

function preferAck(a?: string, b?: string) {
  const ar = ACK_RANK[String(a || '').toLowerCase()] || 0;
  const br = ACK_RANK[String(b || '').toLowerCase()] || 0;
  return ar >= br ? a || b || '' : b || a || '';
}

function isBubbleNoise(msg: WaMessage | null | undefined) {
  const t = String(msg?.type || '').toLowerCase();
  if (t === 'skdm' || t === 'protocol' || t === 'poll_update' || t === 'senderkeydistribution') {
    return true;
  }
  // Dump antigo: senderKeyDistributionMessage sem texto útil
  const dbg = String(msg?.payloadDebug || '');
  if (dbg.includes('senderKeyDistributionMessage') && !String(msg?.text || '').trim()) {
    return true;
  }
  return false;
}

function upsertMessage(list: WaMessage[], msg: WaMessage): WaMessage[] {
  if (!msg?.id || isBubbleNoise(msg)) return list;
  if (String(msg.type || '').toLowerCase() === 'reaction') {
    return foldReactionsIntoMessages([...list, msg]);
  }
  const prev = list.find((m) => m.id === msg.id);
  const merged: WaMessage = {
    ...prev,
    ...msg,
    ackStatus: preferAck(prev?.ackStatus, msg.ackStatus) || msg.ackStatus || prev?.ackStatus,
    reactions: msg.reactions?.length ? msg.reactions : prev?.reactions,
  };
  const without = list.filter((m) => m.id !== msg.id);
  return foldReactionsIntoMessages([...without, merged]);
}

function mergeAckFromPrev(next: WaMessage[], prev: WaMessage[]): WaMessage[] {
  if (!prev.length) return next;
  const byId = new Map(prev.map((m) => [m.id, m]));
  return next.map((m) => {
    const old = byId.get(m.id);
    if (!old?.ackStatus) return m;
    return { ...m, ackStatus: preferAck(m.ackStatus, old.ackStatus) || m.ackStatus };
  });
}

export function useWaHub(active: boolean) {
  const [slots, setSlots] = useState<WaSlot[]>([]);
  const [slot, setSlot] = useState<number | null>(null);
  const [tab, setTab] = useState<WaTab>('dm');
  const [chats, setChats] = useState<WaChat[]>([]);
  const [statuses, setStatuses] = useState<WaStatusFeed[]>([]);
  const [archived, setArchived] = useState<Set<string>>(() => new Set());
  const [showArchived, setShowArchived] = useState(false);
  const [chatJid, setChatJid] = useState<string | null>(null);
  const [chatPhone, setChatPhone] = useState('');
  const [chatName, setChatName] = useState('');
  const [isGroup, setIsGroup] = useState(false);
  const [messages, setMessages] = useState<WaMessage[]>([]);
  const [unlocked, setUnlocked] = useState(false);
  const [search, setSearch] = useState('');
  const [badge, setBadge] = useState(0);
  const [loadingChats, setLoadingChats] = useState(false);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [loadingStatuses, setLoadingStatuses] = useState(false);
  const [error, setError] = useState('');

  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardSlot, setWizardSlot] = useState(1);
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [unlockSlot, setUnlockSlot] = useState<WaSlot | null>(null);
  const [qrOpen, setQrOpen] = useState(false);
  const [qrPng, setQrPng] = useState('');
  const [qrStatus, setQrStatus] = useState('');
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [statusPostOpen, setStatusPostOpen] = useState(false);

  const esRef = useRef<EventSource | null>(null);
  const chatJidRef = useRef(chatJid);
  chatJidRef.current = chatJid;
  const chatPhoneRef = useRef(chatPhone);
  chatPhoneRef.current = chatPhone;
  const chatsDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [maisOpen, setMaisOpen] = useState(false);

  const currentSlot = slots.find((s) => s.slot === slot) || null;

  const refreshSlots = useCallback(async () => {
    const data = await api<{ slots: WaSlot[] }>('/api/community/wa/slots');
    setSlots(data.slots || []);
    const openCount = (data.slots || []).filter((s) => s.status === 'open').length;
    setBadge(openCount);
    return data.slots || [];
  }, []);

  const stopEvents = useCallback(() => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
  }, []);

  const syncArchived = useCallback(async (slotNum: number) => {
    try {
      const data = await api<{ archived?: string[] }>(
        `/api/community/wa/${slotNum}/archived-groups`,
      );
      setArchived(new Set(Array.isArray(data.archived) ? data.archived : []));
    } catch {
      /* keep previous */
    }
  }, []);

  const loadChats = useCallback(async (slotNum: number) => {
    setLoadingChats(true);
    setError('');
    try {
      const data = await api<{ chats?: WaChat[] }>(`/api/community/wa/${slotNum}/chats`);
      const list = Array.isArray(data.chats) ? data.chats : [];
      setChats(
        list.map((c) => ({
          ...c,
          isGroup: chatIsGroup(c),
        })),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro ao listar chats');
      setChats([]);
    } finally {
      setLoadingChats(false);
    }
  }, []);

  const loadStatuses = useCallback(async (slotNum: number) => {
    setLoadingStatuses(true);
    try {
      const data = await api<{ statuses?: WaStatusFeed[] }>(
        `/api/community/wa/${slotNum}/statuses`,
      );
      setStatuses(Array.isArray(data.statuses) ? data.statuses : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro ao listar status');
      setStatuses([]);
    } finally {
      setLoadingStatuses(false);
    }
  }, []);

  const loadMessages = useCallback(
    async (slotNum: number, jid: string, opts?: { soft?: boolean }) => {
      if (!opts?.soft) setLoadingMsgs(true);
      try {
        const data = await api<{ messages?: WaMessage[] }>(
          `/api/community/wa/${slotNum}/messages?chatJid=${encodeURIComponent(jid)}&limit=80`,
        );
        const folded = foldReactionsIntoMessages(
          (Array.isArray(data.messages) ? data.messages : []).filter((m) => !isBubbleNoise(m)),
        );
        setMessages((prev) => mergeAckFromPrev(folded, prev));
        void api(`/api/community/wa/${slotNum}/read`, {
          method: 'POST',
          body: JSON.stringify({ chatJid: jid }),
        }).catch(() => undefined);
      } catch (e) {
        if (!opts?.soft) {
          setError(e instanceof Error ? e.message : 'Erro ao carregar mensagens');
          setMessages([]);
        }
      } finally {
        if (!opts?.soft) setLoadingMsgs(false);
      }
    },
    [],
  );

  const startEvents = useCallback(
    (slotNum: number) => {
      stopEvents();
      const es = new EventSource(`/api/community/wa/${slotNum}/events`, {
        withCredentials: true,
      });
      esRef.current = es;
      es.onmessage = (ev) => {
        try {
          const payload = JSON.parse(ev.data || '{}') as {
            event?: string;
            data?: WaMessage & {
              chatJid?: string;
              chatJidAlt?: string;
              status?: string;
              targetId?: string;
              emoji?: string;
              fromMe?: boolean;
              participant?: string;
              pushName?: string;
              id?: string;
            };
          };
          const kind = payload.event || '';
          const openJid = chatJidRef.current;
          const openPhone = chatPhoneRef.current;

          const eventMatchesOpen = (jid?: string, alt?: string) =>
            !!openJid &&
            sameWaChat(openJid, jid, { openPhone, eventAlt: alt });

          if (kind === 'reaction') {
            const d = (payload.data ?? {}) as {
              targetId?: string;
              chatJid?: string;
              chatJidAlt?: string;
              emoji?: string;
              fromMe?: boolean;
              participant?: string;
              pushName?: string;
            };
            const tid = String(d.targetId || '').trim();
            const cj = String(d.chatJid || '');
            if (tid && eventMatchesOpen(cj, d.chatJidAlt)) {
              const chip: WaReactionChip = {
                emoji: String(d.emoji || ''),
                fromMe: !!d.fromMe,
                participant: d.participant || '',
                pushName: d.pushName || '',
              };
              setMessages((prev) => {
                const withParent = ensureReactionParent(prev, tid, {
                  chatJid: openJid || cj,
                  fromMe: !d.fromMe,
                  timestampMs: Date.now() - 1000,
                });
                return withParent.map((m) =>
                  m.id === tid ? applyReactionChip(m, chip) : m,
                );
              });
              if (chatsDebounceRef.current) clearTimeout(chatsDebounceRef.current);
              chatsDebounceRef.current = setTimeout(() => {
                void loadChats(slotNum);
              }, 900);
            }
            return;
          }
          if (kind === 'receipt') {
            const updates = (payload.data as { updates?: { id?: string; ackStatus?: string }[] })
              ?.updates;
            if (Array.isArray(updates) && updates.length) {
              const byId = new Map(
                updates
                  .filter((u) => u.id && u.ackStatus)
                  .map((u) => [String(u.id), String(u.ackStatus)]),
              );
              if (byId.size) {
                setMessages((prev) =>
                  prev.map((m) => {
                    const next = byId.get(m.id);
                    if (!next || !m.fromMe) return m;
                    return { ...m, ackStatus: preferAck(m.ackStatus, next) || next };
                  }),
                );
              }
            }
            return;
          }
          if (
            kind === 'message' ||
            kind === 'messages.upsert' ||
            kind === 'chats.update' ||
            kind === 'chat'
          ) {
            if (chatsDebounceRef.current) clearTimeout(chatsDebounceRef.current);
            chatsDebounceRef.current = setTimeout(() => {
              void loadChats(slotNum);
            }, 900);
            const d = payload.data;
            if (
              d &&
              eventMatchesOpen(d.chatJid, d.chatJidAlt) &&
              d.id &&
              kind === 'message'
            ) {
              setMessages((prev) => upsertMessage(prev, d as WaMessage));
            } else if (d && eventMatchesOpen(d.chatJid, d.chatJidAlt) && openJid) {
              void loadMessages(slotNum, openJid, { soft: true });
            }
          }
          if (kind === 'status' || kind === 'statuses') {
            void loadStatuses(slotNum);
          }
          // Zapo pairing: auth_qr → scan → auth_paired → connection open
          if (
            kind === 'auth_qr' ||
            kind === 'auth_paired' ||
            kind === 'connection' ||
            kind === 'qr'
          ) {
            const d = (payload.data || {}) as {
              qrPng?: string;
              status?: string;
              error?: string;
            };
            if (d.qrPng) {
              setQrPng((prev) => (prev === d.qrPng ? prev : d.qrPng!));
              setQrStatus('Escaneie o QR no celular');
            }
            if (kind === 'auth_paired' || d.status === 'open') {
              setQrStatus('Conectado!');
              setQrOpen(false);
              void refreshSlots();
              void loadChats(slotNum);
              return;
            }
            void refreshSlots().then((list) => {
              const s = list.find((x) => x.slot === slotNum);
              if (s?.status === 'open') {
                setQrStatus('Conectado!');
                setQrOpen(false);
                void loadChats(slotNum);
              } else if (s?.qrPng) {
                setQrPng((prev) => (prev === s.qrPng ? prev : s.qrPng!));
                setQrStatus('Escaneie o QR no celular');
              } else if (s?.error || d.error) {
                setQrStatus(s?.error || d.error || 'Erro na conexão');
              }
            });
          }
        } catch {
          /* ignore */
        }
      };
      es.onerror = () => {
        /* browser reconnects */
      };
    },
    [loadChats, loadMessages, loadStatuses, refreshSlots, stopEvents],
  );

  const tryUnlock = useCallback(async (s: WaSlot): Promise<boolean> => {
    if (!s.has_crypto) {
      setUnlocked(true);
      return true;
    }
    const remembered = localStorage.getItem(cryptoRememberKey(s.session_id));
    if (remembered) {
      try {
        await api(`/api/community/wa/${s.slot}/crypto/unlock`, {
          method: 'POST',
          body: JSON.stringify({ verifier: remembered }),
        });
        setUnlocked(true);
        return true;
      } catch {
        localStorage.removeItem(cryptoRememberKey(s.session_id));
      }
    }
    setUnlockSlot(s);
    setUnlockOpen(true);
    return false;
  }, []);

  const showQr = useCallback(
    async (slotNum: number) => {
      setQrOpen(true);
      setQrPng('');
      setQrStatus('Gerando QR…');
      // SSE precisa estar ativo antes/durante o pair (auth_qr / auth_paired)
      startEvents(slotNum);
      try {
        await api(`/api/community/wa/slots`, {
          method: 'POST',
          body: JSON.stringify({ slot: slotNum }),
        });
        const data = await api<WaSlot & { ok?: boolean }>(`/api/community/wa/${slotNum}/pair`, {
          method: 'POST',
          body: '{}',
        });
        if (data.status === 'open') {
          setQrStatus('Conectado!');
          setQrOpen(false);
          void loadChats(slotNum);
        } else if (data.qrPng) {
          setQrPng(data.qrPng);
          setQrStatus('Escaneie o QR no celular');
        } else {
          setQrStatus(data.error || data.status || 'Aguardando QR…');
        }
        void refreshSlots();
      } catch (e) {
        setQrStatus(e instanceof Error ? e.message : 'Falha ao gerar QR');
      }
    },
    [loadChats, refreshSlots, startEvents],
  );

  const selectSlot = useCallback(
    async (slotNum: number, keepUi = false) => {
      setSlot(slotNum);
      if (!keepUi) {
        setChatJid(null);
        setChatPhone('');
        setChatName('');
        setMessages([]);
        setShowArchived(false);
      }
      setUnlocked(false);
      let list = slots;
      if (!list.find((s) => s.slot === slotNum)) {
        list = await refreshSlots();
      }
      const s = list.find((x) => x.slot === slotNum);
      if (!s) {
        setWizardSlot(slotNum);
        setWizardOpen(true);
        return;
      }
      const ok = await tryUnlock(s);
      if (!ok) return;
      startEvents(slotNum);
      if (s.status !== 'open') {
        await showQr(slotNum);
      }
      await syncArchived(slotNum);
      await loadChats(slotNum);
    },
    [loadChats, refreshSlots, showQr, slots, startEvents, syncArchived, tryUnlock],
  );

  const openChat = useCallback(
    async (jid: string, name: string, group: boolean, phone = '') => {
      if (!slot) return;
      setTab(group ? 'group' : 'dm');
      setChatJid(jid);
      setChatPhone(String(phone || '').replace(/\D/g, ''));
      setChatName(name);
      setIsGroup(group);
      await loadMessages(slot, jid);
    },
    [loadMessages, slot],
  );

  const sendText = useCallback(
    async (text: string) => {
      if (!slot || !chatJid || !text.trim()) return;
      const data = await api<{ message?: WaMessage; ok?: boolean }>(
        `/api/community/wa/${slot}/send`,
        {
          method: 'POST',
          body: JSON.stringify({ chatJid, text: text.trim() }),
        },
      );
      if (data.message?.id) {
        setMessages((prev) => upsertMessage(prev, { ...data.message!, fromMe: true }));
      } else {
        await loadMessages(slot, chatJid, { soft: true });
      }
      await loadChats(slot);
    },
    [chatJid, loadChats, loadMessages, slot],
  );

  const sendReaction = useCallback(
    async (
      messageId: string,
      emoji: string,
      opts: { fromMe: boolean; participant?: string; chatJid?: string },
    ) => {
      if (!slot) throw new Error('Sem sessão');
      const jid = opts.chatJid || chatJid;
      if (!jid || !messageId) throw new Error('Mensagem inválida');
      const chip: WaReactionChip = {
        emoji,
        fromMe: true,
        participant: '',
        pushName: 'Você',
      };
      setMessages((prev) =>
        prev.map((m) => (m.id === messageId ? applyReactionChip(m, chip) : m)),
      );
      await api(`/api/community/wa/${slot}/send`, {
        method: 'POST',
        body: JSON.stringify({
          jid,
          chatJid: jid,
          type: 'reaction',
          emoji,
          target: {
            remoteJid: jid,
            id: messageId,
            fromMe: !!opts.fromMe,
            participant: opts.participant || undefined,
          },
        }),
      });
    },
    [chatJid, slot],
  );

  const sendFile = useCallback(
    async (file: File, caption = '', opts?: { ptt?: boolean }) => {
      if (!slot || !chatJid) throw new Error('Selecione uma conversa');
      const ptt = !!opts?.ptt;
      let type = 'document';
      if (ptt || file.type.startsWith('audio/')) type = 'audio';
      else if (file.type.startsWith('image/')) type = 'image';
      else if (file.type.startsWith('video/')) type = 'video';

      const uploadName = ptt ? 'voice.ogg' : file.name || 'media.bin';
      // WhatsApp PTT: OGG/Opus. Browser grava webm; gateway normaliza com ffmpeg (normalizeVoiceNote).
      const mime =
        ptt && (!file.type || file.type.includes('webm'))
          ? 'audio/ogg; codecs=opus'
          : file.type || 'application/octet-stream';

      const fd = new FormData();
      fd.append('jid', chatJid);
      fd.append('chatJid', chatJid);
      fd.append('type', type);
      fd.append('mimetype', mime);
      fd.append('caption', caption || '');
      fd.append('fileName', uploadName);
      if (ptt) fd.append('ptt', 'true');
      const upload =
        ptt && file.type !== mime
          ? new File([file], uploadName, { type: mime })
          : file;
      fd.append('media', upload, uploadName);

      const res = await fetch(`/api/community/wa/${slot}/send`, {
        method: 'POST',
        credentials: 'include',
        body: fd,
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        message?: { id?: string; chatJid?: string };
      };
      if (!res.ok || data.ok === false) throw new Error(data.error || 'send_failed');
      if (data.message?.id) {
        const mid = data.message.id;
        // Sempre cachear com o chatJid aberto (mesmo JID da UI) — evita miss por LID↔PN
        const mediaUrl = `/api/community/wa/${slot}/media?messageId=${encodeURIComponent(mid)}&chatJid=${encodeURIComponent(chatJid)}`;
        await putWaMediaCache(mediaUrl, file);
        const optimistic: WaMessage = {
          ...(data.message as WaMessage),
          id: mid,
          chatJid,
          fromMe: true,
          type: ptt ? 'ptt' : type,
          hasMedia: true,
          text: caption || '',
          fileName: uploadName,
          mimetype: mime,
          timestampSeconds: Math.floor(Date.now() / 1000),
          timestampMs: Date.now(),
          ackStatus: 'sent',
        };
        setMessages((prev) => {
          if (prev.some((m) => m.id === mid)) return prev;
          return [...prev, optimistic];
        });
      }
      await loadMessages(slot, chatJid, { soft: true });
      await loadChats(slot);
      return data;
    },
    [chatJid, loadChats, loadMessages, slot],
  );

  const postStatus = useCallback(
    async (text: string) => {
      if (!slot || !text.trim()) return;
      await api(`/api/community/wa/${slot}/statuses`, {
        method: 'POST',
        body: JSON.stringify({ text: text.trim() }),
      });
      await loadStatuses(slot);
    },
    [loadStatuses, slot],
  );

  const toggleArchive = useCallback(
    async (jid: string, archive: boolean) => {
      if (!slot) return;
      const data = await api<{ archived?: string[] }>(
        `/api/community/wa/${slot}/archived-groups`,
        {
          method: 'POST',
          body: JSON.stringify({ jid, archived: archive }),
        },
      );
      setArchived(new Set(Array.isArray(data.archived) ? data.archived : []));
    },
    [slot],
  );

  const logoutSlot = useCallback(
    async (slotNum: number) => {
      const s = slots.find((x) => x.slot === slotNum);
      if (s?.session_id) localStorage.removeItem(cryptoRememberKey(s.session_id));
      await api(`/api/community/wa/${slotNum}/logout`, { method: 'POST', body: '{}' });
      stopEvents();
      setChatJid(null);
      setChatPhone('');
      setMessages([]);
      setChats([]);
      setStatuses([]);
      const list = await refreshSlots();
      if (slot === slotNum) {
        setSlot(list[0]?.slot ?? null);
        if (list[0]) void selectSlot(list[0].slot);
        else setUnlocked(false);
      }
    },
    [refreshSlots, selectSlot, slot, slots, stopEvents],
  );

  const addSlot = useCallback(async () => {
    const used = new Set(slots.map((s) => s.slot));
    const next = ([1, 2] as const).find((n) => !used.has(n));
    if (!next) {
      setError('Limite de 2 WhatsApps atingido.');
      return;
    }
    setWizardSlot(next);
    setWizardOpen(true);
  }, [slots]);

  const clearChatsPanel = useCallback(async () => {
    if (!slot) return;
    if (!confirm('Limpar conversas do painel (não apaga no celular)?')) return;
    try {
      await api(`/api/community/wa/${slot}/clear-chats`, {
        method: 'POST',
        body: JSON.stringify({ deleteChats: false }),
      });
    } catch {
      /* ignore */
    }
    setChats([]);
    setChatJid(null);
    setChatPhone('');
    setMessages([]);
    await loadChats(slot);
  }, [loadChats, slot]);

  useEffect(() => {
    if (tab === 'status' && slot && unlocked) {
      void loadStatuses(slot);
    }
  }, [tab, slot, unlocked, loadStatuses]);

  // Enquanto o QR estiver aberto, poll status (fallback se SSE atrasar)
  useEffect(() => {
    if (!qrOpen) return;
    const slotNum = slot || wizardSlot;
    if (!slotNum) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const st = await api<WaSlot>(`/api/community/wa/${slotNum}/status`);
        if (cancelled) return;
        if (st.qrPng) {
          setQrPng((prev) => (prev === st.qrPng ? prev : st.qrPng!));
          setQrStatus((prev) => (prev === 'Escaneie o QR no celular' ? prev : 'Escaneie o QR no celular'));
        }
        if (st.status === 'open') {
          setQrStatus('Conectado!');
          setQrOpen(false);
          void refreshSlots();
          void loadChats(slotNum);
        } else if (st.error && st.status !== 'qr' && st.status !== 'connecting') {
          setQrStatus(st.error);
        }
      } catch {
        /* ignore */
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), 2000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [qrOpen, slot, wizardSlot, refreshSlots, loadChats]);

  useEffect(() => {
    if (!active) {
      stopEvents();
      return;
    }
    let cancelled = false;
    void (async () => {
      const list = await refreshSlots();
      if (cancelled) return;
      type HubState = {
        slot?: number;
        chatJid?: string;
        chatPhone?: string;
        chatName?: string;
        isGroup?: boolean;
        tab?: string;
      };
      let restored: HubState | null = null;
      try {
        const raw = sessionStorage.getItem(WA_HUB_STATE_KEY);
        if (raw) restored = JSON.parse(raw) as HubState;
      } catch {
        /* ignore */
      }
      const pick = restored?.slot || list.find((s) => s.status === 'open')?.slot || list[0]?.slot;
      if (pick) {
        await selectSlot(pick, Boolean(restored?.chatJid));
        if (restored?.tab === 'group' || restored?.tab === 'dm' || restored?.tab === 'status') {
          setTab(restored.tab);
        }
        if (restored?.chatJid) {
          await openChat(
            restored.chatJid,
            restored.chatName || restored.chatJid,
            !!restored.isGroup,
            restored.chatPhone || '',
          );
        }
      }
    })();
    return () => {
      cancelled = true;
      stopEvents();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  useEffect(() => {
    if (!active || !slot) {
      sessionStorage.removeItem(WA_HUB_STATE_KEY);
      return;
    }
    sessionStorage.setItem(
      WA_HUB_STATE_KEY,
      JSON.stringify({
        slot,
        chatJid: chatJid || '',
        chatPhone,
        chatName,
        isGroup,
        tab,
      }),
    );
  }, [active, slot, chatJid, chatPhone, chatName, isGroup, tab]);

  const filteredChats = useMemo(() => {
    const q = search.trim().toLowerCase();
    return chats
      .filter((c) => {
        const jid = String(c.jid || '');
        if (isNoiseChatJid(jid)) return false;
        const group = chatIsGroup(c);
        if (tab === 'group') {
          if (!group) return false;
          const isArch = archived.has(jid);
          if (showArchived) {
            if (!isArch) return false;
          } else if (isArch) {
            return false;
          }
        } else if (tab === 'dm') {
          if (group) return false;
        } else {
          return false;
        }
        if (q) {
          const hay = [
            c.name,
            c.subject,
            c.contactName,
            c.pushName,
            c.phone,
            c.phoneDisplay,
            c.jid,
            lastMessagePreview(c),
          ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => {
        const ap = Number(a.pinned || 0);
        const bp = Number(b.pinned || 0);
        if (ap !== bp) return bp - ap;
        const at = lastMessageTs(a);
        const bt = lastMessageTs(b);
        if (at !== bt) return bt - at;
        return String(a.jid || '').localeCompare(String(b.jid || ''));
      });
  }, [archived, chats, search, showArchived, tab]);

  const archivedGroupCount = useMemo(
    () => chats.filter((c) => chatIsGroup(c) && archived.has(String(c.jid || ''))).length,
    [archived, chats],
  );

  return {
    slots,
    slot,
    currentSlot,
    tab,
    setTab,
    chats: filteredChats,
    allChats: chats,
    statuses,
    archived,
    showArchived,
    setShowArchived,
    archivedGroupCount,
    chatJid,
    chatName,
    isGroup,
    messages,
    unlocked,
    search,
    setSearch,
    badge,
    loadingChats,
    loadingMsgs,
    loadingStatuses,
    error,
    setError,
    wizardOpen,
    setWizardOpen,
    wizardSlot,
    unlockOpen,
    setUnlockOpen,
    unlockSlot,
    qrOpen,
    setQrOpen,
    qrPng,
    qrStatus,
    newChatOpen,
    setNewChatOpen,
    statusPostOpen,
    setStatusPostOpen,
    maisOpen,
    setMaisOpen,
    refreshSlots,
    selectSlot,
    openChat,
    sendText,
    sendReaction,
    sendFile,
    postStatus,
    toggleArchive,
    logoutSlot,
    addSlot,
    clearChatsPanel,
    showQr,
    loadChats,
    loadStatuses,
    startEvents,
    setUnlocked,
    setSlot,
    setChatJid,
    setChatName,
    setIsGroup,
  };
}

export type WaHubApi = ReturnType<typeof useWaHub>;
