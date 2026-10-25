import { useState } from 'react';
import type { KillSoundEventKey, KillSoundIntensity, KillSoundsSettings } from '../lib/killSounds';
import {
  defaultKillSoundsSettings,
  KILL_SOUND_CATALOG,
  KILL_SOUND_EVENT_LABELS,
  killSoundPreviewUrl,
  playKillSoundPreview,
  quakePreset,
} from '../lib/killSounds';

type Props = {
  value: KillSoundsSettings;
  onChange: (next: KillSoundsSettings) => void;
  /** Compacto no wizard; completo no Admin. */
  compact?: boolean;
  disabled?: boolean;
  /** Aviso quando o Desktop ainda não tem IPC de sons. */
  ipcMissing?: boolean;
};

/** Formulário de sons de kill Quake (só host escolhe). */
export function KillSoundsForm(props: Props) {
  const { value, onChange, compact, disabled, ipcMissing } = props;
  const [openCustom, setOpenCustom] = useState(!compact);
  const set = (patch: Partial<KillSoundsSettings>) => onChange({ ...value, ...patch });

  function preview(eventId: string) {
    if (!eventId) return;
    playKillSoundPreview(eventId, value.intensity);
  }

  return (
    <div className={`pm-kill-sounds${compact ? ' is-compact' : ''}`}>
      {!compact ? <h4 className="pm-kill-sounds-title">Sons de kill (só host)</h4> : null}
      <p className="pm-muted pm-kill-sounds-lead">
        {compact
          ? 'Os convidados só ouvem — tu escolhes o pack Quake.'
          : 'Workshop Quake. Jogadores apenas ouvem — sem mute nem menu no cliente. Usa ▶ para preview.'}
      </p>
      {ipcMissing ? (
        <p className="pm-error" style={{ fontSize: '0.82rem' }}>
          Atualiza o Desktop para 1.2.38+ para gravar e aplicar sons.
        </p>
      ) : null}

      <div className="pm-kill-sounds-toolbar">
        <label className="pm-toggle-chip">
          <input
            type="checkbox"
            checked={!!value.enabled}
            disabled={disabled}
            onChange={(e) => set({ enabled: e.target.checked })}
          />
          <span>{value.enabled ? 'Sons ligados' : 'Sons desligados'}</span>
        </label>
        <button
          type="button"
          className="btn btn-sm"
          disabled={disabled}
          onClick={() => onChange(quakePreset())}
        >
          Preset Quake
        </button>
        <button
          type="button"
          className="btn btn-sm"
          disabled={disabled}
          onClick={() => onChange(defaultKillSoundsSettings())}
        >
          Off
        </button>
        <label className="pm-inline-select">
          Volume
          <select
            value={value.intensity}
            disabled={disabled || !value.enabled}
            onChange={(e) => set({ intensity: e.target.value as KillSoundIntensity })}
          >
            <option value="low">Baixo</option>
            <option value="med">Médio</option>
            <option value="high">Alto</option>
          </select>
        </label>
      </div>

      {compact ? (
        <button
          type="button"
          className="pm-linkish"
          disabled={disabled || !value.enabled}
          onClick={() => setOpenCustom((v) => !v)}
        >
          {openCustom ? 'Ocultar sons por evento' : 'Personalizar sons por evento'}
        </button>
      ) : null}

      {(openCustom || !compact) && value.enabled ? (
        <div className="pm-kill-sounds-grid">
          {(Object.keys(KILL_SOUND_EVENT_LABELS) as KillSoundEventKey[]).map((key) => {
            const selected = value.events[key] || '';
            const canPreview = !!killSoundPreviewUrl(selected);
            return (
              <div key={key} className="pm-kill-sound-cell">
                <div className="pm-kill-sound-cell-head">
                  <span>{KILL_SOUND_EVENT_LABELS[key]}</span>
                  <button
                    type="button"
                    className="btn btn-sm"
                    title={canPreview ? 'Ouvir preview' : 'Sem áudio (silêncio)'}
                    disabled={disabled || !canPreview}
                    aria-label={`Preview ${KILL_SOUND_EVENT_LABELS[key]}`}
                    onClick={() => preview(selected)}
                  >
                    ▶
                  </button>
                </div>
                <select
                  value={selected}
                  disabled={disabled}
                  onChange={(e) => {
                    const nextId = e.target.value;
                    onChange({
                      ...value,
                      events: { ...value.events, [key]: nextId },
                    });
                    if (nextId) preview(nextId);
                  }}
                >
                  {KILL_SOUND_CATALOG.map((opt) => (
                    <option key={`${key}-${opt.id || 'none'}`} value={opt.id}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
