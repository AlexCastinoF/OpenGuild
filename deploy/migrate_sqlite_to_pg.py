#!/usr/bin/env python3
"""Copia dados do SQLite (legado) para o Postgres do SteamFarmMeeting React."""
from __future__ import annotations

import os
import sqlite3
import sys

try:
    import psycopg2
    from psycopg2.extras import execute_values
except ImportError:
    print("MIGRATE_SKIP: psycopg2 não instalado")
    raise SystemExit(0)

SQLITE_PATH = os.environ.get("WMR_SQLITE_PATH", "")
PG_URL = os.environ.get("DATABASE_URL", "")

# Ordem respeitando FKs
TABLES = [
    "users",
    "site_settings",
    "community_servers",
    "community_members",
    "community_roles",
    "community_member_roles",
    "community_invites",
    "community_channels",
    "community_messages",
    "community_join_requests",
    "community_dm_messages",
    "community_live_sessions",
]


def pg_connect(url: str):
    # prisma usa postgresql://…?schema=public
    clean = url.split("?")[0].replace("postgresql://", "postgres://", 1)
    return psycopg2.connect(clean)


BOOL_TABLES = {
    "site_settings": {"register_enabled"},
    "community_servers": {"is_listed", "is_blocked"},
    "community_roles": {"hoist", "is_default"},
    "community_live_sessions": {
        "public_watch_enabled",
        "public_watch_custom_names",
        "public_watch_chat_enabled",
        "public_watch_chat_guest_post",
    },
}


def coerce(table: str, col: str, val):
    if table in BOOL_TABLES and col in BOOL_TABLES[table]:
        if val is None:
            return False
        if isinstance(val, bool):
            return val
        return bool(int(val))
    return val


def main() -> int:
    if not SQLITE_PATH or not os.path.isfile(SQLITE_PATH):
        print("MIGRATE_SKIP: sqlite ausente")
        return 0
    if not PG_URL or PG_URL.startswith("file:"):
        print("MIGRATE_SKIP: DATABASE_URL não é Postgres")
        return 0

    sq = sqlite3.connect(SQLITE_PATH)
    sq.row_factory = sqlite3.Row
    pg = pg_connect(PG_URL)
    pg.autocommit = False
    cur = pg.cursor()

    copied = 0
    for table in TABLES:
        try:
            rows = sq.execute(f'SELECT * FROM "{table}"').fetchall()
        except sqlite3.OperationalError:
            continue
        if not rows:
            continue
        cols = [d[0] for d in sq.execute(f'SELECT * FROM "{table}" LIMIT 0').description]
        cur.execute(f'SELECT COUNT(*) FROM "{table}"')
        existing = cur.fetchone()[0]
        if existing:
            print(f"MIGRATE_KEEP: {table} já tem {existing} linha(s)")
            continue
        values = [tuple(coerce(table, c, r[c]) for c in cols) for r in rows]
        col_list = ", ".join(f'"{c}"' for c in cols)
        sql = f'INSERT INTO "{table}" ({col_list}) VALUES %s'
        try:
            execute_values(cur, sql, values)
            copied += len(values)
            print(f"MIGRATE_OK: {table} ← {len(values)}")
        except Exception as exc:
            pg.rollback()
            print(f"MIGRATE_ERR: {table}: {exc}", file=sys.stderr)
            sq.close()
            cur.close()
            pg.close()
            return 1

    for table in TABLES:
        try:
            cur.execute(
                f"""
                SELECT setval(
                  pg_get_serial_sequence('"{table}"', 'id'),
                  COALESCE((SELECT MAX(id) FROM "{table}"), 1),
                  true
                )
                """
            )
        except Exception:
            pg.rollback()
            continue

    pg.commit()
    sq.close()
    cur.close()
    pg.close()
    print(f"MIGRATE_DONE rows={copied}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
