import React, { useState } from 'react';
import { Users, Clock } from 'lucide-react';

interface RallyCardProps {
  id?: string;
  title?: string;
  time?: string;
  confirmedCount?: number;
  maxCount?: number;
  initialStatus?: 'in' | 'maybe' | 'out' | null;
  onJoin?: () => void;
  onMaybe?: () => void;
  onLeave?: () => void;
}

export function RallyCard({
  title = 'Convocação para Partida CS2 (Mirage / Premier)',
  time = '20:30',
  confirmedCount = 3,
  maxCount = 5,
  initialStatus = null,
  onJoin,
  onMaybe,
  onLeave,
}: RallyCardProps) {
  const [status, setStatus] = useState<'in' | 'maybe' | 'out' | null>(initialStatus);
  const [currentCount, setCurrentCount] = useState(confirmedCount);

  const handleJoin = () => {
    if (status !== 'in') {
      setCurrentCount((c) => Math.min(c + 1, maxCount));
    }
    setStatus('in');
    onJoin?.();
  };

  const handleMaybe = () => {
    if (status === 'in') {
      setCurrentCount((c) => Math.max(c - 1, 0));
    }
    setStatus('maybe');
    onMaybe?.();
  };

  const handleOut = () => {
    if (status === 'in') {
      setCurrentCount((c) => Math.max(c - 1, 0));
    }
    setStatus('out');
    onLeave?.();
  };

  return (
    <div className="comm-rally-card" role="region" aria-label="Convocação de Partida Rally">
      <div className="comm-rally-header">
        <span className="comm-rally-badge">
          RALLY · {time}
        </span>
        <span className="comm-rally-confirmed">
          <Users size={14} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 4 }} />
          {currentCount} de {maxCount} confirmados
        </span>
      </div>

      <h4 className="comm-rally-title">{title}</h4>

      <div className="comm-rally-actions">
        <button
          type="button"
          className={`comm-rally-btn-in ${status === 'in' ? 'is-selected' : ''}`}
          onClick={handleJoin}
          aria-pressed={status === 'in'}
        >
          {status === 'in' ? 'Confirmado ✓' : 'Entrar'}
        </button>
        <button
          type="button"
          className={`comm-rally-btn-maybe ${status === 'maybe' ? 'is-selected' : ''}`}
          onClick={handleMaybe}
          aria-pressed={status === 'maybe'}
        >
          Talvez
        </button>
        <button
          type="button"
          className={`comm-rally-btn-out ${status === 'out' ? 'is-selected' : ''}`}
          onClick={handleOut}
          aria-pressed={status === 'out'}
        >
          Fora
        </button>
      </div>
    </div>
  );
}
