"""Check UDP 21116 and force a client-visible hbbs -r restart."""
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
    script = r'''
set -e
echo "=== ufw ==="
ufw status | grep -E '2111|Status' || true
echo "=== iptables udp 21116 ==="
iptables -L INPUT -n | grep 21116 || true
iptables -L INPUT -n | head -20
echo "=== rewrite compose with -r ==="
cat > /opt/rustdesk/docker-compose.yml <<'EOF'
services:
  hbbr:
    container_name: hbbr
    image: rustdesk/rustdesk-server:latest
    command: hbbr
    volumes:
      - ./data:/root
    network_mode: "host"
    restart: unless-stopped

  hbbs:
    container_name: hbbs
    image: rustdesk/rustdesk-server:latest
    command: hbbs -r vps.example.com
    volumes:
      - ./data:/root
    network_mode: "host"
    depends_on:
      - hbbr
    restart: unless-stopped
EOF
cd /opt/rustdesk
docker compose up -d --force-recreate
sleep 2
docker compose ps
docker logs hbbs --tail 15 2>&1
echo "=== pub key ==="
cat /opt/rustdesk/data/id_ed25519.pub
'''
    _, stdout, stderr = c.exec_command(script, timeout=120)
    print(stdout.read().decode("utf-8", "replace"))
    err = stderr.read().decode("utf-8", "replace")
    if err.strip():
        print("STDERR", err[-2500:])
    c.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
