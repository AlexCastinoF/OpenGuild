import type { CSSProperties } from 'react';

type Props = {
  label: string;
  level: number;
  hasTrack: boolean;
  direction: 'in' | 'out';
  title?: string;
};

/** Medidor visual de sinal (0–1) — não depende de ouvir. */
export function AudioSignalMeter({ label, level, hasTrack, direction, title }: Props) {
  const pct = hasTrack ? Math.max(0, Math.min(100, Math.round(level * 100))) : 0;
  const live = hasTrack && level >= 0.03;
  const soft = hasTrack && level >= 0.012 && level < 0.03;
  const arrow = direction === 'out' ? '↑' : '↓';
  const status = !hasTrack ? 'sem track' : live ? 'sinal' : soft ? 'baixo' : 'silêncio';

  return (
    <div
      className={`comm-audio-meter${live ? ' is-live' : ''}${soft ? ' is-soft' : ''}${!hasTrack ? ' is-missing' : ''}`}
      title={title || `${label}: ${status} (${pct}%)`}
      role="meter"
      aria-label={`${label} ${direction === 'out' ? 'enviando' : 'recebendo'}`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
    >
      <span className="comm-audio-meter-label">
        <em aria-hidden>{arrow}</em>
        {label}
      </span>
      <span className="comm-audio-meter-bar" aria-hidden>
        <span
          className="comm-audio-meter-fill"
          style={{ '--lvl': `${pct}%` } as CSSProperties}
        />
      </span>
      <span className={`comm-audio-meter-dot${live ? ' is-on' : ''}`} aria-hidden />
    </div>
  );
}
