#!/usr/bin/env python3
"""Migrate Flask steamfarmmeeting → React steamfarm_react using only psql (no pip)."""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

FLASK_DB = "steamfarmmeeting"
REACT_DB = "steamfarm_react"
FLASK_DATA = Path("/opt/steamfarmmeeting/data")
REACT_UPLOADS = Path("/opt/steamfarm-react/apps/api/uploads")
BACKUP_DIR = Path("/tmp")


def psql(db: str, sql: str, *args: str) -> str:
    cmd = ["sudo", "-u", "postgres", "psql", "-d", db, "-v", "ON_ERROR_STOP=1", "-At"]
    if args:
        # not used
        pass
    p = subprocess.run(cmd + ["-c", sql], capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError(f"psql {db} failed:\n{p.stderr}\nSQL={sql[:200]}")
    return p.stdout


def main() -> int:
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup = BACKUP_DIR / f"steamfarm_react_before_migrate_{stamp}.sql"
    print(f"backup → {backup}")
    subprocess.check_call(
        ["sudo", "-u", "postgres", "pg_dump", "-d", REACT_DB, "-f", str(backup)]
    )
    # keep a root-readable copy
    root_copy = Path("/root") / backup.name
    shutil.copy2(backup, root_copy)
    print(f"backup copy → {root_copy}")

    print("truncate react")
    psql(
        REACT_DB,
        """
TRUNCATE TABLE
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

    # Stage via temp tables in postgres using dblink? Simpler: dump CSV to /tmp and copy.
    tmp = Path("/tmp/sf_migrate")
    if tmp.exists():
        shutil.rmtree(tmp)
    tmp.mkdir(parents=True)

    def export_copy(sql: str, file: Path):
        # Use COPY TO PROGRAM or file owned by postgres
        out = Path("/tmp") / file.name
        if out.exists():
            out.unlink()
        psql(FLASK_DB, f"COPY ({sql}) TO '{out}' WITH (FORMAT csv, HEADER false, NULL '')")
        subprocess.check_call(["chmod", "644", str(out)])
        return out

    # users
    f = export_copy(
        """
        SELECT id, username, password_hash, role,
               COALESCE(display_name,''), COALESCE(avatar_url,''),
               COALESCE(ramal,''), COALESCE(work_status,''),
               0::float8, created_at
        FROM users ORDER BY id
        """,
        tmp / "users.csv",
    )
    psql(
        REACT_DB,
        f"""
COPY users (
  id, username, password_hash, role, display_name, avatar_url,
  ramal, work_status, work_status_changed_at, created_at
) FROM '{f}' WITH (FORMAT csv, NULL '');
""",
    )
    print("users", psql(REACT_DB, "SELECT COUNT(*) FROM users").strip())

    f = export_copy(
        """
        SELECT id, register_enabled, register_max_per_ip,
               COALESCE(pabx_api_base,''), COALESCE(pabx_usuario,''),
               COALESCE(pabx_token,''), updated_at
        FROM site_settings ORDER BY id
        """,
        tmp / "site.csv",
    )
    psql(
        REACT_DB,
        f"""
COPY site_settings (
  id, register_enabled, register_max_per_ip, pabx_api_base, pabx_usuario, pabx_token, updated_at
) FROM '{f}' WITH (FORMAT csv, NULL '');
""",
    )

    f = export_copy(
        """
        SELECT id, name, owner_user_id,
               COALESCE(icon_url,''), COALESCE(banner_url,''),
               COALESCE(description,''), COALESCE(is_listed,false),
               false, created_at
        FROM community_servers ORDER BY id
        """,
        tmp / "servers.csv",
    )
    psql(
        REACT_DB,
        f"""
COPY community_servers (
  id, name, owner_user_id, icon_url, banner_url, description, is_listed, is_blocked, created_at
) FROM '{f}' WITH (FORMAT csv, NULL '');
""",
    )
    print("servers", psql(REACT_DB, "SELECT COUNT(*) FROM community_servers").strip())

    simple = [
        (
            "community_members",
            "id, server_id, user_id, role, joined_at",
            "id, server_id, user_id, role, joined_at",
        ),
        (
            "community_channels",
            "id, server_id, name, kind, COALESCE(icon_url,''), position, created_at",
            "id, server_id, name, kind, icon_url, position, created_at",
        ),
        (
            "community_member_roles",
            "id, server_id, user_id, role_id, assigned_at",
            "id, server_id, user_id, role_id, assigned_at",
        ),
        (
            "community_invites",
            "id, server_id, code, created_by, created_at, expires_at, max_uses, uses",
            "id, server_id, code, created_by, created_at, expires_at, max_uses, uses",
        ),
        (
            "community_messages",
            "id, channel_id, user_id, body, created_at",
            "id, channel_id, user_id, body, created_at",
        ),
        (
            "community_join_requests",
            "id, server_id, user_id, COALESCE(message,''), status, created_at, handled_by, handled_at",
            "id, server_id, user_id, message, status, created_at, handled_by, handled_at",
        ),
        (
            "community_dm_messages",
            "id, from_user_id, to_user_id, server_id, join_request_id, body, created_at, read_at",
            "id, from_user_id, to_user_id, server_id, join_request_id, body, created_at, read_at",
        ),
    ]
    for table, sel, cols in simple:
        f = export_copy(f"SELECT {sel} FROM {table} ORDER BY id", tmp / f"{table}.csv")
        psql(
            REACT_DB,
            f"COPY {table} ({cols}) FROM '{f}' WITH (FORMAT csv, NULL '');",
        )
        print(table, psql(REACT_DB, f"SELECT COUNT(*) FROM {table}").strip())

    # roles with jsonb — export permissions as json text
    f = export_copy(
        """
        SELECT id, server_id, name, color, position, hoist,
               member_card_color,
               COALESCE(permissions::text, '[]'),
               is_default, created_at
        FROM community_roles ORDER BY id
        """,
        tmp / "roles.csv",
    )
    psql(
        REACT_DB,
        f"""
COPY community_roles (
  id, server_id, name, color, position, hoist, member_card_color, permissions, is_default, created_at
) FROM '{f}' WITH (FORMAT csv, NULL '');
""",
    )
    print("roles", psql(REACT_DB, "SELECT COUNT(*) FROM community_roles").strip())

    # live sessions with room rename via SQL on insert from staging
    f = export_copy(
        """
        SELECT id, server_id, channel_id, user_id, title, status,
               CASE
                 WHEN livekit_room LIKE 'wm-%' AND livekit_room NOT LIKE 'wmr-%'
                   THEN 'wmr-' || substr(livekit_room, 4)
                 ELSE COALESCE(livekit_room,'')
               END,
               COALESCE(watch_slug,''),
               public_watch_enabled, public_watch_max,
               public_watch_custom_names, public_watch_chat_enabled,
               public_watch_chat_guest_post, started_at, ended_at
        FROM community_live_sessions ORDER BY id
        """,
        tmp / "live.csv",
    )
    # table may be empty
    n = psql(FLASK_DB, "SELECT COUNT(*) FROM community_live_sessions").strip()
    if n != "0":
        psql(
            REACT_DB,
            f"""
COPY community_live_sessions (
  id, server_id, channel_id, user_id, title, status, livekit_room, watch_slug,
  public_watch_enabled, public_watch_max, public_watch_custom_names,
  public_watch_chat_enabled, public_watch_chat_guest_post, started_at, ended_at
) FROM '{f}' WITH (FORMAT csv, NULL '');
""",
        )
    print("live_sessions", psql(REACT_DB, "SELECT COUNT(*) FROM community_live_sessions").strip())

    for table in [
        "users",
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
    ]:
        psql(
            REACT_DB,
            f"""
SELECT setval(
  pg_get_serial_sequence('{table}', 'id'),
  COALESCE((SELECT MAX(id) FROM {table}), 1),
  true
);
""",
        )

    # media
    REACT_UPLOADS.mkdir(parents=True, exist_ok=True)
    for src_sub, dst_sub in [
        (FLASK_DATA / "avatars", REACT_UPLOADS / "avatars"),
        (FLASK_DATA / "community", REACT_UPLOADS / "community"),
    ]:
        dst_sub.mkdir(parents=True, exist_ok=True)
        n = 0
        if src_sub.exists():
            for p in src_sub.iterdir():
                if p.is_file():
                    shutil.copy2(p, dst_sub / p.name)
                    n += 1
        print(f"media {src_sub.name}: {n} files")

    subprocess.call(
        ["chown", "-R", "steamfarmmeetingreact:steamfarmmeetingreact", str(REACT_UPLOADS)]
    )
    subprocess.check_call(["systemctl", "restart", "steamfarm-react"])
    print("active:", subprocess.check_output(["systemctl", "is-active", "steamfarm-react"], text=True).strip())
    print("DONE")
    print("Login: https://localhost:5174 with same users/passwords as localhost:5174")
    print(f"Backup: {backup}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as e:
        print("FAIL:", e, file=sys.stderr)
        raise
