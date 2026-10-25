import { useEffect, useState } from 'react';

/** Formata segundos decorridos como 00:00:00 */
export function formatElapsedHms(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

/** Contador vivo a partir de timestamp unix (segundos). */
export function useElapsedSince(sinceUnix: number | null | undefined): string {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    if (!sinceUnix || sinceUnix <= 0) return;
    const id = window.setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => window.clearInterval(id);
  }, [sinceUnix]);
  if (!sinceUnix || sinceUnix <= 0) return '';
  return formatElapsedHms(now - sinceUnix);
}

export function StatusElapsed({ since }: { since?: number | null }) {
  const label = useElapsedSince(since);
  if (!label) return null;
  return <em className="comm-work-status-timer">{label}</em>;
}
