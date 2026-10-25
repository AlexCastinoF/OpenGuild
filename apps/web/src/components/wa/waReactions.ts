import type { WaMessage, WaReactionChip } from './waTypes';

function reactorKey(r: WaReactionChip) {
  if (r.fromMe) return 'me';
  return String(r.participant || r.pushName || 'peer');
}

function messageTimeMs(m: WaMessage) {
  return Number(m.timestampMs || 0) || Number(m.timestampSeconds || 0) * 1000;
}

/** Aplica/atualiza/remove reação de um reactor na mensagem. */
export function applyReactionChip(
  msg: WaMessage,
  chip: WaReactionChip,
): WaMessage {
  const prev = Array.isArray(msg.reactions) ? msg.reactions : [];
  const key = reactorKey(chip);
  const without = prev.filter((r) => reactorKey(r) !== key);
  if (!chip.emoji) return { ...msg, reactions: without };
  return { ...msg, reactions: [...without, chip] };
}

/**
 * Quando a mensagem-alvo não veio no histórico desta sessão (ex.: enviada noutro
 * dispositivo/painel), cria um stub mínimo para o chip ❤️ aparecer na conversa.
 */
export function ensureReactionParent(
  messages: WaMessage[],
  targetId: string,
  opts?: {
    chatJid?: string;
    fromMe?: boolean;
    timestampMs?: number;
  },
): WaMessage[] {
  const tid = String(targetId || '').trim();
  if (!tid) return messages;
  if (messages.some((m) => m.id === tid)) return messages;
  const ts = Number(opts?.timestampMs || Date.now());
  const stub: WaMessage = {
    id: tid,
    chatJid: opts?.chatJid || '',
    fromMe: opts?.fromMe !== false,
    type: 'text',
    text: '',
    timestampMs: ts,
    timestampSeconds: Math.floor(ts / 1000),
    reactions: [],
  };
  return [...messages, stub];
}

/**
 * Reações não são bolhas: fold nas mensagens-alvo e remove type=reaction da lista.
 */
export function foldReactionsIntoMessages(messages: WaMessage[]): WaMessage[] {
  const reactions: WaMessage[] = [];
  const others: WaMessage[] = [];
  for (const m of messages) {
    if (String(m.type || '').toLowerCase() === 'reaction') reactions.push(m);
    else others.push(m);
  }
  const byId = new Map<string, WaMessage>(
    others.map((m) => [m.id, { ...m, reactions: [...(m.reactions || [])] }]),
  );
  for (const r of reactions) {
    const tid = String(r.reaction?.targetId || '').trim();
    if (!tid) continue;
    let parent = byId.get(tid);
    if (!parent) {
      // Reação inbound costuma mirar mensagem nossa; key.fromMe no LID às vezes vem invertido.
      const stubFromMe = r.fromMe ? !!r.reaction?.targetFromMe : true;
      const ts = Math.max(0, messageTimeMs(r) - 1000) || Date.now() - 1000;
      parent = {
        id: tid,
        chatJid: r.chatJid || '',
        fromMe: stubFromMe,
        type: 'text',
        text: '',
        timestampMs: ts,
        timestampSeconds: Math.floor(ts / 1000),
        reactions: [],
      };
      byId.set(tid, parent);
    }
    byId.set(
      tid,
      applyReactionChip(parent, {
        emoji: String(r.reaction?.text || r.text || '').trim(),
        fromMe: !!r.fromMe,
        participant: r.participant || '',
        pushName: r.pushName || '',
      }),
    );
  }
  return [...byId.values()].sort((a, b) => {
    const am = messageTimeMs(a);
    const bm = messageTimeMs(b);
    if (am !== bm) return am - bm;
    return String(a.id || '').localeCompare(String(b.id || ''));
  });
}

export const WA_REACT_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏', '🔥', '👏'] as const;
