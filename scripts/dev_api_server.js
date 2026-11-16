const http = require('http');
const crypto = require('crypto');

const PORT = 8014;

// Test user definition
const TEST_USER = {
  id: 1,
  username: 'admin',
  label: 'Admin Teste',
  avatar_url: '',
  role: 'owner',
  is_super: true,
  premium_themes: true,
};

const TEST_PASSWORD = 'admin';

let SERVERS = [
  {
    id: 1,
    name: 'Comunidade CS2',
    description: 'Servidor oficial de treinos e partidas competitivas.',
    is_listed: true,
    icon_url: '',
    banner_url: '',
    role: 'owner',
    permissions: ['admin', 'manage_channels', 'kick_members', 'manage_roles'],
    channels: [
      { id: 1, name: 'geral', kind: 'text', position: 1, icon_url: '' },
      { id: 2, name: 'táticas-mirage', kind: 'text', position: 2, icon_url: '' },
      { id: 3, name: 'Voz Principal', kind: 'voice', position: 3, icon_url: '' },
      { id: 4, name: 'Competitivo Lobby', kind: 'voice', position: 4, icon_url: '' },
    ],
    members: [
      { id: 1, label: 'Admin Teste (Você)', role: 'owner', avatar_url: '', work_status: 'disp' },
      { id: 2, label: 'Fallen', role: 'member', avatar_url: '', work_status: 'jogando' },
      { id: 3, label: 'Coldzera', role: 'member', avatar_url: '', work_status: 'disp' },
      { id: 4, label: 'TACO', role: 'member', avatar_url: '', work_status: 'em_chamada' },
      { id: 5, label: 'Fer', role: 'member', avatar_url: '', work_status: 'disp' },
    ],
  },
];
let SERVER = SERVERS[0];

const PUBLIC_DISCOVER_SERVERS = [
  {
    id: 101,
    name: 'VALORANT Brasil Hub',
    description: 'Comunidade aberta para duos, line-ups, treinos e partidas competitivas.',
    icon_url: '',
    banner_url: '',
    member_count: 54,
    is_member: false,
    admins: [{ label: 'ViperAdmin', username: 'viper', avatar_url: '', role: 'owner' }],
  },
  {
    id: 102,
    name: 'Rust Brasil Survival',
    description: 'Servidores semanais de alta performance, clãs e guias de raid para veteranos.',
    icon_url: '',
    banner_url: '',
    member_count: 142,
    is_member: false,
    admins: [{ label: 'RustMod', username: 'rustmod', avatar_url: '', role: 'owner' }],
  },
  {
    id: 103,
    name: 'RallyDesk Lounge & Trading',
    description: 'Bate-papo livre de desenvolvedores e entusiastas de automação, skins e CS2.',
    icon_url: '',
    banner_url: '',
    member_count: 88,
    is_member: false,
    admins: [{ label: 'SteamAdmin', username: 'steamadmin', avatar_url: '', role: 'owner' }],
  },
];
let pendingJoinRequests = new Set();

let serverRoles = [
  {
    id: 1,
    name: 'Owner',
    color: '#ff9a3d',
    permissions: ['admin', 'manage_channels', 'kick_members', 'manage_roles'],
    hoist: true,
    member_card_color: '#ff9a3d',
    border_color: '#ff9a3d',
    border_effect: 'solid',
    border_motion: 'none',
  },
  {
    id: 2,
    name: 'Capitão',
    color: '#3b9eff',
    permissions: ['manage_channels', 'kick_members'],
    hoist: true,
    member_card_color: '#3b9eff',
    border_color: '#3b9eff',
    border_effect: 'glow',
    border_motion: 'pulse',
  },
  {
    id: 3,
    name: 'Jogador',
    color: '#3ddc97',
    permissions: [],
    hoist: false,
    member_card_color: '#3ddc97',
    border_color: '#3ddc97',
    border_effect: 'solid',
    border_motion: 'none',
  },
];

let messages = [
  {
    id: 1,
    body: '👋 Bem-vindo ao OpenGuild / RallyDesk com o novo redesign em Ilhas!',
    created_at: Date.now() - 60000,
    user: { id: 1, label: 'Admin Teste', avatar_url: '' },
  },
  {
    id: 2,
    body: 'Você pode testar a mudança de temas, o card Rally e o layout de colunas flutuantes.',
    created_at: Date.now() - 30000,
    user: { id: 2, label: 'Fallen', avatar_url: '' },
  },
];

let currentTheme = { surfaces: {}, chrome: {} };
let loggedIn = true; // Auto-login by default for local testing
let currentVoiceChannelId = null;

let MATCHES = {};

function getActiveRooms() {
  return Object.values(MATCHES)
    .filter((m) => m.status !== 'ended')
    .map((m) => ({
      id: m.id,
      serverId: m.serverId,
      name: m.name,
      format: m.format,
      mode: m.mode,
      status: m.status,
      votedMap: m.votedMap || 'de_mirage',
      playersCount: m.players.filter((p) => p.inviteStatus !== 'declined').length,
      players: m.players,
      hostUserId: m.hostUserId,
      roomPassword: m.roomPassword,
    }));
}

let io = null;

const server = http.createServer((req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Cookie');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });

  req.on('end', () => {
    let parsedBody = {};
    if (body) {
      try {
        parsedBody = JSON.parse(body);
      } catch (_) {}
    }

    const sendJson = (status, data, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(JSON.stringify(data));
    };

    // 1. Auth Status
    if (pathname === '/api/auth/status') {
      return sendJson(200, {
        ok: true,
        user: loggedIn ? TEST_USER : null,
        needs_setup: false,
        register_enabled: true,
      });
    }

    // 2. Auth Login
    if (pathname === '/api/auth/login' && req.method === 'POST') {
      const { username, password } = parsedBody;
      if (
        (username === 'admin' && password === 'admin') ||
        (username === 'teste' && password === 'teste123') ||
        (username && password)
      ) {
        loggedIn = true;
        const user = {
          ...TEST_USER,
          username: username || 'admin',
          label: username === 'admin' ? 'Admin Teste' : username,
        };
        return sendJson(
          200,
          {
            ok: true,
            token: 'test-session-token-123',
            user,
          },
          {
            'Set-Cookie': 'sf_react_token=test-session-token-123; Path=/; HttpOnly=false',
          }
        );
      }
      return sendJson(401, { ok: false, error: 'Credenciais inválidas' });
    }

    // 3. Auth Me
    if (pathname === '/api/auth/me') {
      return sendJson(200, {
        ok: true,
        user: loggedIn ? TEST_USER : null,
      });
    }

    // 4. Auth Logout
    if (pathname === '/api/auth/logout') {
      loggedIn = false;
      return sendJson(200, { ok: true });
    }

    // 5. Brand Bootstrap
    if (pathname === '/api/brand/bootstrap' || pathname.startsWith('/api/brand') || pathname === '/api/community/brand') {
      return sendJson(200, {
        ok: true,
        name: 'RallyDesk',
        short_name: 'RallyDesk',
        logo_url: '/logo.png',
        favicon_url: '/logo.png',
      });
    }

    // 6. Community Servers List & Create
    if (pathname === '/api/community/servers') {
      if (req.method === 'GET') {
        return sendJson(200, {
          servers: SERVERS.map((s) => ({
            id: s.id,
            name: s.name,
            icon_url: s.icon_url,
            member_count: s.members.length,
            role: s.role || 'owner',
          })),
        });
      }

      if (req.method === 'POST') {
        const newId = SERVERS.length + 1;
        const newServer = {
          id: newId,
          name: parsedBody.name || 'Novo Servidor',
          description: 'Servidor criado pelo usuário.',
          is_listed: true,
          icon_url: '',
          banner_url: '',
          role: 'owner',
          permissions: ['admin', 'manage_channels', 'kick_members', 'manage_roles'],
          channels: [
            { id: 1, name: 'geral', kind: 'text', position: 1, icon_url: '' },
            { id: 2, name: 'Voz Geral', kind: 'voice', position: 2, icon_url: '' },
          ],
          members: [
            { id: 1, label: 'Admin Teste (Você)', role: 'owner', avatar_url: '', work_status: 'disp' },
          ],
        };
        SERVERS.push(newServer);
        return sendJson(200, {
          ok: true,
          server: {
            id: newId,
            name: newServer.name,
            role: 'owner',
          },
        });
      }
    }

    // 7. Server Roles (GET, POST, PATCH, DELETE)
    // /api/community/servers/:id/roles
    const rolesMatch = pathname.match(/^\/api\/community\/servers\/(\d+)\/roles(?:\/(\d+))?$/);
    if (rolesMatch) {
      const roleId = rolesMatch[2] ? parseInt(rolesMatch[2], 10) : null;

      if (req.method === 'GET') {
        return sendJson(200, { ok: true, roles: serverRoles });
      }

      if (req.method === 'POST') {
        const newRole = {
          id: serverRoles.length + 1,
          name: parsedBody.name || 'Novo Cargo',
          color: parsedBody.color || '#5865f2',
          permissions: parsedBody.permissions || [],
          hoist: !!parsedBody.hoist,
          member_card_color: parsedBody.member_card_color || '#5865f2',
          border_color: parsedBody.border_color || '#5865f2',
          border_effect: parsedBody.border_effect || 'solid',
          border_motion: parsedBody.border_motion || 'none',
        };
        serverRoles.push(newRole);
        return sendJson(200, { ok: true, role: newRole });
      }

      if (req.method === 'PATCH' && roleId) {
        const idx = serverRoles.findIndex((r) => r.id === roleId);
        if (idx !== -1) {
          serverRoles[idx] = { ...serverRoles[idx], ...parsedBody };
          return sendJson(200, { ok: true, role: serverRoles[idx] });
        }
        return sendJson(200, { ok: true });
      }

      if (req.method === 'DELETE' && roleId) {
        serverRoles = serverRoles.filter((r) => r.id !== roleId);
        return sendJson(200, { ok: true });
      }
    }

    // 8. Assign Member Roles
    // /api/community/servers/:id/members/:userId/roles
    if (pathname.includes('/members/') && pathname.endsWith('/roles')) {
      return sendJson(200, { ok: true });
    }

    // 9. Kick Member
    if (pathname.includes('/members/') && pathname.endsWith('/kick')) {
      return sendJson(200, { ok: true });
    }

    // 10. Channels management
    // /api/community/channels/:id/livekit-token
    const livekitMatch = pathname.match(/^\/api\/community\/channels\/(\d+)\/livekit-token$/);
    if (livekitMatch && req.method === 'POST') {
      const channelId = Number(livekitMatch[1]);
      currentVoiceChannelId = channelId;
      return sendJson(200, {
        ok: true,
        url: 'mock://localhost:7880',
        token: 'mock-dev-token-' + channelId,
        avatar_url: TEST_USER.avatar_url || '',
        channel_id: channelId,
      });
    }

    // Voice leave
    const voiceLeaveMatch = pathname.match(/^\/api\/community\/servers\/(\d+)\/voice-leave$/);
    if (voiceLeaveMatch && req.method === 'POST') {
      currentVoiceChannelId = null;
      return sendJson(200, { ok: true });
    }

    // /api/community/servers/:id/channels
    const channelsMatch = pathname.match(/^\/api\/community\/servers\/(\d+)\/channels$/);
    if (channelsMatch) {
      const sId = parseInt(channelsMatch[1], 10);
      const targetServer = SERVERS.find((s) => s.id === sId) || SERVERS[0];
      if (req.method === 'POST') {
        const newCh = {
          id: targetServer.channels.length + 1,
          name: parsedBody.name || 'novo-canal',
          kind: parsedBody.kind || 'text',
          position: targetServer.channels.length + 1,
          icon_url: '',
        };
        targetServer.channels.push(newCh);
        return sendJson(200, { ok: true, channel: newCh });
      }
      return sendJson(200, { ok: true, channels: targetServer.channels });
    }

    // Single channel PATCH & DELETE: /api/community/channels/:id
    const singleChannelMatch = pathname.match(/^\/api\/community\/channels\/(\d+)$/);
    if (singleChannelMatch) {
      const cId = parseInt(singleChannelMatch[1], 10);
      for (const s of SERVERS) {
        const cIdx = s.channels.findIndex((c) => c.id === cId);
        if (cIdx !== -1) {
          if (req.method === 'DELETE') {
            s.channels.splice(cIdx, 1);
            return sendJson(200, { ok: true });
          }
          if (req.method === 'PATCH') {
            s.channels[cIdx] = { ...s.channels[cIdx], ...parsedBody };
            return sendJson(200, { ok: true, channel: s.channels[cIdx] });
          }
        }
      }
      return sendJson(200, { ok: true });
    }

    // 11. Community Server Detail & Update
    // /api/community/servers/:id
    const serverDetailMatch = pathname.match(/^\/api\/community\/servers\/(\d+)$/);
    if (serverDetailMatch) {
      const sId = parseInt(serverDetailMatch[1], 10);
      let targetServer = SERVERS.find((s) => s.id === sId) || SERVERS[0];
      if (req.method === 'PATCH') {
        targetServer = {
          ...targetServer,
          ...parsedBody,
          name: parsedBody.name !== undefined ? parsedBody.name : targetServer.name,
          description: parsedBody.description !== undefined ? parsedBody.description : targetServer.description,
          is_listed: parsedBody.is_listed !== undefined ? parsedBody.is_listed : targetServer.is_listed,
          icon_url: parsedBody.icon_url !== undefined ? parsedBody.icon_url : targetServer.icon_url,
          banner_url: parsedBody.banner_url !== undefined ? parsedBody.banner_url : targetServer.banner_url,
        };
        const idx = SERVERS.findIndex((s) => s.id === sId);
        if (idx !== -1) SERVERS[idx] = targetServer;
        return sendJson(200, { ok: true, server: targetServer });
      }
      return sendJson(200, {
        server: targetServer,
      });
    }

    // 12. Discover & Join
    if (pathname === '/api/community/discover') {
      const userServersList = SERVERS.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description || 'Servidor da comunidade.',
        icon_url: s.icon_url || '',
        banner_url: s.banner_url || '',
        is_member: true,
        join_pending: false,
        member_count: s.members ? s.members.length : 1,
        admins: s.members
          ? s.members.filter((m) => m.role === 'owner' || m.role === 'admin').map((m) => ({
              label: m.label,
              username: m.label,
              avatar_url: m.avatar_url,
              role: m.role,
            }))
          : [],
      }));

      const publicList = PUBLIC_DISCOVER_SERVERS.map((s) => ({
        ...s,
        join_pending: pendingJoinRequests.has(s.id),
      }));

      return sendJson(200, {
        ok: true,
        servers: [...userServersList, ...publicList],
      });
    }

    const joinReqMatch = pathname.match(/^\/api\/community\/servers\/(\d+)\/join-requests$/);
    if (joinReqMatch && req.method === 'POST') {
      const sId = parseInt(joinReqMatch[1], 10);
      pendingJoinRequests.add(sId);
      return sendJson(200, { ok: true, pending: true, message: 'Pedido enviado com sucesso.' });
    }

    const directJoinMatch = pathname.match(/^\/api\/community\/servers\/(\d+)\/join$/);
    if (directJoinMatch && req.method === 'POST') {
      const sId = parseInt(directJoinMatch[1], 10);
      const found = PUBLIC_DISCOVER_SERVERS.find((s) => s.id === sId);
      if (found) {
        found.is_member = true;
        if (!SERVERS.some((s) => s.id === sId)) {
          SERVERS.push({
            id: found.id,
            name: found.name,
            description: found.description,
            is_listed: true,
            icon_url: found.icon_url,
            banner_url: found.banner_url,
            role: 'member',
            permissions: [],
            channels: [
              { id: 1, name: 'geral', kind: 'text', position: 1, icon_url: '' },
              { id: 2, name: 'Voz Geral', kind: 'voice', position: 2, icon_url: '' },
            ],
            members: [
              { id: TEST_USER.id, label: TEST_USER.label, role: 'member', avatar_url: '', work_status: 'disp' },
            ],
          });
        }
      }
      return sendJson(200, { ok: true, server_id: sId });
    }

    if (pathname === '/api/community/join' && req.method === 'POST') {
      const target = SERVERS[0];
      return sendJson(200, { ok: true, server_id: target ? target.id : 1 });
    }

    if (pathname === '/api/community/join-requests') {
      return sendJson(200, { ok: true, requests: [] });
    }

    // 13. Media Upload
    if (pathname === '/api/community/media') {
      return sendJson(200, {
        ok: true,
        url: 'https://images.unsplash.com/photo-1542751371-adc38448a05e?w=800',
      });
    }

    // 14. Messages
    if (pathname.includes('/messages')) {
      if (req.method === 'POST') {
        const newMsg = {
          id: messages.length + 1,
          body: parsedBody.body || '',
          created_at: Date.now(),
          user: { id: 1, label: TEST_USER.label, avatar_url: '' },
        };
        messages.push(newMsg);
        return sendJson(201, { message: newMsg });
      }
      return sendJson(200, { messages });
    }

    // 15. Presence
    if (pathname.includes('/presence')) {
      const presenceObj = {};
      if (currentVoiceChannelId) {
        presenceObj[String(currentVoiceChannelId)] = [
          {
            identity: '1',
            user_id: 1,
            name: TEST_USER.label,
            avatar_url: TEST_USER.avatar_url || '',
          },
        ];
      }
      return sendJson(200, {
        presence: presenceObj,
        online_users: [1, 2, 3, 4, 5],
        work_statuses: { '1': 'disp', '2': 'disp', '3': 'disp' },
        presence_info: {
          '2': { game: 'CS2' },
        },
      });
    }

    // 16. Themes & Appearance
    if (pathname === '/api/community/themes/me' || pathname === '/api/community/themes') {
      if (req.method === 'POST' || req.method === 'PUT') {
        currentTheme = parsedBody;
        return sendJson(200, { ok: true, theme: currentTheme });
      }
      return sendJson(200, currentTheme);
    }

    // 17. Steam Setup / Link / Profile
    if (pathname.includes('/steam')) {
      return sendJson(200, {
        steam_linked: false,
        steam_id64: '',
        persona: '',
      });
    }

    // 18. YouTube Search (Music System)
    if (pathname.includes('/youtube/search')) {
      const q = (url.searchParams.get('q') || '').toLowerCase().trim();
      const catalog = [
        {
          id: 'jfKfPfyJRdk',
          title: 'lofi hip hop radio - beats to relax/study to',
          channel: 'Lofi Girl',
          thumb: 'https://i.ytimg.com/vi/jfKfPfyJRdk/mqdefault.jpg',
        },
        {
          id: '5qap5aO4i9A',
          title: 'Lofi Hip Hop Radio - Beats to Sleep/Chill to',
          channel: 'Lofi Girl',
          thumb: 'https://i.ytimg.com/vi/5qap5aO4i9A/mqdefault.jpg',
        },
        {
          id: 'DWcJFNfaw9c',
          title: 'CS2 Official Soundtrack - Counter-Strike 2 Main Theme',
          channel: 'Valve',
          thumb: 'https://i.ytimg.com/vi/DWcJFNfaw9c/mqdefault.jpg',
        },
        {
          id: 'kJQP7kiw5Fk',
          title: 'Luis Fonsi - Despacito ft. Daddy Yankee',
          channel: 'Luis Fonsi',
          thumb: 'https://i.ytimg.com/vi/kJQP7kiw5Fk/mqdefault.jpg',
        },
        {
          id: 'JGwWNGJdvx8',
          title: 'Ed Sheeran - Shape of You',
          channel: 'Ed Sheeran',
          thumb: 'https://i.ytimg.com/vi/JGwWNGJdvx8/mqdefault.jpg',
        },
        {
          id: 'kXYiU_JCYtU',
          title: 'Linkin Park - Numb',
          channel: 'Linkin Park',
          thumb: 'https://i.ytimg.com/vi/kXYiU_JCYtU/mqdefault.jpg',
        },
        {
          id: 'fJ9rUzIMcZQ',
          title: 'Queen - Bohemian Rhapsody',
          channel: 'Queen Official',
          thumb: 'https://i.ytimg.com/vi/fJ9rUzIMcZQ/mqdefault.jpg',
        },
      ];
      let items = catalog.filter(
        (t) => t.title.toLowerCase().includes(q) || t.channel.toLowerCase().includes(q)
      );
      if (!items.length) {
        items = [
          {
            id: 'jfKfPfyJRdk',
            title: q ? `Música: ${q}` : 'Música Selecionada',
            channel: 'RallyDesk Music',
            thumb: 'https://i.ytimg.com/vi/jfKfPfyJRdk/mqdefault.jpg',
          },
          ...catalog.slice(0, 4),
        ];
      }
      return sendJson(200, { ok: true, items });
    }

    // 19. Private Match System
    if (pathname === '/api/private-match/rooms') {
      return sendJson(200, { ok: true, rooms: getActiveRooms() });
    }

    if (pathname === '/api/private-match' && req.method === 'POST') {
      const matchId = `match_${Date.now()}`;
      const match = {
        id: matchId,
        serverId: parsedBody.server_id || 1,
        mode: parsedBody.mode || 'valve',
        status: 'lobby',
        name: parsedBody.name || 'Treino CS2',
        roomPassword: parsedBody.room_password || '123',
        format: parsedBody.format || '5v5',
        mr: parsedBody.mr || 12,
        overtime: true,
        hostUserId: TEST_USER.id,
        mapPool: ['de_mirage', 'de_inferno', 'de_dust2', 'de_nuke', 'de_ancient', 'de_anubis'],
        votes: {},
        votedMap: '',
        voteEndsAt: 0,
        readyCountdownEndsAt: 0,
        bootPhase: '',
        bootMessage: '',
        connect: null,
        players: [
          {
            userId: TEST_USER.id,
            username: TEST_USER.username,
            displayName: TEST_USER.label || TEST_USER.username,
            avatarUrl: TEST_USER.avatar_url || '',
            team: 'CT',
            ready: false,
            connected: false,
            isHost: true,
            inviteStatus: 'host',
          },
        ],
        scoreCt: 0,
        scoreT: 0,
        round: 0,
        stats: [],
        feed: [],
        canJoin: true,
        canWatch: true,
        isMember: true,
        youPending: false,
      };

      if (Array.isArray(parsedBody.invite_ids)) {
        for (const uid of parsedBody.invite_ids) {
          match.players.push({
            userId: Number(uid),
            username: `player_${uid}`,
            displayName: `Jogador ${uid}`,
            avatarUrl: '',
            team: 'T',
            ready: false,
            connected: false,
            isHost: false,
            inviteStatus: 'pending',
          });
          if (io) {
            io.emit('match.invite', {
              match_id: match.id,
              host_name: TEST_USER.label,
              name: match.name,
              map: 'de_mirage',
            });
          }
        }
      }

      MATCHES[matchId] = match;
      if (io) {
        io.emit('match.updated', match);
        io.emit('match.rooms', { rooms: getActiveRooms() });
      }
      return sendJson(201, { ok: true, match });
    }

    if (pathname.includes('/private-match/') && pathname.includes('/vote/')) {
      const matchId = pathname.split('/')[3];
      const match = MATCHES[matchId];
      if (match) {
        if (pathname.endsWith('/start')) {
          match.status = 'voting';
          match.voteEndsAt = Date.now() + 30000;
          if (io) {
            io.emit('match.vote_started', match);
            io.emit('match.updated', match);
          }
          return sendJson(200, { ok: true, match });
        }
        if (pathname.endsWith('/cast')) {
          const mapId = parsedBody.map || 'de_mirage';
          match.votes[String(TEST_USER.id)] = mapId;
          match.votedMap = mapId;
          if (io) {
            io.emit('match.vote_cast', match);
            io.emit('match.updated', match);
          }
          return sendJson(200, { ok: true, match });
        }
      }
      return sendJson(200, { ok: true, match });
    }

    const matchAction = pathname.match(/^\/api\/private-match\/([^/]+)\/([a-zA-Z0-9_-]+)$/);
    if (matchAction && req.method === 'POST') {
      const matchId = matchAction[1];
      const action = matchAction[2];
      const match = MATCHES[matchId];

      if (!match && action !== 'end') {
        return sendJson(404, { ok: false, error: 'Match not found' });
      }

      if (action === 'join') {
        const callerId = 2; // Simulado para teste de multiplayer local
        if (!match.players.some((p) => p.userId === callerId)) {
          match.players.push({
            userId: callerId,
            username: 'Fallen',
            displayName: 'Fallen',
            avatarUrl: '',
            team: 'T',
            ready: false,
            connected: false,
            isHost: false,
            inviteStatus: 'accepted',
          });
        }
        if (io) io.emit('match.updated', match);
        return sendJson(200, { ok: true, match });
      }

      if (action === 'invite') {
        const targetId = Number(parsedBody.target_id) || 2;
        if (!match.players.some((p) => p.userId === targetId)) {
          match.players.push({
            userId: targetId,
            username: `user_${targetId}`,
            displayName: `Jogador ${targetId}`,
            avatarUrl: '',
            team: 'T',
            ready: false,
            connected: false,
            isHost: false,
            inviteStatus: 'pending',
          });
        }
        if (io) {
          io.emit('match.invite', {
            match_id: match.id,
            host_name: TEST_USER.label,
            name: match.name,
            map: match.votedMap || 'de_mirage',
          });
          io.emit('match.updated', match);
        }
        return sendJson(200, { ok: true, match });
      }

      if (action === 'respond') {
        const accept = !!parsedBody.accept;
        const targetId = Number(parsedBody.user_id) || TEST_USER.id;
        const p = match.players.find((pl) => pl.userId === targetId);
        if (p) {
          p.inviteStatus = accept ? 'accepted' : 'declined';
        }
        if (io) io.emit('match.updated', match);
        return sendJson(200, { ok: true, match });
      }

      if (action === 'ready') {
        const rdy = !!parsedBody.ready;
        const p = match.players.find((pl) => pl.userId === TEST_USER.id);
        if (p) p.ready = rdy;

        const allReady = match.players
          .filter((x) => x.inviteStatus === 'accepted' || x.isHost)
          .every((x) => x.ready);
        if (allReady && match.players.length >= 1) {
          match.readyCountdownEndsAt = Date.now() + 4000;
          if (io) io.emit('match.ready_countdown', match);
        }
        if (io) io.emit('match.updated', match);
        return sendJson(200, { ok: true, match });
      }

      if (action === 'host-ready') {
        match.status = 'connecting';
        const host = parsedBody.host || '127.0.0.1';
        const port = parsedBody.port || 27015;
        const pw = parsedBody.password || match.roomPassword || '123';
        match.connect = {
          host,
          port,
          password: pw,
          connectString: `connect ${host}:${port}; password ${pw}`,
          map: match.votedMap || 'de_mirage',
        };
        if (io) {
          io.emit('match.connect', match);
          io.emit('match.updated', match);
        }
        return sendJson(200, { ok: true, match });
      }

      if (action === 'connected') {
        const p = match.players.find((pl) => pl.userId === TEST_USER.id);
        if (p) p.connected = true;
        match.status = 'live';
        if (io) io.emit('match.updated', match);
        return sendJson(200, { ok: true, match });
      }

      if (action === 'end') {
        if (match) {
          match.status = 'ended';
          delete MATCHES[matchId];
        }
        if (io) {
          io.emit('match.ended', { match_id: matchId });
          io.emit('match.rooms', { rooms: getActiveRooms() });
        }
        return sendJson(200, { ok: true });
      }

      if (action === 'leave') {
        match.players = match.players.filter((p) => p.userId !== TEST_USER.id);
        if (match.players.length === 0) {
          delete MATCHES[matchId];
        }
        if (io) {
          io.emit('match.updated', match);
          io.emit('match.rooms', { rooms: getActiveRooms() });
        }
        return sendJson(200, { ok: true });
      }

      if (action === 'boot-progress') {
        match.bootPhase = parsedBody.phase || '';
        match.bootMessage = parsedBody.message || '';
        if (io) io.emit('match.updated', match);
        return sendJson(200, { ok: true });
      }

      if (action === 'valve-start') {
        match.status = 'connecting';
        if (io) {
          io.emit('match.valve_start', match);
          io.emit('match.updated', match);
        }
        return sendJson(200, { ok: true, match });
      }
    }

    // Default fallback
    return sendJson(200, { ok: true });
  });
});

try {
  const { Server } = require('socket.io');
  io = new Server(server, {
    path: '/ws',
    cors: {
      origin: '*',
      credentials: true,
    },
    transports: ['websocket', 'polling'],
  });
  io.on('connection', (sock) => {
    sock.emit('match.rooms', { rooms: getActiveRooms() });
    sock.on('disconnect', () => {});
  });
  console.log('[Socket.IO] Real-time gateway active on path /ws');
} catch (e) {
  console.warn('[Socket.IO] Initialisation note:', e.message);
}

process.on('uncaughtException', (err) => {
  if (err && (err.code === 'ECONNRESET' || err.code === 'EPIPE')) return;
  console.error('[Mock Dev API] Uncaught exception:', err);
});

server.on('clientError', (err, socket) => {
  if (err.code === 'ECONNRESET' || !socket.writable) return;
  socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[Mock Dev API] Server listening on http://127.0.0.1:${PORT}`);
});
