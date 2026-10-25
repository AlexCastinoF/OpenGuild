import { useMemo, useState } from 'react';
import { PremierVetoPanel } from '../components/PremierVetoPanel';
import { MAP_LABEL } from '../lib/mapAssets';
import type { MatchPlayer, MatchVeto, PrivateMatch } from '../lib/privateMatch';

const MAPS = Object.keys(MAP_LABEL);
const ME = 1;

function player(partial: Partial<MatchPlayer> & Pick<MatchPlayer, 'userId' | 'team'>): MatchPlayer {
  return {
    username: 'hidden',
    displayName: '*******',
    avatarUrl: '',
    ready: true,
    connected: true,
    isHost: partial.userId === ME,
    inviteStatus: partial.userId === ME ? 'host' : 'accepted',
    rating: 12000 + (partial.userId || 0) * 137,
    ...partial,
  };
}

function buildMatch(opts: {
  bans: string[];
  sliceIndex: number;
  pickSide: boolean;
  votes: Record<string, string>;
}): PrivateMatch {
  const left = MAPS.filter((id) => !opts.bans.includes(id));
  const slices: MatchVeto['slices'] = [
    { kind: 'ban', count: 2, team: 'CT', label: 'Ban 2 Maps' },
    { kind: 'ban', count: 3, team: 'T', label: 'Ban 3 Maps' },
    { kind: 'ban', count: 2, team: 'CT', label: 'Ban 2 Maps' },
    { kind: 'ban', count: 2, team: 'T', label: 'Ban 2 Maps' },
    { kind: 'pick_side', count: 1, team: 'CT', label: 'Pick Starting Team' },
    { kind: 'done', count: 0, team: 'CT', label: 'Pronto' },
  ];
  const slice = opts.pickSide ? slices.length - 2 : Math.min(opts.sliceIndex, slices.length - 3);
  const radarCt = Object.fromEntries(MAPS.map((id, i) => [id, 0.35 + ((i * 17) % 50) / 100]));
  const radarT = Object.fromEntries(MAPS.map((id, i) => [id, 0.28 + ((i * 23) % 55) / 100]));
  return {
    id: 'preview',
    serverId: 1,
    mode: 'host_listen',
    status: 'voting',
    name: 'Preview veto',
    roomPassword: '',
    format: '5v5',
    mr: 12,
    overtime: true,
    hostUserId: ME,
    mapPool: MAPS,
    votes: opts.votes,
    votedMap: left.length === 1 ? left[0] : '',
    voteEndsAt: Date.now() + 28_000,
    serverNow: Date.now(),
    teamRating: { CT: 61240, T: 59810 },
    radarCt,
    radarT,
    veto: {
      slices,
      sliceIndex: slice,
      remainingInSlice: 2,
      turnTeam: 'CT',
      mapsLeft: left,
      bans: opts.bans.map((map, i) => ({ map, team: i % 2 === 0 ? 'CT' : 'T' })),
      turnEndsAt: Date.now() + 28_000,
      startingSide: '',
      pickerUserId: ME,
    },
    connect: null,
    players: [
      player({ userId: 1, team: 'CT' }),
      player({ userId: 2, team: 'CT' }),
      player({ userId: 3, team: 'CT' }),
      player({ userId: 4, team: 'CT' }),
      player({ userId: 5, team: 'CT' }),
      player({ userId: 6, team: 'T' }),
      player({ userId: 7, team: 'T' }),
      player({ userId: 8, team: 'T' }),
      player({ userId: 9, team: 'T' }),
      player({ userId: 10, team: 'T' }),
    ],
    scoreCt: 0,
    scoreT: 0,
    round: 0,
    stats: [],
    feed: [],
  };
}

export function VetoPreviewPage() {
  const [bans, setBans] = useState<string[]>(['overpass', 'vertigo']);
  const [pickSide, setPickSide] = useState(false);
  const [votes, setVotes] = useState<Record<string, string>>({
    '1': 'mirage',
    '2': 'mirage',
    '6': 'inferno',
  });

  const match = useMemo(
    () =>
      buildMatch({
        bans,
        sliceIndex: bans.length >= 4 ? 1 : 0,
        pickSide,
        votes,
      }),
    [bans, pickSide, votes],
  );

  return (
    <div className="pv-lab">
      <aside className="pv-lab-bar">
        <strong>Lab veto</strong>
        <button type="button" onClick={() => setBans([])}>
          Reset bans
        </button>
        <button type="button" onClick={() => setBans(['overpass', 'vertigo'])}>
          2 bans
        </button>
        <button type="button" onClick={() => setPickSide((v) => !v)}>
          {pickSide ? 'Fase ban' : 'Escolher lado'}
        </button>
        <span>{bans.length} banidos · clica nos mapas</span>
      </aside>
      <div className="pv-lab-stage">
        <PremierVetoPanel
          match={match}
          userId={ME}
          onBan={(mapId) => {
            setBans((prev) => (prev.includes(mapId) ? prev : [...prev, mapId]));
            setVotes((prev) => ({ ...prev, [String(ME)]: mapId }));
          }}
          onPickSide={() => setPickSide(false)}
          onEnd={() => {
            setBans([]);
            setPickSide(false);
          }}
        />
      </div>
    </div>
  );
}
