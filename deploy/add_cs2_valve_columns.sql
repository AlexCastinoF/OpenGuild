-- CS2 Valve auto-enrich (Nest + Flask share users / cs2_match_shares)
ALTER TABLE users ADD COLUMN IF NOT EXISTS cs2_match_auth_enc TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS cs2_match_known_code VARCHAR(128) DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS cs2_match_auth_at DOUBLE PRECISION DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS cs2_auto_enrich BOOLEAN DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS cs2_last_auto_enrich_at DOUBLE PRECISION DEFAULT 0;

ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS steam_web_api_key_enc TEXT DEFAULT '';

CREATE TABLE IF NOT EXISTS cs2_match_shares (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  share_code VARCHAR(128) NOT NULL,
  fetched_at DOUBLE PRECISION NOT NULL DEFAULT 0,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cs2_share_user_code ON cs2_match_shares (user_id, share_code);
CREATE INDEX IF NOT EXISTS idx_cs2_match_shares_user_id ON cs2_match_shares (user_id);
CREATE INDEX IF NOT EXISTS idx_cs2_match_shares_share_code ON cs2_match_shares (share_code);
