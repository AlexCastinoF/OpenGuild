"""Aplica SQL remoto + confirma RUSTDESK_* na VPS. Requer SF_DEPLOY_PASS."""
from __future__ import annotations

import os
import sys
from pathlib import Path

import paramiko

ROOT = Path(__file__).resolve().parent.parent
PASSWORD = os.environ.get("SF_DEPLOY_PASS") or ""
SQL = (ROOT / "deploy" / "add_remote_access.sql").read_text(encoding="utf-8")


def main() -> int:
    if not PASSWORD:
        print("Defina SF_DEPLOY_PASS", file=sys.stderr)
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
    sftp = c.open_sftp()
    with sftp.file("/tmp/add_remote_access.sql", "w") as f:
        f.write(SQL.replace("\r\n", "\n"))
    sftp.close()

    # DATABASE_URL from steamfarm-react .env
    cmd = r"""
set -e
cd /opt/steamfarm-react
set -a
. ./.env
set +a
# Prefer psql as postgres or via DATABASE_URL
if command -v psql >/dev/null; then
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f /tmp/add_remote_access.sql
else
  docker exec -i $(docker ps -qf name=postgres | head -1) psql -U postgres -d steamfarm -v ON_ERROR_STOP=1 < /tmp/add_remote_access.sql || \
  sudo -u postgres psql -d steamfarm -v ON_ERROR_STOP=1 -f /tmp/add_remote_access.sql
fi
grep -E '^RUSTDESK_' .env || true
echo SQL_OK
"""
    _, stdout, stderr = c.exec_command(cmd, timeout=120)
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    print(out)
    if err:
        print("STDERR:", err[-3000:])
    code = stdout.channel.recv_exit_status()
    c.close()
    return code


if __name__ == "__main__":
    raise SystemExit(main())
