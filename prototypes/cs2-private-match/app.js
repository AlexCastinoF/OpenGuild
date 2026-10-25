/**
 * Mock: Partidas = canal do servidor (junto a texto/voz)
 * Rail = só servers. Sidebar = canais. Main = conteúdo do canal.
 */
(function () {
  const PLAYERS = [
    { name: 'Alex', initials: 'AL', host: true, team: 'CT', k: 18, a: 4, d: 11, hs: 9, hp: 100 },
    { name: 'Marina', initials: 'MA', team: 'CT', k: 14, a: 6, d: 12, hs: 6, hp: 87 },
    { name: 'Lia', initials: 'LI', team: 'CT', k: 11, a: 3, d: 13, hs: 4, hp: 0 },
    { name: 'Rafa', initials: 'RF', team: 'T', k: 16, a: 2, d: 14, hs: 8, hp: 54 },
    { name: 'Diego', initials: 'DG', team: 'T', k: 9, a: 5, d: 15, hs: 3, hp: 22 },
  ];

  const SERVER_MEMBERS = [
    { name: 'Alex', initials: 'AL', role: 'Admin', online: true },
    { name: 'Marina', initials: 'MA', role: 'Member', online: true },
    { name: 'Rafa', initials: 'RF', role: 'Member', online: true },
    { name: 'Diego', initials: 'DG', role: 'Member', online: false },
    { name: 'Lia', initials: 'LI', role: 'Member', online: true },
  ];

  const MAPS = [
    { id: 'mirage', name: 'Mirage', votes: 3, bg: 'linear-gradient(135deg,#3d5a40,#1a2820)' },
    { id: 'inferno', name: 'Inferno', votes: 2, bg: 'linear-gradient(135deg,#6b3a28,#2a1810)' },
    { id: 'dust2', name: 'Dust II', votes: 1, bg: 'linear-gradient(135deg,#c4a35a,#3a3018)' },
    { id: 'nuke', name: 'Nuke', votes: 0, bg: 'linear-gradient(135deg,#4a6a78,#1a2830)' },
    { id: 'ancient', name: 'Ancient', votes: 1, bg: 'linear-gradient(135deg,#2d5c45,#142218)' },
    { id: 'anubis', name: 'Anubis', votes: 0, bg: 'linear-gradient(135deg,#b8924a,#2a2210)' },
  ];

  const PRESETS = [
    { label: 'status', cmd: 'status' },
    { label: 'restart', cmd: 'mp_restartgame 1' },
    { label: 'pause', cmd: 'mp_pause_match' },
    { label: 'unpause', cmd: 'mp_unpause_match' },
    { label: 'cheats on', cmd: 'sv_cheats 1' },
    { label: 'cheats off', cmd: 'sv_cheats 0' },
    { label: 'bot_kick', cmd: 'bot_kick' },
    { label: 'changelevel', cmd: 'changelevel de_mirage' },
  ];

  const HISTORY = [
    { map: 'Mirage', score: '13–9', mode: 'host_listen', when: 'Hoje 19:42', result: 'Vitória CT' },
    { map: 'Inferno', score: '11–13', mode: 'valve', when: 'Ontem 22:10', result: 'Derrota' },
    { map: 'Dust II', score: '13–7', mode: 'vps', when: 'Sáb 16:05', result: 'Vitória T' },
  ];

  const state = {
    channel: 'partidas', // geral | avisos | lobby | scrim | partidas
    screen: 'hub', // within partidas, or chat/voice for other channels
    mode: 'valve',
    createMode: 'valve',
    votedMap: 'mirage',
    roomName: 'Scrim sexta',
    password: 'rally4',
    hasLiveMatch: true,
    logLines: [
      'Server logging enabled.',
      'GSLT ok · port 27016',
      'Mirage loaded',
      'Client "Alex" connected',
    ],
  };

  const els = {
    stage: document.getElementById('stage'),
    overlay: document.getElementById('overlay'),
    overlayBody: document.getElementById('overlayBody'),
    title: document.getElementById('screenTitle'),
    eyebrow: document.getElementById('screenEyebrow'),
    mainChIcon: document.getElementById('mainChIcon'),
    mainMeta: document.getElementById('mainMeta'),
    matchTabs: document.getElementById('matchTabs'),
    banners: document.getElementById('banners'),
    bannerMeta: document.getElementById('bannerMeta'),
    membersTitle: document.getElementById('membersTitle'),
    membersSub: document.getElementById('membersSub'),
    membersBody: document.getElementById('membersBody'),
    chMatchBadge: document.getElementById('chMatchBadge'),
  };

  function modeLabel(m) {
    const mode = m || state.mode;
    if (mode === 'host_listen') return 'PC host';
    if (mode === 'vps') return 'Server VPS';
    return 'Valve';
  }

  function modeClass(m) {
    const mode = m || state.mode;
    if (mode === 'host_listen') return 'is-dedi';
    if (mode === 'vps') return 'is-vps';
    return 'is-valve';
  }

  function kd(p) {
    return p.d ? (p.k / p.d).toFixed(2) : String(p.k);
  }

  function hsPct(p) {
    return p.k ? Math.round((p.hs / p.k) * 100) : 0;
  }

  function connectHint() {
    if (state.mode === 'valve') return 'Private MM · sem IP';
    if (state.mode === 'vps') return '203.0.113.10:27015';
    return '192.168.1.10:27016';
  }

  function isPartidas() {
    return state.channel === 'partidas';
  }

  function go(screen, channel) {
    if (channel) state.channel = channel;
    if (state.channel !== 'partidas') {
      state.screen = state.channel === 'lobby' || state.channel === 'scrim' ? 'voice' : 'chat';
    } else {
      state.screen = screen || 'hub';
    }
    closeOverlay();
    render();
  }

  function openOverlay(html) {
    els.overlayBody.innerHTML = html;
    els.overlay.classList.remove('hidden');
    els.overlay.setAttribute('aria-hidden', 'false');
  }

  function closeOverlay() {
    els.overlay.classList.add('hidden');
    els.overlay.setAttribute('aria-hidden', 'true');
    els.overlayBody.innerHTML = '';
  }

  function syncChrome() {
    const partidas = isPartidas();

    // Channel highlight in sidebar
    document.querySelectorAll('.side-nav .comm-ch').forEach((btn) => {
      btn.classList.toggle('is-on', btn.getAttribute('data-ch') === state.channel);
    });

    // Storyboard
    document.querySelectorAll('.story-group button').forEach((b) => {
      const goTo = b.getAttribute('data-go');
      const ch = b.getAttribute('data-ch');
      const active =
        ch === state.channel &&
        (ch !== 'partidas' || goTo === state.screen || (goTo === 'hub' && state.screen === 'hub'));
      b.classList.toggle('is-active', active);
    });

    document.querySelectorAll('[data-sim]').forEach((b) => {
      b.classList.toggle('is-on', b.getAttribute('data-sim') === state.mode);
    });

    // Match tabs
    els.matchTabs.hidden = !partidas;
    if (partidas) {
      document.querySelectorAll('.match-tab').forEach((t) => {
        t.classList.toggle('is-on', t.getAttribute('data-go') === state.screen);
      });
    }

    // Banner only when live + not already on live tab
    const showBanner = state.hasLiveMatch && (!partidas || state.screen !== 'live');
    els.banners.hidden = !showBanner;
    els.bannerMeta.textContent = `${state.roomName} · Mirage 8–7 · ${modeLabel()}`;
    els.chMatchBadge.hidden = !state.hasLiveMatch;

    // Title
    if (partidas) {
      const titles = {
        hub: 'Partidas',
        create: 'Nova partida',
        lobby: 'Lobby',
        vote: 'Votação de mapa',
        boot: 'A preparar server',
        live: 'Ao vivo',
        host: 'Comandos do host',
        history: 'Histórico',
        results: 'Resultado',
      };
      els.eyebrow.textContent = 'Canal · competitivo';
      els.title.textContent = titles[state.screen] || 'Partidas';
      els.mainChIcon.textContent = '▶';
      els.mainChIcon.classList.add('is-match');
      els.mainMeta.innerHTML = `<span class="badge ${modeClass()}">${modeLabel()}</span>`;
      els.membersTitle.textContent = state.screen === 'live' || state.screen === 'lobby' ? 'Na partida' : 'Membros';
      els.membersSub.textContent = state.screen === 'live' ? 'Dados GSI' : 'Castino Scrims';
    } else if (state.screen === 'voice') {
      els.eyebrow.textContent = 'Canal de voz';
      els.title.textContent = state.channel === 'scrim' ? 'Scrim' : 'Lobby';
      els.mainChIcon.textContent = '◎';
      els.mainChIcon.classList.remove('is-match');
      els.mainMeta.innerHTML = '';
      els.membersTitle.textContent = 'Na voz';
      els.membersSub.textContent = '3 ligados';
    } else {
      els.eyebrow.textContent = 'Canal de texto';
      els.title.textContent = state.channel;
      els.mainChIcon.textContent = '#';
      els.mainChIcon.classList.remove('is-match');
      els.mainMeta.innerHTML = '';
      els.membersTitle.textContent = 'Membros';
      els.membersSub.textContent = 'Castino Scrims';
    }

    renderMembers();
  }

  function renderMembers() {
    if (isPartidas() && (state.screen === 'live' || state.screen === 'lobby' || state.screen === 'host')) {
      els.membersBody.innerHTML = PLAYERS.map((p) => `
        <div class="member-card">
          <div class="avatar">${p.initials}</div>
          <div class="meta">
            <strong>${p.name}</strong>
            <small>${state.screen === 'live' ? `${p.k}/${p.a}/${p.d} · HP ${p.hp}` : 'Ready'}</small>
          </div>
          ${p.host ? '<span class="pill host">Host</span>' : ''}
          <span class="pill ${p.team === 'CT' ? 'ct' : 't'}">${p.team}</span>
        </div>`).join('');
      return;
    }
    els.membersBody.innerHTML = SERVER_MEMBERS.map((m) => `
      <div class="member-card" style="opacity:${m.online ? 1 : 0.45}">
        <div class="avatar">${m.initials}</div>
        <div class="meta">
          <strong>${m.name}</strong>
          <small>${m.role}${m.online ? '' : ' · offline'}</small>
        </div>
      </div>`).join('');
  }

  function scoreTable(team) {
    const rows = PLAYERS.filter((p) => p.team === team);
    return `
      <table class="score-table">
        <thead>
          <tr>
            <th>${team}</th>
            <th class="num">K</th><th class="num">A</th><th class="num">D</th>
            <th class="num">HS%</th><th class="num">K/D</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((p) => `
            <tr class="${p.name === 'Alex' ? 'is-you' : ''}">
              <td>${p.name}${p.hp === 0 ? ' · ✕' : ''}</td>
              <td class="num">${p.k}</td>
              <td class="num">${p.a}</td>
              <td class="num">${p.d}</td>
              <td class="num">${hsPct(p)}</td>
              <td class="num">${kd(p)}</td>
            </tr>`).join('')}
        </tbody>
      </table>`;
  }

  const screens = {
    chat() {
      return `
        <div class="frame">
          <div class="chat-fake">
            <div class="chat-msg">
              <div class="avatar">MA</div>
              <div>
                <strong>Marina</strong><time>19:01</time>
                <p>Alguém para scrim depois?</p>
              </div>
            </div>
            <div class="chat-msg">
              <div class="avatar">AL</div>
              <div>
                <strong>Alex</strong><time>19:02</time>
                <p>Sim — abre o canal <b>Partidas</b> na barra à esquerda (abaixo de Voz).</p>
              </div>
            </div>
            <div class="chat-msg">
              <div class="avatar">RF</div>
              <div>
                <strong>Rafa</strong><time>19:03</time>
                <p>Perfeito, já entro lá.</p>
              </div>
            </div>
          </div>
          <p class="note">Isto é um canal de texto normal. Partidas é outro tipo de canal, na secção Competitivo.</p>
        </div>`;
    },

    voice() {
      return `
        <div class="frame">
          <div class="voice-stage">
            <div style="text-align:center">
              <div style="font-size:2rem;opacity:.35">◎</div>
              <strong>${state.channel === 'scrim' ? 'Scrim' : 'Lobby'}</strong>
              <p>Canal de voz · 3 pessoas</p>
            </div>
          </div>
          <p class="note">Voz continua aqui. Para criar/acompanhar CS2, usa o canal <b>Partidas</b> (secção Competitivo).</p>
        </div>`;
    },

    hub() {
      if (!state.hasLiveMatch) {
        return `
          <div class="frame">
            <div class="hero">
              <div>
                <h2>Partidas CS2</h2>
                <p>Cria uma sala privada, convida o servidor e acompanha o placar ao vivo pelo GSI.</p>
              </div>
              <button type="button" class="btn btn-primary" data-go="create" data-ch="partidas">Nova partida</button>
            </div>
            <div class="empty-state">
              <h3>Nenhuma partida ativa</h3>
              <p>Escolhe Valve, o teu PC como dedicated, ou um server VPS.</p>
              <button type="button" class="btn btn-primary" data-go="create" data-ch="partidas">Criar partida</button>
            </div>
            <div class="panel">
              <div class="panel-head"><h3>Histórico recente</h3>
                <button type="button" class="btn btn-sm btn-ghost" data-go="history" data-ch="partidas">Ver tudo</button>
              </div>
              <div class="hist-list">
                ${HISTORY.slice(0, 2).map((h) => `
                  <div class="hist-row">
                    <div class="map">${h.map}</div>
                    <div>
                      <div>${h.result}</div>
                      <div class="when">${h.when} · ${modeLabel(h.mode)}</div>
                    </div>
                    <div class="score">${h.score}</div>
                  </div>`).join('')}
              </div>
            </div>
          </div>`;
      }

      return `
        <div class="frame">
          <div class="hero">
            <div>
              <h2>Partidas CS2</h2>
              <p>Canal do servidor desta instalacao Scrims. Uma partida de cada vez por servidor.</p>
            </div>
            <button type="button" class="btn" data-go="history" data-ch="partidas">Histórico</button>
          </div>

          <div class="active-match">
            <div>
              <span class="badge ${modeClass()}">${modeLabel()}</span>
              <div style="margin-top:8px;font-weight:750;font-size:0.95rem">${state.roomName}</div>
              <div class="score">8<span>–</span>7</div>
              <div class="meta-line">Mirage · round 16 · 5 jogadores · GSI ligado</div>
            </div>
            <div class="btn-row" style="margin:0;flex-direction:column;align-items:stretch">
              <button type="button" class="btn btn-primary" data-go="live" data-ch="partidas">Ver ao vivo</button>
              <button type="button" class="btn" data-go="lobby" data-ch="partidas">Abrir lobby</button>
              <button type="button" class="btn" data-go="host" data-ch="partidas">Comandos host</button>
            </div>
          </div>

          <div class="panel">
            <div class="panel-head">
              <h3>Como funciona</h3>
            </div>
            <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;font-size:0.8rem;color:var(--muted)">
              <div><strong style="color:var(--text);display:block;margin-bottom:4px">1. Criar</strong>Valve, PC host ou VPS</div>
              <div><strong style="color:var(--text);display:block;margin-bottom:4px">2. Lobby</strong>Ready, times, mapa</div>
              <div><strong style="color:var(--text);display:block;margin-bottom:4px">3. Ao vivo</strong>Placar e roster via GSI</div>
            </div>
          </div>
        </div>`;
    },

    create() {
      const m = state.createMode;
      return `
        <div class="frame">
          <div class="hero">
            <div>
              <h2>Nova partida</h2>
              <p>Onde a sala vai correr? Podes mudar depois só criando outra.</p>
            </div>
          </div>
          <div class="panel">
            <div class="mode-chooser">
              <button type="button" class="mode-card ${m === 'valve' ? 'is-selected' : ''}" data-set-mode="valve">
                <strong>Valve</strong>
                <span>Private Matchmaking oficial. Sem server teu. Ideal para fila rápida.</span>
              </button>
              <button type="button" class="mode-card ${m === 'host_listen' ? 'is-selected' : ''}" data-set-mode="host_listen">
                <strong>O teu PC</strong>
                <span>Dedicated local no Electron. Connect automático na LAN.</span>
              </button>
              <button type="button" class="mode-card ${m === 'vps' ? 'is-selected' : ''}" data-set-mode="vps">
                <strong>Server VPS</strong>
                <span>Slot Castino com IP público. RCON para o host.</span>
              </button>
            </div>
            <div class="row" style="margin-top:14px">
              <label class="field">Nome da sala<input id="roomName" value="${state.roomName}" /></label>
              <label class="field">Senha<input id="roomPass" value="${state.password}" /></label>
            </div>
            <div class="row" style="margin-top:10px">
              <label class="field">Formato
                <select><option>5v5</option><option>2v2</option></select>
              </label>
              <label class="field">${m === 'vps' ? 'Slot' : m === 'host_listen' ? 'Porta' : 'Notas'}
                ${m === 'vps'
                  ? '<select><option>eu-1 · 27015 livre</option><option>eu-2 · ocupado</option></select>'
                  : m === 'host_listen'
                    ? '<input value="27016" />'
                    : '<input value="Regras Valve" disabled />'}
              </label>
            </div>
            <div class="btn-row">
              <button type="button" class="btn" data-go="hub" data-ch="partidas">Cancelar</button>
              <button type="button" class="btn btn-primary" data-action="create-go">Criar lobby</button>
            </div>
          </div>
        </div>`;
    },

    lobby() {
      const ct = PLAYERS.filter((p) => p.team === 'CT');
      const t = PLAYERS.filter((p) => p.team === 'T');
      const dedi = state.mode !== 'valve';
      return `
        <div class="frame">
          <div class="hero">
            <div>
              <h2>${state.roomName}</h2>
              <p>${modeLabel()} · ${connectHint()}</p>
            </div>
            <span class="badge ${modeClass()}">${modeLabel()}</span>
          </div>
          <div class="panel">
            <div class="teams">
              <div class="team-col ct">
                <h4>Counter-Terrorists</h4>
                ${ct.map((p) => `
                  <div class="slot"><div class="slot-row">
                    <div class="avatar">${p.initials}</div>
                    <div class="meta"><strong>${p.name}</strong><small>Ready</small></div>
                    ${p.host ? '<span class="pill host">Host</span>' : '<span class="pill live">Ready</span>'}
                  </div></div>`).join('')}
              </div>
              <div class="team-col t">
                <h4>Terrorists</h4>
                ${t.map((p) => `
                  <div class="slot"><div class="slot-row">
                    <div class="avatar">${p.initials}</div>
                    <div class="meta"><strong>${p.name}</strong><small>Ready</small></div>
                    <span class="pill live">Ready</span>
                  </div></div>`).join('')}
              </div>
            </div>
            <div class="btn-row">
              ${dedi
                ? `<button type="button" class="btn btn-primary" data-go="vote" data-ch="partidas">Votar mapa</button>`
                : `<button type="button" class="btn btn-primary" data-go="live" data-ch="partidas">Iniciar · ir ao vivo</button>`}
              <button type="button" class="btn" data-go="host" data-ch="partidas">Comandos host</button>
            </div>
          </div>
        </div>`;
    },

    vote() {
      return `
        <div class="frame">
          <div class="hero">
            <div>
              <h2>Escolhe o mapa</h2>
              <p>${state.mode === 'vps' ? 'O VPS aplica changelevel via RCON.' : 'Depois o host sobe o dedicated no PC.'}</p>
            </div>
          </div>
          <div class="panel">
            <div class="map-grid">
              ${MAPS.map((map) => `
                <button type="button" class="map-card ${state.votedMap === map.id ? 'is-voted' : ''}"
                  style="background:${map.bg}" data-vote="${map.id}">
                  <strong>${map.name}</strong>
                  <span>${map.votes} voto${map.votes === 1 ? '' : 's'}</span>
                </button>`).join('')}
            </div>
            <div class="btn-row">
              <button type="button" class="btn" data-go="lobby" data-ch="partidas">Voltar</button>
              <button type="button" class="btn btn-primary" data-go="boot" data-ch="partidas">Confirmar mapa</button>
            </div>
          </div>
        </div>`;
    },

    boot() {
      const vps = state.mode === 'vps';
      return `
        <div class="frame">
          <div class="hero">
            <div>
              <h2>${vps ? 'A reservar VPS' : 'A subir dedicated'}</h2>
              <p>Mirage · ${connectHint()}</p>
            </div>
          </div>
          <div class="panel">
            <div class="boot-steps">
              <div class="boot-step is-done"><i>✓</i><div><strong>${vps ? 'Slot livre' : 'GSLT ok'}</strong></div></div>
              <div class="boot-step is-done"><i>✓</i><div><strong>${vps ? 'RCON changelevel' : 'cs2.exe -dedicated'}</strong></div></div>
              <div class="boot-step is-run"><i>…</i><div><strong>À espera de ready</strong></div></div>
            </div>
            <div class="btn-row">
              <button type="button" class="btn btn-primary" data-go="live" data-ch="partidas">Simular ready → ao vivo</button>
            </div>
          </div>
        </div>`;
    },

    live() {
      return `
        <div class="frame">
          <div class="panel">
            <div class="score-hero">
              <div class="side ct">CT</div>
              <div class="nums">8<span>–</span>7</div>
              <div class="side t">T</div>
            </div>
            <div class="round-meta">Mirage · round 16 · freeze · fonte GSI</div>
            ${scoreTable('CT')}
            <div style="height:12px"></div>
            ${scoreTable('T')}
            <div class="btn-row">
              <button type="button" class="btn" data-go="host" data-ch="partidas">Comandos host</button>
              <button type="button" class="btn btn-primary" data-action="end-match">Encerrar · resultado</button>
            </div>
          </div>
          <p class="note">Roster e placar vêm do jogo (GSI). Painel direito = jogadores da partida.</p>
        </div>`;
    },

    host() {
      const via = state.mode === 'vps' ? 'RCON' : state.mode === 'host_listen' ? 'consola dedicated' : null;
      return `
        <div class="frame">
          <div class="hero">
            <div>
              <h2>Comandos do host</h2>
              <p>${via ? `Envio via ${via}.` : 'Modo Valve — sem consola de server; só GSI e lobby.'}</p>
            </div>
            <span class="badge ${modeClass()}">${modeLabel()}</span>
          </div>
          <div class="panel">
            ${!via ? `
              <p class="note" style="margin-bottom:12px">No Private MM da Valve não há RCON. Usa o live scoreboard para acompanhar.</p>
              <button type="button" class="btn" data-go="live" data-ch="partidas">Ir ao vivo</button>
            ` : `
              <div class="preset-grid">
                ${PRESETS.map((p) => `<button type="button" class="btn" data-preset="${p.cmd}">${p.label}</button>`).join('')}
              </div>
              <div class="row" style="grid-template-columns:1fr auto;align-items:end">
                <label class="field">Comando
                  <input class="cmd-input" id="cmdInput" placeholder="mp_restartgame 1" />
                </label>
                <button type="button" class="btn btn-primary" data-action="exec-cmd">Executar</button>
              </div>
              <div style="height:10px"></div>
              <div class="log-tail">${state.logLines.join('\n')}</div>
            `}
          </div>
        </div>`;
    },

    history() {
      return `
        <div class="frame">
          <div class="hero">
            <div>
              <h2>Histórico</h2>
              <p>Partidas deste servidor · GSI + metadados da sala.</p>
            </div>
            <button type="button" class="btn btn-primary" data-go="create" data-ch="partidas">Nova partida</button>
          </div>
          <div class="hist-list">
            ${HISTORY.map((h) => `
              <div class="hist-row">
                <div class="map">${h.map}</div>
                <div>
                  <div>${h.result}</div>
                  <div class="when">${h.when} · <span class="badge ${modeClass(h.mode)}" style="margin-left:4px">${modeLabel(h.mode)}</span></div>
                </div>
                <div class="score">${h.score}</div>
              </div>`).join('')}
          </div>
        </div>`;
    },

    results() {
      const sorted = [...PLAYERS].sort((a, b) => b.k - a.k);
      return `
        <div class="frame">
          <div class="hero">
            <div>
              <h2>Mirage · 13–9</h2>
              <p>CT vence · guardado no histórico do servidor</p>
            </div>
          </div>
          <div class="panel">
            <table class="score-table">
              <thead>
                <tr>
                  <th>#</th><th>Jogador</th><th>Time</th>
                  <th class="num">K</th><th class="num">A</th><th class="num">D</th><th class="num">HS%</th>
                </tr>
              </thead>
              <tbody>
                ${sorted.map((p, i) => `
                  <tr class="${p.name === 'Alex' ? 'is-you' : ''}">
                    <td>${i + 1}</td>
                    <td>${p.name}</td>
                    <td>${p.team}</td>
                    <td class="num">${p.k}</td>
                    <td class="num">${p.a}</td>
                    <td class="num">${p.d}</td>
                    <td class="num">${hsPct(p)}</td>
                  </tr>`).join('')}
              </tbody>
            </table>
            <div class="btn-row">
              <button type="button" class="btn" data-go="history" data-ch="partidas">Histórico</button>
              <button type="button" class="btn btn-primary" data-action="clear-live">Voltar ao início</button>
            </div>
          </div>
        </div>`;
    },
  };

  function render() {
    syncChrome();
    let key = state.screen;
    if (!isPartidas()) key = state.screen; // chat | voice
    const fn = screens[key] || screens.hub;
    els.stage.innerHTML = fn();
  }

  document.body.addEventListener('click', (e) => {
    const t = e.target.closest(
      '[data-go],[data-sim],[data-set-mode],[data-vote],[data-preset],[data-action],[data-close-overlay]',
    );
    if (!t) return;

    if (t.hasAttribute('data-close-overlay')) {
      closeOverlay();
      return;
    }

    if (t.hasAttribute('data-go')) {
      go(t.getAttribute('data-go'), t.getAttribute('data-ch') || undefined);
      return;
    }

    if (t.hasAttribute('data-sim')) {
      state.mode = t.getAttribute('data-sim');
      state.createMode = state.mode;
      render();
      return;
    }

    if (t.hasAttribute('data-set-mode')) {
      state.createMode = t.getAttribute('data-set-mode');
      state.mode = state.createMode;
      render();
      return;
    }

    if (t.hasAttribute('data-vote')) {
      state.votedMap = t.getAttribute('data-vote');
      render();
      return;
    }

    if (t.hasAttribute('data-preset')) {
      const cmd = t.getAttribute('data-preset');
      state.logLines.push(`> ${cmd}`, `OK`);
      const input = document.getElementById('cmdInput');
      if (input) input.value = cmd;
      render();
      return;
    }

    const action = t.getAttribute('data-action');
    if (action === 'create-go') {
      const name = document.getElementById('roomName');
      const pass = document.getElementById('roomPass');
      if (name) state.roomName = name.value || state.roomName;
      if (pass) state.password = pass.value || state.password;
      state.mode = state.createMode;
      state.hasLiveMatch = true;
      go('lobby', 'partidas');
      return;
    }
    if (action === 'exec-cmd') {
      const input = document.getElementById('cmdInput');
      const cmd = (input && input.value.trim()) || '';
      if (!cmd) return;
      state.logLines.push(`> ${cmd}`, 'OK');
      render();
      return;
    }
    if (action === 'end-match') {
      go('results', 'partidas');
      return;
    }
    if (action === 'clear-live') {
      state.hasLiveMatch = false;
      go('hub', 'partidas');
    }
  });

  els.overlay.addEventListener('click', (e) => {
    if (e.target.hasAttribute('data-close-overlay')) closeOverlay();
  });

  render();
})();
