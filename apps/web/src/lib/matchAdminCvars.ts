/** Catálogo de cvars do dedicated privado (UI em português). */

export type AdminCvarTabId = 'tempo' | 'economia' | 'times' | 'partida' | 'combate' | 'mensagem';

export type AdminCvarField = {
  key: string;
  label: string;
  hint?: string;
  tab: AdminCvarTabId;
  /** text | number default */
  inputMode?: 'decimal' | 'numeric' | 'text';
  defaultValue: string;
  /** 0/1 mostrado como número */
  min?: number;
  max?: number;
  step?: string;
};

export type AdminCvarTab = {
  id: AdminCvarTabId;
  label: string;
};

export const ADMIN_CVAR_TABS: AdminCvarTab[] = [
  { id: 'tempo', label: 'Tempo' },
  { id: 'economia', label: 'Economia' },
  { id: 'times', label: 'Times' },
  { id: 'partida', label: 'Partida' },
  { id: 'combate', label: 'Combate' },
  { id: 'mensagem', label: 'Mensagem' },
];

export const ADMIN_CVAR_FIELDS: AdminCvarField[] = [
  // —— Tempo ——
  {
    key: 'mp_roundtime',
    label: 'Duração do round (min)',
    hint: 'Competitive usa também mp_roundtime_defuse (aplicado automaticamente).',
    tab: 'tempo',
    inputMode: 'decimal',
    defaultValue: '1.92',
    step: '0.01',
  },
  {
    key: 'mp_freezetime',
    label: 'Freeze time (s)',
    hint: 'Tempo parado no início do round. Vale a partir do próximo round.',
    tab: 'tempo',
    inputMode: 'numeric',
    defaultValue: '15',
  },
  {
    key: 'mp_buytime',
    label: 'Tempo de compra (s)',
    tab: 'tempo',
    inputMode: 'numeric',
    defaultValue: '20',
  },
  {
    key: 'mp_warmuptime',
    label: 'Aquecimento (s)',
    hint: '0 = sem aquecimento.',
    tab: 'tempo',
    inputMode: 'numeric',
    defaultValue: '60',
  },
  {
    key: 'mp_halftime_duration',
    label: 'Intervalo (s)',
    hint: 'Duração do half-time.',
    tab: 'tempo',
    inputMode: 'numeric',
    defaultValue: '15',
  },
  {
    key: 'mp_team_intro_time',
    label: 'Intro dos times (s)',
    tab: 'tempo',
    inputMode: 'numeric',
    defaultValue: '0',
  },

  // —— Economia ——
  {
    key: 'mp_startmoney',
    label: 'Dinheiro inicial',
    tab: 'economia',
    inputMode: 'numeric',
    defaultValue: '800',
  },
  {
    key: 'mp_maxmoney',
    label: 'Dinheiro máximo',
    hint: 'Tem de ser MAIOR que o inicial — senão kills/vitórias não sobem a conta. Default 64000.',
    tab: 'economia',
    inputMode: 'numeric',
    defaultValue: '64000',
  },
  {
    key: 'cash_player_killed_enemy_default',
    label: 'Total por kill',
    hint: 'Padrão do jogo = $300. Se puseres 500, o plugin adiciona +$200 (dinheiro extra).',
    tab: 'economia',
    inputMode: 'numeric',
    defaultValue: '300',
  },
  {
    key: 'cash_team_winner_bonus',
    label: 'Total por vitória',
    hint: 'Padrão do jogo ≈ $4000. Se puseres 5000, o plugin adiciona +$1000 extra.',
    tab: 'economia',
    inputMode: 'numeric',
    defaultValue: '4000',
  },
  {
    key: 'cash_team_loser_bonus',
    label: 'Total por derrota',
    hint: 'Padrão do jogo ≈ $1400. O plugin só adiciona a diferença acima desse valor.',
    tab: 'economia',
    inputMode: 'numeric',
    defaultValue: '1400',
  },
  {
    key: 'mp_afterroundmoney',
    label: 'Extra pós-round (ambos)',
    hint: 'Soma extra no fim do round para CT e TR (além do padrão).',
    tab: 'economia',
    inputMode: 'numeric',
    defaultValue: '0',
  },

  // —— Times ——
  {
    key: 'mp_limitteams',
    label: 'Limite de desequilíbrio',
    hint: '0 = sem limite (recomendado em scrim).',
    tab: 'times',
    inputMode: 'numeric',
    defaultValue: '0',
  },
  {
    key: 'mp_spectators',
    label: 'Espetadores (0/1)',
    tab: 'times',
    inputMode: 'numeric',
    defaultValue: '1',
    min: 0,
    max: 1,
  },
  {
    key: 'mp_autoteambalance',
    label: 'Auto-balance (0/1)',
    hint: 'Manter 0 em partidas privadas com assign por SteamID.',
    tab: 'times',
    inputMode: 'numeric',
    defaultValue: '0',
    min: 0,
    max: 1,
  },
  {
    key: 'sv_human_autojoin_team',
    label: 'Auto-entrar no time (0/1)',
    tab: 'times',
    inputMode: 'numeric',
    defaultValue: '0',
    min: 0,
    max: 1,
  },
  {
    key: 'mp_force_assign_teams',
    label: 'Forçar assign Valve (0/1)',
    tab: 'times',
    inputMode: 'numeric',
    defaultValue: '0',
    min: 0,
    max: 1,
  },
  {
    key: 'bot_quota',
    label: 'Quantidade de bots',
    hint: '0 = sem bots. Preenche slots vazios (fill).',
    tab: 'times',
    inputMode: 'numeric',
    defaultValue: '0',
    min: 0,
    max: 10,
  },
  {
    key: 'bot_difficulty',
    label: 'Dificuldade dos bots (0–3)',
    hint: '0 Fácil · 1 Normal · 2 Difícil · 3 Expert',
    tab: 'times',
    inputMode: 'numeric',
    defaultValue: '1',
    min: 0,
    max: 3,
  },

  // —— Partida ——
  {
    key: 'mp_maxrounds',
    label: 'Máx. rounds',
    hint: 'Ex.: 24 = MR12.',
    tab: 'partida',
    inputMode: 'numeric',
    defaultValue: '24',
  },
  {
    key: 'mp_overtime_enable',
    label: 'Prolongamento (0/1)',
    tab: 'partida',
    inputMode: 'numeric',
    defaultValue: '1',
    min: 0,
    max: 1,
  },
  {
    key: 'mp_overtime_maxrounds',
    label: 'Rounds OT',
    tab: 'partida',
    inputMode: 'numeric',
    defaultValue: '6',
  },
  {
    key: 'mp_overtime_startmoney',
    label: 'Dinheiro OT',
    tab: 'partida',
    inputMode: 'numeric',
    defaultValue: '10000',
  },
  {
    key: 'mp_match_can_clinch',
    label: 'Pode clinch (0/1)',
    hint: '1 = acaba quando um time já não pode ser alcançado.',
    tab: 'partida',
    inputMode: 'numeric',
    defaultValue: '1',
    min: 0,
    max: 1,
  },
  {
    key: 'mp_halftime',
    label: 'Half-time (0/1)',
    tab: 'partida',
    inputMode: 'numeric',
    defaultValue: '1',
    min: 0,
    max: 1,
  },
  {
    key: 'mp_autokick',
    label: 'Kick AFK / TK auto (0/1)',
    hint: '0 = desligado (recomendado em privada). 1 = kick por ausente e team damage.',
    tab: 'partida',
    inputMode: 'numeric',
    defaultValue: '0',
    min: 0,
    max: 1,
  },

  // —— Combate ——
  {
    key: 'mp_friendlyfire',
    label: 'Fogo amigo (0/1)',
    tab: 'combate',
    inputMode: 'numeric',
    defaultValue: '0',
    min: 0,
    max: 1,
  },
  {
    key: 'mp_tkpunish',
    label: 'Punir TK (0/1)',
    tab: 'combate',
    inputMode: 'numeric',
    defaultValue: '0',
    min: 0,
    max: 1,
  },
  {
    key: 'mp_solid_teammates',
    label: 'Colegas sólidos (0/1/2)',
    hint: '0 off · 1 bloqueia · 2 parcial.',
    tab: 'combate',
    inputMode: 'numeric',
    defaultValue: '1',
  },
  {
    key: 'mp_free_armor',
    label: 'Armadura grátis (0/1/2)',
    hint: '0 não · 1 kevlar · 2 kevlar+capacete.',
    tab: 'combate',
    inputMode: 'numeric',
    defaultValue: '0',
  },
  {
    key: 'mp_death_drop_gun',
    label: 'Drop arma ao morrer (0/1)',
    tab: 'combate',
    inputMode: 'numeric',
    defaultValue: '1',
    min: 0,
    max: 1,
  },
  {
    key: 'sv_cheats',
    label: 'sv_cheats (0/1)',
    tab: 'combate',
    inputMode: 'numeric',
    defaultValue: '0',
    min: 0,
    max: 1,
  },
];

export const WELCOME_COLOR_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'green', label: 'Verde (sistema)' },
  { value: 'lime', label: 'Lima' },
  { value: 'yellow', label: 'Amarelo' },
  { value: 'gold', label: 'Dourado' },
  { value: 'lightblue', label: 'Azul claro' },
  { value: 'lightpurple', label: 'Roxo claro' },
  { value: 'olive', label: 'Oliva' },
  { value: 'white', label: 'Branco' },
  { value: 'grey', label: 'Cinza' },
];

export type AdminSettingsMap = Record<string, number | undefined>;

export function defaultAdminSettings(): AdminSettingsMap {
  const out: AdminSettingsMap = {};
  for (const f of ADMIN_CVAR_FIELDS) {
    const n = Number(f.defaultValue);
    if (Number.isFinite(n)) out[f.key] = n;
  }
  return out;
}

export function settingsFromFormValues(values: Record<string, string>): AdminSettingsMap {
  const out: AdminSettingsMap = {};
  for (const f of ADMIN_CVAR_FIELDS) {
    const raw = values[f.key];
    if (raw == null || String(raw).trim() === '') continue;
    const n = Number(raw);
    if (Number.isFinite(n)) out[f.key] = n;
  }
  return out;
}

export function formValuesFromSettings(settings?: AdminSettingsMap | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of ADMIN_CVAR_FIELDS) {
    const v = settings?.[f.key];
    out[f.key] = v != null && Number.isFinite(Number(v)) ? String(v) : f.defaultValue;
  }
  return out;
}

/** Expande aliases: competitive CS2 precisa de mp_roundtime_defuse. */
export function resolveMaxMoney(start?: number, maxRaw?: number): number {
  const s = Number(start);
  let m = maxRaw != null && Number.isFinite(Number(maxRaw)) ? Number(maxRaw) : 64000;
  if (Number.isFinite(s)) {
    if (m < s) m = s;
    if (m <= s) m = Math.max(64000, s + 16000);
  }
  return m;
}

export function expandAdminCvarCommands(
  settings: Record<string, number | boolean | undefined>,
): string[] {
  const cmds: string[] = [];
  const n = (k: string, def?: number) => {
    const v = Number(settings[k]);
    return Number.isFinite(v) ? v : def;
  };

  for (const f of ADMIN_CVAR_FIELDS) {
    if (settings[f.key] == null) continue;
    const v = n(f.key);
    if (v == null) continue;
    if (f.key === 'mp_roundtime') {
      cmds.push(`mp_roundtime ${v}`);
      cmds.push(`mp_roundtime_defuse ${v}`);
      cmds.push(`mp_roundtime_hostage ${v}`);
      continue;
    }
    if (f.key === 'mp_startmoney') {
      cmds.push(`mp_startmoney ${v}`);
      cmds.push(`mp_maxmoney ${resolveMaxMoney(v, n('mp_maxmoney'))}`);
      continue;
    }
    if (f.key === 'mp_maxmoney' && settings.mp_startmoney != null) {
      continue;
    }
    if (f.key === 'mp_warmuptime') {
      cmds.push(`mp_warmuptime ${v}`);
      cmds.push(v > 0 ? 'mp_do_warmup_period 1' : 'mp_do_warmup_period 0');
      continue;
    }
    if (f.key === 'bot_quota') {
      cmds.push(`bot_quota ${v}`);
      if (v > 0) {
        cmds.push('bot_stop 0');
        cmds.push('bot_join_after_player 0');
        cmds.push('bot_auto_vacate 0');
        cmds.push('bot_quota_mode normal');
        const diff = n('bot_difficulty') ?? 1;
        cmds.push(`custom_bot_difficulty ${diff}`);
      } else {
        cmds.push('bot_kick');
      }
      continue;
    }
    if (f.key === 'cash_team_winner_bonus') {
      // CS2 não tem esta cvar — mapeia para vitórias reais
      for (const k of [
        'cash_team_elimination_bomb_map',
        'cash_team_terrorist_win_bomb',
        'cash_team_win_by_defusing_bomb',
        'cash_team_win_by_time_running_out_bomb',
        'cash_team_elimination_hostage_map_ct',
        'cash_team_elimination_hostage_map_t',
        'cash_team_win_by_hostage_rescue',
        'cash_team_win_by_time_running_out_hostage',
      ]) {
        cmds.push(`${k} ${v}`);
      }
      cmds.push('mp_teamcashawards 1');
      cmds.push('mp_playercashawards 1');
      continue;
    }
    if (
      f.key === 'cash_player_killed_enemy_default' ||
      f.key === 'cash_team_loser_bonus'
    ) {
      cmds.push(`${f.key} ${v}`);
      if (f.key === 'cash_team_loser_bonus') {
        cmds.push(`cash_team_loser_bonus_consecutive_rounds ${v}`);
      }
      cmds.push('mp_teamcashawards 1');
      cmds.push('mp_playercashawards 1');
      continue;
    }
    cmds.push(`${f.key} ${v}`);
  }

  if (settings.mp_maxmoney != null && settings.mp_startmoney == null) {
    const max = n('mp_maxmoney');
    if (max != null) cmds.push(`mp_maxmoney ${max}`);
  }

  if (settings.restart) cmds.push('mp_restartgame 1');
  return cmds;
}

/** Sugestões estilo consola CS2 (cvars + comandos comuns do dedicated). */
export const CS2_CONSOLE_SUGGESTIONS: string[] = [
  ...ADMIN_CVAR_FIELDS.map((f) => f.key),
  'mp_roundtime_defuse',
  'mp_roundtime_hostage',
  'mp_restartgame',
  'mp_warmup_start',
  'mp_warmup_end',
  'mp_teamcashawards',
  'mp_playercashawards',
  'cash_team_elimination_bomb_map',
  'cash_team_terrorist_win_bomb',
  'cash_team_win_by_defusing_bomb',
  'cash_team_loser_bonus_consecutive_rounds',
  'sf_add_money',
  'sf_set_money',
  'sf_money_win',
  'sf_money_lose',
  'sf_dump_money',
  'bot_add',
  'bot_add_ct',
  'bot_add_t',
  'bot_kick',
  'bot_quota',
  'bot_stop',
  'bot_difficulty',
  'status',
  'users',
  'changelevel',
  'map',
  'say',
  'sv_cheats',
  'sv_gravity',
  'mp_pause_match',
  'mp_unpause_match',
  'mp_backup_restore_load_file',
  'mp_backup_round_file',
  'exec',
  'host_workshop_map',
  'sv_password',
  'hostname',
  'kickid',
  'banid',
].filter((v, i, a) => a.indexOf(v) === i);

export function suggestConsoleCommands(input: string, limit = 12): string[] {
  const q = String(input || '').trim().toLowerCase();
  if (!q) return CS2_CONSOLE_SUGGESTIONS.slice(0, limit);
  const token = q.split(/\s+/)[0] || q;
  const scored = CS2_CONSOLE_SUGGESTIONS.map((cmd) => {
    const c = cmd.toLowerCase();
    let score = 0;
    if (c === token) score = 100;
    else if (c.startsWith(token)) score = 80;
    else if (c.includes(token)) score = 40;
    else return null;
    return { cmd, score };
  }).filter(Boolean) as Array<{ cmd: string; score: number }>;
  scored.sort((a, b) => b.score - a.score || a.cmd.localeCompare(b.cmd));
  return scored.slice(0, limit).map((x) => x.cmd);
}

export function formatAdminExecError(r?: {
  error?: string;
  hint?: string;
} | null): string {
  if (!r?.error) return 'Falha desconhecida';
  if (r.error === 'dedicated_not_running') {
    return 'Dedicated não está a correr neste PC. Sobe a partida no Desktop primeiro.';
  }
  if (r.error === 'plugin_no_ack') {
    return (
      r.hint ||
      'Plugin não confirmou (DLL antigo?). Reinicia o dedicated no Desktop SteamFarm.'
    );
  }
  if (r.error === 'plugin_exec_partial') {
    return 'Alguns comandos falharam no plugin (ConVar não confirmou). Vê o log do dedicated.';
  }
  if (r.error === 'no_cfg') return 'Pasta cfg do dedicated não encontrada.';
  return r.hint ? `${r.error}: ${r.hint}` : r.error;
}
