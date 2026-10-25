"""Garante location /api/match-packs em TODOS os server blocks do farmsteam."""
from __future__ import annotations

import os
import sys
from pathlib import Path

import paramiko

ROOT = Path(__file__).resolve().parent.parent
for p in (ROOT / ".env", ROOT.parent / "archi-steam-farm-py" / ".env", Path.home() / ".steamfarm-deploy.env"):
    if p.is_file():
        for line in p.read_text(encoding="utf-8", errors="ignore").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

HOST = os.environ.get("SF_DEPLOY_HOST", "vps.example.com")
USER = os.environ.get("SF_DEPLOY_USER", "root")
PASS = os.environ.get("SF_DEPLOY_PASS") or os.environ.get("WM_DEPLOY_PASS")
if not PASS:
    print("SF_DEPLOY_PASS missing", file=sys.stderr)
    raise SystemExit(1)

REMOTE = r'''
python3 << 'PY'
from pathlib import Path
import re, subprocess

p = Path("/etc/nginx/sites-available/steamfarm")
text = p.read_text(errors="replace")
block = (
    "    location ^~ /api/match-packs {\n"
    "        proxy_pass http://127.0.0.1:5071;\n"
    "        proxy_http_version 1.1;\n"
    "        proxy_set_header Host $host;\n"
    "        proxy_set_header X-Real-IP $remote_addr;\n"
    "        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n"
    "        proxy_set_header X-Forwarded-Proto $scheme;\n"
    "        proxy_read_timeout 120s;\n"
    "    }\n\n"
)
# Inserir no bloco 443, antes do location / desse bloco
ssl_idx = text.find("listen 443")
if ssl_idx < 0:
    raise SystemExit("no 443 listen")
# se o bloco 443 ja tem match-packs, skip
ssl_part = text[ssl_idx:]
if "location ^~ /api/match-packs" in ssl_part:
    print("SSL_ALREADY")
else:
    needle = "    location / {"
    pos = text.find(needle, ssl_idx)
    if pos < 0:
        raise SystemExit("no location / in 443")
    text = text[:pos] + block + text[pos:]
    p.write_text(text)
    print("SSL_PATCHED")
subprocess.check_call(["nginx", "-t"])
subprocess.check_call(["systemctl", "reload", "nginx"])
print("NGX_OK")
PY
echo -n 'farm: '
curl -sS -m 8 -o /tmp/mp-farm.json -w '%{http_code}' https://vps.example.com/api/match-packs/1.4.4
echo
head -c 200 /tmp/mp-farm.json
echo
curl -sI -m 8 https://vps.example.com/api/match-packs/1.4.4 | head -12
'''


def main() -> int:
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, username=USER, password=PASS, timeout=45, allow_agent=False, look_for_keys=False)
    _i, stdout, stderr = client.exec_command(REMOTE, timeout=60)
    out = stdout.read().decode("utf-8", errors="replace")
    err = stderr.read().decode("utf-8", errors="replace")
    sys.stdout.write(out.encode("ascii", "replace").decode("ascii"))
    if err.strip():
        sys.stdout.write(err.encode("ascii", "replace").decode("ascii"))
    client.close()
    return stdout.channel.recv_exit_status()


if __name__ == "__main__":
    raise SystemExit(main())
