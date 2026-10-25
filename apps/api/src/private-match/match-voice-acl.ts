import { ForbiddenException } from '@nestjs/common';

export type MatchVoiceTeam = 'CT' | 'T' | 'SPEC';

type Gate = {
  matchId: string;
  team: MatchVoiceTeam;
  allow: Set<number>;
};

const byChannel = new Map<number, Gate>();

export function setMatchVoiceAcl(channelId: number, gate: Gate | null) {
  if (!channelId) return;
  if (!gate) byChannel.delete(channelId);
  else byChannel.set(channelId, { ...gate, allow: new Set(gate.allow) });
}

export function clearMatchVoiceAcl(channelId: number) {
  byChannel.delete(channelId);
}

export function assertMatchVoiceJoin(channelId: number, userId: number): 'skip' | 'ok' {
  const g = byChannel.get(channelId);
  if (!g) return 'skip';
  if (!g.allow.has(userId)) {
    throw new ForbiddenException({ ok: false, error: 'match_voice_acl' });
  }
  return 'ok';
}
