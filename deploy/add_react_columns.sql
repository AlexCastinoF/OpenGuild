-- Additive schema for SteamFarm React on shared Postgres `steamfarm`.
-- NEVER DROP — Flask ASF tables (steam_accounts, zapo_*, billing, …) stay intact.
ALTER TABLE users ADD COLUMN IF NOT EXISTS ramal text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS work_status text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS work_status_changed_at double precision NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS steam_id64 text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS steam_persona text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS steam_avatar text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS steam_trade_url text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS steam_linked_at double precision NOT NULL DEFAULT 0;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='users' AND column_name='showcase_items'
  ) THEN
    ALTER TABLE users ADD COLUMN showcase_items jsonb NOT NULL DEFAULT '[]'::jsonb;
  END IF;
END $$;
ALTER TABLE users ADD COLUMN IF NOT EXISTS premium_themes boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_disabled boolean NOT NULL DEFAULT false;
-- Versão do token JWT: trocar a senha incrementa e derruba as sessões antigas
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version integer NOT NULL DEFAULT 0;

ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS register_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS register_max_per_ip integer NOT NULL DEFAULT 10;
ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS pabx_api_base text NOT NULL DEFAULT '';
ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS pabx_usuario text NOT NULL DEFAULT '';
ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS pabx_token text NOT NULL DEFAULT '';
ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS brand_name text NOT NULL DEFAULT 'SteamFarm Comunidade';
ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS brand_short_name text NOT NULL DEFAULT 'SteamFarm';
ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS brand_logo_url text NOT NULL DEFAULT '';
ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS brand_favicon_url text NOT NULL DEFAULT '';
ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS brand_app_icon_url text NOT NULL DEFAULT '';
ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS brand_app_ico_url text NOT NULL DEFAULT '';
ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS brand_revision integer NOT NULL DEFAULT 1;
ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS updated_at double precision NOT NULL DEFAULT 0;

-- Community servers (React admin / list)
ALTER TABLE community_servers ADD COLUMN IF NOT EXISTS is_blocked boolean NOT NULL DEFAULT false;

-- Role card / border styling (React)
ALTER TABLE community_roles ADD COLUMN IF NOT EXISTS member_card_color text;
ALTER TABLE community_roles ADD COLUMN IF NOT EXISTS border_color text;
ALTER TABLE community_roles ADD COLUMN IF NOT EXISTS border_effect text NOT NULL DEFAULT 'solid';
ALTER TABLE community_roles ADD COLUMN IF NOT EXISTS border_motion text NOT NULL DEFAULT 'none';
ALTER TABLE community_roles ADD COLUMN IF NOT EXISTS hoist boolean NOT NULL DEFAULT false;

-- Premium themes per user
CREATE TABLE IF NOT EXISTS user_themes (
  user_id integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  surfaces jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at double precision NOT NULL DEFAULT 0
);

-- Live sessions: colunas Flask NOT NULL sem default quebravam prisma.communityLiveSession.create
ALTER TABLE community_live_sessions ALTER COLUMN livekit_egress_id SET DEFAULT '';
ALTER TABLE community_live_sessions ALTER COLUMN chat_meta SET DEFAULT '{}'::jsonb;
UPDATE community_live_sessions SET livekit_egress_id = '' WHERE livekit_egress_id IS NULL;
UPDATE community_live_sessions SET chat_meta = '{}'::jsonb WHERE chat_meta IS NULL;

INSERT INTO site_settings (id, register_enabled, register_max_per_ip, pabx_api_base, pabx_usuario, pabx_token, updated_at)
VALUES (1, true, 10, '', '', '', extract(epoch from now()))
ON CONFLICT (id) DO NOTHING;

-- AUTO-SYNC FROM PRISMA (additive only; never DROP)
-- nothing to add

-- GRANTS FOR APP ROLE steamfarm

-- Ensure app role can use React tables created as postgres
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'steamfarm') THEN
    GRANT USAGE ON SCHEMA public TO steamfarm;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='users') THEN
    ALTER TABLE public.users OWNER TO steamfarm;
    GRANT ALL ON TABLE public.users TO steamfarm;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='site_settings') THEN
    ALTER TABLE public.site_settings OWNER TO steamfarm;
    GRANT ALL ON TABLE public.site_settings TO steamfarm;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='community_servers') THEN
    ALTER TABLE public.community_servers OWNER TO steamfarm;
    GRANT ALL ON TABLE public.community_servers TO steamfarm;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='community_members') THEN
    ALTER TABLE public.community_members OWNER TO steamfarm;
    GRANT ALL ON TABLE public.community_members TO steamfarm;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='community_roles') THEN
    ALTER TABLE public.community_roles OWNER TO steamfarm;
    GRANT ALL ON TABLE public.community_roles TO steamfarm;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='community_member_roles') THEN
    ALTER TABLE public.community_member_roles OWNER TO steamfarm;
    GRANT ALL ON TABLE public.community_member_roles TO steamfarm;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='community_invites') THEN
    ALTER TABLE public.community_invites OWNER TO steamfarm;
    GRANT ALL ON TABLE public.community_invites TO steamfarm;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='community_channels') THEN
    ALTER TABLE public.community_channels OWNER TO steamfarm;
    GRANT ALL ON TABLE public.community_channels TO steamfarm;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='community_messages') THEN
    ALTER TABLE public.community_messages OWNER TO steamfarm;
    GRANT ALL ON TABLE public.community_messages TO steamfarm;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='community_join_requests') THEN
    ALTER TABLE public.community_join_requests OWNER TO steamfarm;
    GRANT ALL ON TABLE public.community_join_requests TO steamfarm;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='community_dm_messages') THEN
    ALTER TABLE public.community_dm_messages OWNER TO steamfarm;
    GRANT ALL ON TABLE public.community_dm_messages TO steamfarm;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='community_live_sessions') THEN
    ALTER TABLE public.community_live_sessions OWNER TO steamfarm;
    GRANT ALL ON TABLE public.community_live_sessions TO steamfarm;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='community_trades') THEN
    ALTER TABLE public.community_trades OWNER TO steamfarm;
    GRANT ALL ON TABLE public.community_trades TO steamfarm;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='user_stream_accounts') THEN
    ALTER TABLE public.user_stream_accounts OWNER TO steamfarm;
    GRANT ALL ON TABLE public.user_stream_accounts TO steamfarm;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='user_wa_sessions') THEN
    ALTER TABLE public.user_wa_sessions OWNER TO steamfarm;
    GRANT ALL ON TABLE public.user_wa_sessions TO steamfarm;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='user_whatsapp') THEN
    ALTER TABLE public.user_whatsapp OWNER TO steamfarm;
    GRANT ALL ON TABLE public.user_whatsapp TO steamfarm;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='user_themes') THEN
    ALTER TABLE public.user_themes OWNER TO steamfarm;
    GRANT ALL ON TABLE public.user_themes TO steamfarm;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
             WHERE n.nspname='public' AND c.relkind='S' AND c.relname LIKE '%_id_seq') THEN
    GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO steamfarm;
  END IF;
EXCEPTION WHEN OTHERS THEN
  GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO steamfarm;
END $$;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO steamfarm;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO steamfarm;

-- Remote access (RustDesk)
ALTER TABLE users ADD COLUMN IF NOT EXISTS rustdesk_id text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS rustdesk_seen_at double precision NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS remote_access_sessions (
  id text PRIMARY KEY,
  server_id integer NOT NULL,
  requester_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  direction text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  host_user_id integer NOT NULL DEFAULT 0,
  controller_user_id integer NOT NULL DEFAULT 0,
  host_rustdesk_id text NOT NULL DEFAULT '',
  session_password_enc text NOT NULL DEFAULT '',
  expires_at double precision NOT NULL,
  created_at double precision NOT NULL,
  updated_at double precision NOT NULL
);

CREATE INDEX IF NOT EXISTS remote_access_sessions_requester_status_idx
  ON remote_access_sessions (requester_id, status);
CREATE INDEX IF NOT EXISTS remote_access_sessions_target_status_idx
  ON remote_access_sessions (target_id, status);
CREATE INDEX IF NOT EXISTS remote_access_sessions_status_expires_idx
  ON remote_access_sessions (status, expires_at);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='remote_access_sessions') THEN
    ALTER TABLE public.remote_access_sessions OWNER TO steamfarm;
    GRANT ALL ON TABLE public.remote_access_sessions TO steamfarm;
  END IF;
END $$;

-- Private match rating + per-map winrate (radar)
CREATE TABLE IF NOT EXISTS private_match_ratings (
  user_id integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  rating integer NOT NULL DEFAULT 0,
  updated_at double precision NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS private_match_map_stats (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  map varchar(64) NOT NULL,
  wins integer NOT NULL DEFAULT 0,
  losses integer NOT NULL DEFAULT 0,
  updated_at double precision NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_pm_map_stat_user_map
  ON private_match_map_stats (user_id, map);
CREATE INDEX IF NOT EXISTS private_match_map_stats_user_id_idx
  ON private_match_map_stats (user_id);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='private_match_ratings') THEN
    ALTER TABLE public.private_match_ratings OWNER TO steamfarm;
    GRANT ALL ON TABLE public.private_match_ratings TO steamfarm;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='private_match_map_stats') THEN
    ALTER TABLE public.private_match_map_stats OWNER TO steamfarm;
    GRANT ALL ON TABLE public.private_match_map_stats TO steamfarm;
    GRANT USAGE, SELECT ON SEQUENCE private_match_map_stats_id_seq TO steamfarm;
  END IF;
END $$;

