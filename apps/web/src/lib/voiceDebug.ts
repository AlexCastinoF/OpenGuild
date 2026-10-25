/** Debug de voz/share — logs no console + IPC Electron para o terminal do main. */

type VoiceLogPayload = Record<string, unknown> | undefined;

function stamp() {
  return new Date().toISOString().slice(11, 23);
}

export function voiceLog(event: string, data?: VoiceLogPayload) {
  const line = data ? `[SF-VOICE] ${stamp()} ${event} ${JSON.stringify(data)}` : `[SF-VOICE] ${stamp()} ${event}`;
  // eslint-disable-next-line no-console
  console.log(line);
  try {
    window.sfDesktop?.voiceLog?.(event, data || {});
  } catch {
    /* ignore */
  }
}

export type AudioElSnap = {
  identity: string;
  kind: string;
  paused: boolean;
  muted: boolean;
  volume: number;
  readyState: number;
  currentTime: number;
  ended: boolean;
  srcObject: boolean;
  trackMuted?: boolean;
  trackEnabled?: boolean;
  trackReadyState?: string;
};

export function snapAudioEls(
  items: Array<{
    el: HTMLAudioElement;
    identity: string;
    kind: string;
    track?: { mediaStreamTrack?: MediaStreamTrack };
  }>,
): AudioElSnap[] {
  return items.map((item) => {
    const mst = item.track?.mediaStreamTrack;
    return {
      identity: item.identity,
      kind: item.kind,
      paused: item.el.paused,
      muted: item.el.muted,
      volume: Number(item.el.volume.toFixed(3)),
      readyState: item.el.readyState,
      currentTime: Number(item.el.currentTime.toFixed(2)),
      ended: item.el.ended,
      srcObject: !!item.el.srcObject,
      trackMuted: mst?.muted,
      trackEnabled: mst?.enabled,
      trackReadyState: mst?.readyState,
    };
  });
}

export function snapRoomAudio(room: {
  canPlaybackAudio?: boolean;
  isRecording?: boolean;
  remoteParticipants: Map<string, unknown> | { size: number };
  localParticipant?: { identity?: string };
} | null) {
  if (!room) return { room: null };
  return {
    canPlaybackAudio: room.canPlaybackAudio,
    remoteCount: room.remoteParticipants.size,
    local: room.localParticipant?.identity,
  };
}
