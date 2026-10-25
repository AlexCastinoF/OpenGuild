export const WORK_STATUS_OPTIONS = [
  { id: '', label: 'Disponível' },
  { id: 'pausa_banheiro', label: 'Pausa Banheiro' },
  { id: 'pausa_almoco', label: 'Pausa Almoço' },
  { id: 'reuniao', label: 'Reunião' },
  { id: 'google_meet', label: 'Google Meet' },
] as const;

export type WorkStatusId =
  | ''
  | 'pausa_banheiro'
  | 'pausa_almoco'
  | 'reuniao'
  | 'google_meet'
  | 'em_chamada';

export const DEFAULT_EVERYONE_PERMISSIONS = [
  'messages.send',
  'messages.delete_own',
  'voice.join',
  'screen.share',
] as const;

export const DEFAULT_ADMIN_PERMISSIONS = [
  ...DEFAULT_EVERYONE_PERMISSIONS,
  'live.go_live',
  'live.moderate_chat',
  'server.manage',
  'roles.manage',
  'members.kick',
  'members.assign_roles',
  'invites.manage',
  'join_requests.handle',
  'channels.create',
  'channels.edit',
  'channels.delete',
  'messages.delete_any',
] as const;

export const PERMISSION_GROUPS = [
  {
    group: 'Servidor',
    permissions: [
      { key: 'server.manage', label: 'Editar aparência e configurações' },
      { key: 'server.delete', label: 'Excluir servidor' },
      { key: 'roles.manage', label: 'Gerenciar cargos' },
      { key: 'members.kick', label: 'Expulsar membros' },
      { key: 'members.assign_roles', label: 'Atribuir cargos a membros' },
      { key: 'invites.manage', label: 'Criar convites' },
      { key: 'join_requests.handle', label: 'Responder solicitações de entrada' },
    ],
  },
  {
    group: 'Canais',
    permissions: [
      { key: 'channels.create', label: 'Criar canais' },
      { key: 'channels.edit', label: 'Editar canais' },
      { key: 'channels.delete', label: 'Excluir canais' },
      { key: 'channels.reorder', label: 'Reordenar canais' },
    ],
  },
  {
    group: 'Mensagens',
    permissions: [
      { key: 'messages.send', label: 'Enviar mensagens' },
      { key: 'messages.delete_own', label: 'Excluir próprias mensagens' },
      { key: 'messages.delete_any', label: 'Excluir mensagens de outros' },
    ],
  },
  {
    group: 'Voz e tela',
    permissions: [
      { key: 'voice.join', label: 'Entrar em canais de voz' },
      { key: 'screen.share', label: 'Compartilhar tela' },
      { key: 'live.go_live', label: 'Iniciar transmissão / link público' },
      { key: 'live.moderate_chat', label: 'Moderar chat da transmissão' },
    ],
  },
] as const;

export type PermissionKey = (typeof PERMISSION_GROUPS)[number]['permissions'][number]['key'];

export type ApiOk<T extends Record<string, unknown> = Record<string, unknown>> = {
  ok: true;
} & T;

export type ApiErr = { ok: false; error: string };

export type PublicUser = {
  id: number;
  username: string;
  label: string;
  avatar_url: string;
  ramal?: string;
  work_status?: string;
  steam_linked?: boolean;
  steam_id64?: string;
  steam_persona?: string;
  showcase_items?: unknown[];
};

export type AuthUser = {
  id: number;
  username: string;
  label: string;
  avatar_url: string;
  is_super: boolean;
  premium_themes?: boolean;
};

export type ChannelDto = {
  id: number;
  name: string;
  kind: 'text' | 'voice' | 'screen';
  position: number;
  icon_url: string;
};

export type ServerSummary = {
  id: number;
  name: string;
  owner_user_id: number;
  role: 'owner' | 'admin' | 'member';
  icon_url: string;
  banner_url: string;
  description: string;
  is_listed: boolean;
  created_at: number;
};

export type MessageDto = {
  id: number;
  channel_id: number;
  body: string;
  created_at: number;
  user: PublicUser;
  /** Mensagem de sistema (ex.: Partida Privada) — UI sem avatar. */
  system?: boolean;
};

/** Prefixo padrão SteamFarmReact: sfr — ASF legado sf-, WOULZ wm-/wmr-. */
export function voiceRoomName(
  serverId: number,
  channelId: number,
  prefix = 'sfr',
): string {
  const p = String(prefix || 'sfr')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 16) || 'sfr';
  return `${p}-${serverId}-ch-${channelId}`;
}

export function userIdentity(userId: number, prefix = 'sfr'): string {
  const p = String(prefix || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 8);
  return p ? `${p}-u${userId}` : `u${userId}`;
}

/** Aceita `sfr-u12`, `sf-u12`, `wmr-u12`, `wm-u12` ou `u12`. */
export function userIdFromIdentity(identity: string): number {
  const m = String(identity || '').match(/(?:^|-)u(\d+)$/i);
  return m ? Number(m[1]) : 0;
}
