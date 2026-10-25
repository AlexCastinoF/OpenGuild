-- Remote access (RustDesk) — additive
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
