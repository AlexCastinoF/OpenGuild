#!/usr/bin/env python3
"""Migrate steamfarm_prod_ref (dump ASF) → steamfarm_react (Prisma) — Windows local.

Uso:
  python scripts/migrate_from_prod_ref.py

Não toca produção. Requer Postgres local com ambos os DBs.
"""
from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path

PG_BIN = Path(os.environ.get("PG_BIN", r"H:\PostGreSQL\bin"))
PSQL = str(PG_BIN / "psql.exe")
SRC = os.environ.get("SRC_DB", "steamfarm_prod_ref")
DST = os.environ.get("DST_DB", "steamfarm_react")
USER = os.environ.get("PGUSER", "postgres")


def psql(db: str, sql: str) -> str:
    p = subprocess.run(
        [PSQL, "-U", USER, "-d", db, "-v", "ON_ERROR_STOP=1", "-At", "-c", sql],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if p.returncode != 0:
        raise RuntimeError(f"psql {db} failed:\n{p.stderr}\nSQL={sql[:240]}")
    return p.stdout


def copy_out(db: str, select_sql: str) -> str:
    """COPY (SELECT ...) TO STDOUT CSV."""
    sql = f"COPY ({select_sql}) TO STDOUT WITH (FORMAT csv, NULL '')"
    p = subprocess.run(
        [PSQL, "-U", USER, "-d", db, "-v", "ON_ERROR_STOP=1", "-c", sql],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if p.returncode != 0:
        raise RuntimeError(f"COPY OUT failed:\n{p.stderr}\nSQL={select_sql[:240]}")
    return p.stdout


def copy_in(db: str, table_cols: str, csv_data: str) -> None:
    if not csv_data.strip():
        return
    p = subprocess.run(
        [
            PSQL,
            "-U",
            USER,
            "-d",
            db,
            "-v",
            "ON_ERROR_STOP=1",
            "-c",
            f"COPY {table_cols} FROM STDIN WITH (FORMAT csv, NULL '')",
        ],
        input=csv_data,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if p.returncode != 0:
        raise RuntimeError(f"COPY IN {table_cols} failed:\n{p.stderr}")


def count(db: str, table: str) -> str:
    return psql(db, f"SELECT COUNT(*) FROM {table}").strip()


def main() -> int:
    if not Path(PSQL).exists():
        raise SystemExit(f"psql não encontrado: {PSQL}")

    print(f"SRC={SRC} → DST={DST}")
    print("truncate dest…")
    psql(
        DST,
        """
TRUNCATE TABLE
  user_whatsapp,
  user_wa_sessions,
  user_stream_accounts,
  community_trades,
  community_live_sessions,
  community_dm_messages,
  community_join_requests,
  community_messages,
  community_invites,
  community_member_roles,
  community_roles,
  community_channels,
  community_members,
  community_servers,
  site_settings,
  users
RESTART IDENTITY CASCADE;
""",
    )

    # users: ASF com steam_*; admin_client permanece
    data = copy_out(
        SRC,
        """
        SELECT id, username, password_hash, role,
               COALESCE(display_name,''), COALESCE(avatar_url,''),
               ''::text, ''::text, 0::float8,
               COALESCE(steam_id64,''), COALESCE(steam_persona,''),
               COALESCE(steam_avatar,''), COALESCE(steam_trade_url,''),
               COALESCE(steam_linked_at,0),
               COALESCE(showcase_items::text, '[]'),
               created_at
        FROM users ORDER BY id
        """,
    )
    copy_in(
        DST,
        """users (
  id, username, password_hash, role, display_name, avatar_url,
  ramal, work_status, work_status_changed_at,
  steam_id64, steam_persona, steam_avatar, steam_trade_url, steam_linked_at,
  showcase_items, created_at
)""",
        data,
    )
    print("users", count(DST, "users"))

    # site_settings ASF sem pabx → defaults vazios
    now = time.time()
    data = copy_out(
        SRC,
        f"""
        SELECT id, register_enabled, register_max_per_ip,
               ''::text, ''::text, ''::text, updated_at
        FROM site_settings ORDER BY id
        """,
    )
    if not data.strip():
        data = f"1,t,10,\"\",\"\",\"\",{now}\n"
    copy_in(
        DST,
        "site_settings (id, register_enabled, register_max_per_ip, pabx_api_base, pabx_usuario, pabx_token, updated_at)",
        data,
    )
    print("site_settings", count(DST, "site_settings"))

    data = copy_out(
        SRC,
        """
        SELECT id, name, owner_user_id,
               COALESCE(icon_url,''), COALESCE(banner_url,''),
               COALESCE(description,''), COALESCE(is_listed,false),
               false, created_at
        FROM community_servers ORDER BY id
        """,
    )
    copy_in(
        DST,
        "community_servers (id, name, owner_user_id, icon_url, banner_url, description, is_listed, is_blocked, created_at)",
        data,
    )
    print("servers", count(DST, "community_servers"))

    simple = [
        (
            "community_members",
            "SELECT id, server_id, user_id, role, joined_at FROM community_members ORDER BY id",
            "community_members (id, server_id, user_id, role, joined_at)",
        ),
        (
            "community_channels",
            "SELECT id, server_id, name, kind, COALESCE(icon_url,''), position, created_at FROM community_channels ORDER BY id",
            "community_channels (id, server_id, name, kind, icon_url, position, created_at)",
        ),
        (
            "community_roles",
            """SELECT id, server_id, name, color, position, hoist,
                      NULLIF(member_card_color,''),
                      COALESCE(permissions::text, '[]'),
                      is_default, created_at
               FROM community_roles ORDER BY id""",
            "community_roles (id, server_id, name, color, position, hoist, member_card_color, permissions, is_default, created_at)",
        ),
        (
            "community_member_roles",
            "SELECT id, server_id, user_id, role_id, assigned_at FROM community_member_roles ORDER BY id",
            "community_member_roles (id, server_id, user_id, role_id, assigned_at)",
        ),
        (
            "community_invites",
            "SELECT id, server_id, code, created_by, created_at, expires_at, max_uses, uses FROM community_invites ORDER BY id",
            "community_invites (id, server_id, code, created_by, created_at, expires_at, max_uses, uses)",
        ),
        (
            "community_messages",
            "SELECT id, channel_id, user_id, body, created_at FROM community_messages ORDER BY id",
            "community_messages (id, channel_id, user_id, body, created_at)",
        ),
        (
            "community_join_requests",
            "SELECT id, server_id, user_id, COALESCE(message,''), status, created_at, handled_by, handled_at FROM community_join_requests ORDER BY id",
            "community_join_requests (id, server_id, user_id, message, status, created_at, handled_by, handled_at)",
        ),
        (
            "community_dm_messages",
            "SELECT id, from_user_id, to_user_id, server_id, join_request_id, body, created_at, read_at FROM community_dm_messages ORDER BY id",
            "community_dm_messages (id, from_user_id, to_user_id, server_id, join_request_id, body, created_at, read_at)",
        ),
    ]
    for label, sel, cols in simple:
        data = copy_out(SRC, sel)
        copy_in(DST, cols, data)
        print(label, count(DST, label))

    # live sessions: sf-/wm- → sfr- quando fizer sentido; ASF usa rooms do farm
    data = copy_out(
        SRC,
        """
        SELECT id, server_id, channel_id, user_id, title, status,
               CASE
                 WHEN livekit_room LIKE 'sf-%' AND livekit_room NOT LIKE 'sfr-%'
                   THEN 'sfr-' || substr(livekit_room, 4)
                 WHEN livekit_room LIKE 'wm-%' AND livekit_room NOT LIKE 'wmr-%'
                   THEN 'sfr-' || substr(livekit_room, 4)
                 WHEN livekit_room LIKE 'wmr-%'
                   THEN 'sfr-' || substr(livekit_room, 5)
                 ELSE COALESCE(livekit_room,'')
               END,
               COALESCE(watch_slug,''),
               COALESCE(public_watch_enabled,false),
               COALESCE(public_watch_max,50),
               COALESCE(public_watch_custom_names,true),
               COALESCE(public_watch_chat_enabled,false),
               COALESCE(public_watch_chat_guest_post,false),
               started_at, ended_at
        FROM community_live_sessions ORDER BY id
        """,
    )
    copy_in(
        DST,
        """community_live_sessions (
  id, server_id, channel_id, user_id, title, status, livekit_room, watch_slug,
  public_watch_enabled, public_watch_max, public_watch_custom_names,
  public_watch_chat_enabled, public_watch_chat_guest_post, started_at, ended_at
)""",
        data,
    )
    print("live_sessions", count(DST, "community_live_sessions"))

    data = copy_out(
        SRC,
        """
        SELECT id, proposer_user_id, partner_user_id, status, COALESCE(message,''),
               COALESCE(proposer_items::text, '[]'), COALESCE(partner_items::text, '[]'),
               proposer_accepted, partner_accepted, sender_user_id,
               COALESCE(steam_tradeofferid,''), COALESCE(steam_offer_url,''),
               COALESCE(steam_error,''), created_at, updated_at, completed_at
        FROM community_trades ORDER BY id
        """,
    )
    copy_in(
        DST,
        """community_trades (
  id, proposer_user_id, partner_user_id, status, message,
  proposer_items, partner_items, proposer_accepted, partner_accepted, sender_user_id,
  steam_tradeofferid, steam_offer_url, steam_error, created_at, updated_at, completed_at
)""",
        data,
    )
    print("trades", count(DST, "community_trades"))

    data = copy_out(
        SRC,
        """
        SELECT user_id, provider,
               COALESCE(provider_user_id,''), COALESCE(login,''), COALESCE(display_name,''),
               COALESCE(avatar_url,''), COALESCE(access_token_enc,''), COALESCE(refresh_token_enc,''),
               COALESCE(stream_key_enc,''), COALESCE(scopes,''),
               COALESCE(linked_at,0), COALESCE(expires_at,0)
        FROM user_stream_accounts ORDER BY user_id, provider
        """,
    )
    copy_in(
        DST,
        """user_stream_accounts (
  user_id, provider, provider_user_id, login, display_name, avatar_url,
  access_token_enc, refresh_token_enc, stream_key_enc, scopes, linked_at, expires_at
)""",
        data,
    )
    print("stream_accounts", count(DST, "user_stream_accounts"))

    data = copy_out(
        SRC,
        """
        SELECT id, user_id, slot, session_id,
               COALESCE(me_jid,''), COALESCE(push_name,''), COALESCE(status,'idle'),
               COALESCE(crypto_salt,''), COALESCE(crypto_verifier,''),
               COALESCE(archived_groups::text, '[]'),
               created_at, updated_at
        FROM user_wa_sessions ORDER BY id
        """,
    )
    copy_in(
        DST,
        """user_wa_sessions (
  id, user_id, slot, session_id, me_jid, push_name, status,
  crypto_salt, crypto_verifier, archived_groups, created_at, updated_at
)""",
        data,
    )
    print("wa_sessions", count(DST, "user_wa_sessions"))

    data = copy_out(
        SRC,
        """
        SELECT user_id, COALESCE(phone,''), COALESCE(enabled,false),
               COALESCE(events::text, '{}')
        FROM user_whatsapp ORDER BY user_id
        """,
    )
    copy_in(
        DST,
        "user_whatsapp (user_id, phone, enabled, events)",
        data,
    )
    print("user_whatsapp", count(DST, "user_whatsapp"))

    for table in [
        "users",
        "site_settings",
        "community_servers",
        "community_members",
        "community_channels",
        "community_roles",
        "community_member_roles",
        "community_invites",
        "community_messages",
        "community_join_requests",
        "community_dm_messages",
        "community_live_sessions",
        "community_trades",
        "user_wa_sessions",
    ]:
        psql(
            DST,
            f"""
SELECT setval(
  pg_get_serial_sequence('{table}', 'id'),
  COALESCE((SELECT MAX(id) FROM {table}), 1),
  true
);
""",
        )

    print("DONE")
    print("Login: http://127.0.0.1:5174 com os mesmos usuários/senhas da Comunidade ASF")
    print("Super admins: role=super_admin (2 na produção)")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as e:
        print("FAIL:", e, file=sys.stderr)
        raise
