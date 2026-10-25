"""Dump read-only do Postgres steamfarm (produção) → H:\\cs2teste\\_db_dumps\\steamfarm_prod.dump"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import paramiko

HOST = os.environ.get("SF_DEPLOY_HOST", "vps.example.com")
USER = os.environ.get("SF_DEPLOY_USER", "root")
PASSWORD = os.environ.get("SF_DEPLOY_PASS") or ""
if not PASSWORD:
    raise SystemExit("Defina SF_DEPLOY_PASS")

OUT_DIR = Path(r"H:\cs2teste\_db_dumps")
OUT_DIR.mkdir(parents=True, exist_ok=True)
REMOTE = "/tmp/steamfarm_prod.dump"
LOCAL = OUT_DIR / "steamfarm_prod.dump"

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(
    hostname=HOST,
    username=USER,
    password=PASSWORD,
    timeout=60,
    allow_agent=False,
    look_for_keys=False,
)


def run(cmd: str, timeout: int = 600) -> None:
    print(f"$ {cmd}")
    _i, out, err = client.exec_command(cmd, get_pty=True, timeout=timeout)
    text = out.read().decode("utf-8", errors="replace")
    etext = err.read().decode("utf-8", errors="replace")
    code = out.channel.recv_exit_status()
    if text:
        print(text[-3000:] if len(text) > 3000 else text)
    if etext.strip():
        print(etext[-1500:], file=sys.stderr)
    if code != 0:
        raise RuntimeError(f"exit {code}")


run(
    f"sudo -u postgres pg_dump -Fc --no-owner --no-acl -d steamfarm -f {REMOTE} && ls -lh {REMOTE}"
)
sftp = client.open_sftp()
sftp.get(REMOTE, str(LOCAL))
sftp.close()
run(f"rm -f {REMOTE}")
client.close()
print(f"OK {LOCAL} ({LOCAL.stat().st_size / 1024 / 1024:.2f} MB)")
