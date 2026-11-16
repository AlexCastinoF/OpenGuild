import { create } from 'zustand';
import {
  AppearanceSettings,
  DEFAULT_APPEARANCE,
  STORAGE_KEY,
  applyAppearance,
  getSavedAppearance,
} from '../lib/appearance';
import {
  ThemePreset,
  THEME_PRESETS,
  getActiveSeasonalPreset,
  findMatchingPreset,
} from '../lib/themes';
import { api } from '../lib/api';

interface AppearanceStore {
  settings: AppearanceSettings;
  preview: AppearanceSettings;
  isOpen: boolean;
  open: () => void;
  close: () => void;
  updatePreview: (partial: Partial<AppearanceSettings>) => void;
  applyPreset: (preset: ThemePreset) => void;
  updateAreaColor: (
    area: 'bg' | 'rail' | 'side' | 'main' | 'members' | 'accent',
    color: string,
  ) => void;
  setAutoSpecialDates: (active: boolean) => void;
  save: () => Promise<void>;
  resetToDefault: () => void;
  cancel: () => void;
}

export const useAppearance = create<AppearanceStore>((set, get) => {
  const initial = getSavedAppearance();

  return {
    settings: initial,
    preview: initial,
    isOpen: false,

    open: () => {
      const current = get().settings;
      set({ isOpen: true, preview: { ...current } });
      applyAppearance(current);
    },

    close: () => {
      const saved = get().settings;
      applyAppearance(saved);
      set({ isOpen: false, preview: { ...saved } });
    },

    updatePreview: (partial: Partial<AppearanceSettings>) => {
      const merged = { ...get().preview, ...partial };
      // Se alterou cores, verificar se bate com algum preset pronto ou se virou 'custom'
      if (
        partial.bg ||
        partial.rail ||
        partial.side ||
        partial.main ||
        partial.members ||
        partial.accent
      ) {
        const match = findMatchingPreset(merged);
        merged.selectedThemeId = match ? match.id : 'custom';
      }
      set({ preview: merged });
      applyAppearance(merged);
    },

    applyPreset: (preset: ThemePreset) => {
      const updated: AppearanceSettings = {
        ...get().preview,
        bg: preset.bg,
        rail: preset.rail,
        side: preset.side,
        main: preset.main,
        members: preset.members,
        accent: preset.accent,
        selectedThemeId: preset.id,
      };
      set({ preview: updated });
      applyAppearance(updated);
    },

    updateAreaColor: (area, color) => {
      const next = { ...get().preview, [area]: color };
      const match = findMatchingPreset(next);
      next.selectedThemeId = match ? match.id : 'custom';
      set({ preview: next });
      applyAppearance(next);
    },

    setAutoSpecialDates: (active: boolean) => {
      const current = get().preview;
      let next: AppearanceSettings = { ...current, autoSpecialDates: active };

      if (active) {
        const seasonal = getActiveSeasonalPreset();
        if (seasonal) {
          next = {
            ...next,
            bg: seasonal.bg,
            rail: seasonal.rail,
            side: seasonal.side,
            main: seasonal.main,
            members: seasonal.members,
            accent: seasonal.accent,
            selectedThemeId: seasonal.id,
          };
        }
      } else {
        // Se desligou, tenta restaurar o tema padrão ou o preset escolhido anteriormente
        const preset = THEME_PRESETS.find((p) => p.id === next.selectedThemeId) || THEME_PRESETS[0];
        next = {
          ...next,
          bg: preset.bg,
          rail: preset.rail,
          side: preset.side,
          main: preset.main,
          members: preset.members,
          accent: preset.accent,
          selectedThemeId: preset.id,
        };
      }

      set({ preview: next });
      applyAppearance(next);
    },

    save: async () => {
      const toSave = get().preview;
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
      } catch {
        /* ignore localStorage quota */
      }

      set({ settings: toSave, isOpen: false });
      applyAppearance(toSave);

      // Best effort sync with server
      try {
        await api('/api/community/themes/me', {
          method: 'PUT',
          body: JSON.stringify({
            surfaces: {
              rail: { color: toSave.rail },
              sidebar: { color: toSave.side },
              chat: { color: toSave.main },
              members: { color: toSave.members },
            },
            chrome: {
              accent: toSave.accent,
            },
          }),
        });
      } catch {
        /* offline or guest mode, purely local */
      }
    },

    resetToDefault: () => {
      const def = { ...DEFAULT_APPEARANCE };
      set({ preview: def });
      applyAppearance(def);
    },

    cancel: () => {
      const saved = get().settings;
      applyAppearance(saved);
      set({ isOpen: false, preview: { ...saved } });
    },
  };
});
