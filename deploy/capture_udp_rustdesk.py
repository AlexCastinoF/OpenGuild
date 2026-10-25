"""Capture UDP 21116 briefly while client should be heartbeating."""
from __future__ import annotations

import os
import sys

import paramiko

PASSWORD = os.environ.get("SF_DEPLOY_PASS") or ""


def main() -> int:
    if not PASSWORD:
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
    # 8s capture
    cmd = (
        "timeout 8 tcpdump -ni any udp port 21116 -c 20 2>&1 || true; "
        "echo ---; "
        "ss -ulnp | grep 21116; "
        "echo ---; "
        "docker logs hbbs --since 1m 2>&1 | tail -20"
    )
    _, stdout, stderr = c.exec_command(cmd, timeout=30)
    print(stdout.read().decode("utf-8", "replace"))
    print(stderr.read().decode("utf-8", "replace")[-1000:])
    c.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
