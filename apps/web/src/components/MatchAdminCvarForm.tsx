import { useMemo, useState } from 'react';
import {
  ADMIN_CVAR_FIELDS,
  ADMIN_CVAR_TABS,
  WELCOME_COLOR_OPTIONS,
  type AdminCvarTabId,
  type AdminSettingsMap,
  formValuesFromSettings,
  settingsFromFormValues,
} from '../lib/matchAdminCvars';

export function MatchAdminCvarForm(props: {
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
  welcome?: string;
  welcomeColor?: string;
  onWelcomeChange?: (v: string) => void;
  onWelcomeColorChange?: (v: string) => void;
  /** Esconde abas (ex.: só tempo+economia no wizard). */
  tabs?: AdminCvarTabId[];
  compact?: boolean;
}) {
  const allowed = props.tabs?.length
    ? ADMIN_CVAR_TABS.filter((t) => props.tabs!.includes(t.id))
    : ADMIN_CVAR_TABS;
  const [tab, setTab] = useState<AdminCvarTabId>(allowed[0]?.id || 'tempo');
  const activeTab = allowed.some((t) => t.id === tab) ? tab : allowed[0]?.id || 'tempo';

  const fields = useMemo(
    () => ADMIN_CVAR_FIELDS.filter((f) => f.tab === activeTab),
    [activeTab],
  );

  return (
    <div className={`pm-admin-cvars${props.compact ? ' is-compact' : ''}`}>
      <div className="pm-tabs pm-admin-subtabs" role="tablist">
        {allowed.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={activeTab === t.id}
            className={activeTab === t.id ? 'is-on' : ''}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {activeTab === 'mensagem' ? (
        <div className="pm-fields" style={{ marginTop: 10 }}>
          <label>
            Mensagem de boas-vindas (chat CS2)
            <input
              value={props.welcome ?? ''}
              onChange={(e) => props.onWelcomeChange?.(e.target.value)}
              maxLength={200}
              placeholder="Partida Privada Castino.Tech"
            />
          </label>
          <label>
            Cor da mensagem
            <select
              value={props.welcomeColor || 'green'}
              onChange={(e) => props.onWelcomeColorChange?.(e.target.value)}
            >
              {WELCOME_COLOR_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : (
        <div className="pm-admin-grid" style={{ marginTop: 10 }}>
          {fields.map((f) => (
            <label key={f.key} title={f.hint || f.key}>
              {f.label}
              <input
                value={props.values[f.key] ?? f.defaultValue}
                onChange={(e) => props.onChange(f.key, e.target.value)}
                inputMode={f.inputMode === 'text' ? undefined : f.inputMode || 'decimal'}
                step={f.step}
                min={f.min}
                max={f.max}
                placeholder={f.defaultValue}
              />
              {f.hint && !props.compact ? <small className="pm-muted">{f.hint}</small> : null}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

export function useAdminCvarFormState(initial?: AdminSettingsMap | null) {
  const [values, setValues] = useState(() => formValuesFromSettings(initial));
  const [dirty, setDirty] = useState(false);
  const setField = (key: string, value: string) => {
    setDirty(true);
    setValues((prev) => ({ ...prev, [key]: value }));
  };
  const syncFrom = (settings?: AdminSettingsMap | null, opts?: { force?: boolean }) => {
    if (dirty && !opts?.force) return;
    setValues(formValuesFromSettings(settings));
    if (opts?.force) setDirty(false);
  };
  const markClean = () => setDirty(false);
  const toSettings = (): AdminSettingsMap => settingsFromFormValues(values);
  return { values, setField, syncFrom, toSettings, setValues, dirty, markClean, setDirty };
}
