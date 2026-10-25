import type { LocalAudioTrack } from 'livekit-client';

function clampLevel(n: unknown) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return 85;
  return Math.max(0, Math.min(100, v));
}

type LevelCapable = {
  setSuppressionLevel?: (n: number) => void;
  setEnabled?: (v: boolean) => Promise<boolean | undefined> | boolean | undefined;
};

/** Atualiza intensidade no processador activo (DeepFilter / RNNoise / DTLN / Krisp). */
export async function setNoiseLevelOnTrack(
  track: LocalAudioTrack | null | undefined,
  level: number,
) {
  if (!track) return;
  const n = clampLevel(level);
  const proc = (track as unknown as { _processor?: LevelCapable })._processor;
  if (proc?.setSuppressionLevel) {
    proc.setSuppressionLevel(n);
    return;
  }
  if (proc?.setEnabled) {
    try {
      await proc.setEnabled(n > 5);
    } catch {
      /* ignore */
    }
  }
}
