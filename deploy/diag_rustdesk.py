"""Diagnose RustDesk hbbs peer registration."""
from __future__ import annotations

import os
import sys

import paramiko

PASSWORD = os.environ.get("SF_DEPLOY_PASS") or ""


def main() -> int:
    if not PASSWORD:
        print("missing pass", file=sys.stderr)
        return 2
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(
        "vps.example.com",
        username="root",
        password=PASSWORD,
        timeout=45,
        look_for_keys=False,
        allow_agent=False,
    )
    script = r"""
set -e
echo '=== logs ==='
docker logs hbbs --since 5m 2>&1 | tail -60
echo '=== db ==='
python3 - <<'PY'
import sqlite3
con = sqlite3.connect('/opt/rustdesk/data/db_v2.sqlite3')
tables = [r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")]
print('tables', tables)
for t in tables:
    try:
        cols = [d[1] for d in con.execute(f'PRAGMA table_info({t})')]
        print(t, 'cols', cols)
        rows = con.execute(f'SELECT * FROM {t} LIMIT 20').fetchall()
        print(t, 'rows', len(rows))
        for r in rows[:10]:
            print(' ', r)
    except Exception as e:
        print(t, e)
PY
"""
    _, stdout, stderr = c.exec_command(script, timeout=60)
    print(stdout.read().decode("utf-8", "replace"))
    err = stderr.read().decode("utf-8", "replace")
    if err.strip():
        print("STDERR", err[-2000:])
    c.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
