/** Catálogo de sons Quake (Workshop 3461824328) — só o host escolhe. */

export const QUAKE_WORKSHOP_ID = '3461824328';

export type KillSoundEventKey =
  | 'kill'
  | 'headshot'
  | 'firstBlood'
  | 'knife'
  | 'doubleKill'
  | 'tripleKill'
  | 'killstreak';

export type KillSoundIntensity = 'low' | 'med' | 'high';

export type KillSoundsSettings = {
  enabled: boolean;
  workshopIds: string[];
  intensity: KillSoundIntensity;
  soundEventFile: string;
  events: Record<KillSoundEventKey, string>;
};

export const KILL_SOUND_EVENT_LABELS: Record<KillSoundEventKey, string> = {
  kill: 'Kill',
  headshot: 'Headshot',
  firstBlood: 'First Blood',
  knife: 'Faca',
  doubleKill: 'Double Kill',
  tripleKill: 'Triple Kill',
  killstreak: 'Killstreak (5+)',
};

/** Opções do dropdown (sound events do pack Quake). */
export const KILL_SOUND_CATALOG: Array<{ id: string; label: string }> = [
  { id: '', label: '(silêncio)' },
  { id: 'QuakeSoundsD.Humiliation', label: 'Humiliation' },
  { id: 'QuakeSoundsD.Headshot', label: 'Headshot' },
  { id: 'QuakeSoundsD.Firstblood', label: 'First Blood' },
  { id: 'QuakeSoundsD.Haha', label: 'Haha (faca)' },
  { id: 'QuakeSoundsD.Humiliating', label: 'Humiliating' },
  { id: 'QuakeSoundsD.Doublekill', label: 'Double Kill' },
  { id: 'QuakeSoundsD.Triplekill', label: 'Triple Kill' },
  { id: 'QuakeSoundsD.Multikill', label: 'Multi Kill' },
  { id: 'QuakeSoundsD.Killingspree', label: 'Killing Spree' },
  { id: 'QuakeSoundsD.Dominating', label: 'Dominating' },
  { id: 'QuakeSoundsD.Rampage', label: 'Rampage' },
  { id: 'QuakeSoundsD.Unstoppable', label: 'Unstoppable' },
  { id: 'QuakeSoundsD.Godlike', label: 'Godlike' },
  { id: 'QuakeSoundsD.Wickedsick', label: 'Wicked Sick' },
  { id: 'QuakeSoundsD.Holyshit', label: 'Holy Shit' },
  { id: 'QuakeSoundsD.Impressive', label: 'Impressive' },
  { id: 'QuakeSoundsD.Perfect', label: 'Perfect' },
];

/** MP3 de preview em /match-sounds/quake (mesmo pack Workshop). */
const PREVIEW_FILE: Record<string, string> = {
  'QuakeSoundsD.Humiliation': 'humiliation.mp3',
  'QuakeSoundsD.Headshot': 'headshot.mp3',
  'QuakeSoundsD.Firstblood': 'firstblood.mp3',
  'QuakeSoundsD.Haha': 'haha.mp3',
  'QuakeSoundsD.Humiliating': 'humiliating.mp3',
  'QuakeSoundsD.Doublekill': 'doublekill.mp3',
  'QuakeSoundsD.Triplekill': 'triplekill.mp3',
  'QuakeSoundsD.Multikill': 'multikill.mp3',
  'QuakeSoundsD.Killingspree': 'killingspree.mp3',
  'QuakeSoundsD.Dominating': 'dominating.mp3',
  'QuakeSoundsD.Rampage': 'rampage.mp3',
  'QuakeSoundsD.Unstoppable': 'unstoppable.mp3',
  'QuakeSoundsD.Godlike': 'godlike.mp3',
  'QuakeSoundsD.Wickedsick': 'wickedsick.mp3',
  'QuakeSoundsD.Holyshit': 'holyshit.mp3',
  'QuakeSoundsD.Impressive': 'impressive.mp3',
  'QuakeSoundsD.Perfect': 'perfect.mp3',
};

export function killSoundPreviewUrl(eventId: string): string | null {
  const file = PREVIEW_FILE[String(eventId || '').trim()];
  return file ? `/match-sounds/quake/${file}` : null;
}

export function intensityToVolume(intensity: KillSoundIntensity | string): number {
  if (intensity === 'low') return 0.45;
  if (intensity === 'high') return 1;
  return 0.75;
}

let previewAudio: HTMLAudioElement | null = null;

/** Toca preview do evento; para o anterior se ainda estiver a tocar. */
export function playKillSoundPreview(
  eventId: string,
  intensity: KillSoundIntensity | string = 'med',
): boolean {
  const url = killSoundPreviewUrl(eventId);
  if (!url || typeof Audio === 'undefined') return false;
  try {
    if (previewAudio) {
      previewAudio.pause();
      previewAudio.currentTime = 0;
    }
    previewAudio = new Audio(url);
    previewAudio.volume = intensityToVolume(intensity);
    void previewAudio.play();
    return true;
  } catch {
    return false;
  }
}
export function defaultKillSoundsSettings(): KillSoundsSettings {
  return {
    enabled: false,
    workshopIds: [QUAKE_WORKSHOP_ID],
    intensity: 'med',
    soundEventFile: 'soundevents/soundevents_quakesounds.vsndevts',
    events: {
      kill: 'QuakeSoundsD.Humiliation',
      headshot: 'QuakeSoundsD.Headshot',
      firstBlood: 'QuakeSoundsD.Firstblood',
      knife: 'QuakeSoundsD.Haha',
      doubleKill: 'QuakeSoundsD.Doublekill',
      tripleKill: 'QuakeSoundsD.Triplekill',
      killstreak: 'QuakeSoundsD.Killingspree',
    },
  };
}

export function quakePreset(): KillSoundsSettings {
  return { ...defaultKillSoundsSettings(), enabled: true };
}
