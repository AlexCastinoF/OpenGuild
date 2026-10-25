import { useEffect, useRef, useState } from 'react';

const MAX_COUNTDOWN_MS = 15_000;

/**
 * Contagem sincronizada com o servidor (evita 200s+ quando o relógio do cliente está atrasado).
 * Usa `endsAt - serverNow` no momento do payload e depois só o relógio local para o tick.
 */
export function useSyncedCountdown(endsAt?: number | null, serverNow?: number | null) {
  const [left, setLeft] = useState(0);
  const session = useRef<{ key: number; startedAt: number; durationMs: number } | null>(null);

  useEffect(() => {
    const end = typeof endsAt === 'number' && endsAt > 0 ? endsAt : 0;
    if (!end) {
      session.current = null;
      setLeft(0);
      return;
    }

    if (!session.current || session.current.key !== end) {
      const base =
        typeof serverNow === 'number' && serverNow > 1_000_000_000_000 ? serverNow : Date.now();
      let durationMs = end - base;
      if (!Number.isFinite(durationMs) || durationMs < 0) durationMs = 0;
      if (durationMs > MAX_COUNTDOWN_MS) {
        // Relógio do cliente / payload estranho — assume 10s a partir de agora
        durationMs = 10_000;
      }
      session.current = { key: end, startedAt: Date.now(), durationMs };
    }

    const tick = () => {
      const s = session.current;
      if (!s) {
        setLeft(0);
        return;
      }
      const rem = Math.max(0, Math.ceil((s.durationMs - (Date.now() - s.startedAt)) / 1000));
      setLeft(rem);
    };
    tick();
    const id = window.setInterval(tick, 200);
    return () => window.clearInterval(id);
  }, [endsAt, serverNow]);

  return left;
}
