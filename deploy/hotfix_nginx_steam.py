"""Hotfix nginx: proxy /steam/ to API (OpenID callback was hitting SPA)."""
from __future__ import annotations

import os
import sys
from pathlib import Path

import paramiko

ROOT = Path(__file__).resolve().parent
for p in (ROOT / ".env", ROOT.parent / "archi-steam-farm-py" / ".env", Path.home() / ".steamfarm-deploy.env"):
    if p.is_file():
        for line in p.read_text(encoding="utf-8", errors="ignore").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

HOST = os.environ.get("SF_DEPLOY_HOST", "vps.example.com")
USER = os.environ.get("SF_DEPLOY_USER", "root")
PASS = os.environ.get("SF_DEPLOY_PASS") or os.environ.get("WM_DEPLOY_PASS")
if not PASS:
    print("SF_DEPLOY_PASS missing", file=sys.stderr)
    raise SystemExit(1)

REMOTE_PY = r'''
from pathlib import Path
import re, subprocess
p = Path("/etc/nginx/sites-available/steamfarm-react")
text = p.read_text()
if "location /steam/" in text:
    print("STEAM_LOCATION_ALREADY=1")
else:
    m = re.search(r"proxy_pass http://127\.0\.0\.1:(\d+);", text)
    port = m.group(1) if m else "5071"
    block = (
        "\n    location /steam/ {\n"
        f"        proxy_pass http://127.0.0.1:{port};\n"
        "        proxy_http_version 1.1;\n"
        "        proxy_set_header Host $host;\n"
        "        proxy_set_header X-Real-IP $remote_addr;\n"
        "        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n"
        "        proxy_set_header X-Forwarded-Proto $scheme;\n"
        "        proxy_read_timeout 120s;\n"
        "    }\n"
    )
    needle = "    location /uploads/ {"
    if needle not in text:
        raise SystemExit("uploads location not found")
    parts = text.split(needle)
    out = [parts[0]]
    for chunk in parts[1:]:
        prev = out[-1]
        if "location /steam/" in prev[-500:]:
            out.append(needle + chunk)
        else:
            out.append(block + needle + chunk)
    p.write_text("".join(out))
    print("STEAM_LOCATION_ADDED=1")
subprocess.check_call(["nginx", "-t"])
subprocess.check_call(["systemctl", "reload", "nginx"])
print("NGX_STEAM_OK")
'''

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASS, timeout=30)
stdin, stdout, stderr = client.exec_command("python3 -", timeout=60)
stdin.write(REMOTE_PY)
stdin.channel.shutdown_write()
out = stdout.read().decode("utf-8", "replace")
err = stderr.read().decode("utf-8", "replace")
code = stdout.channel.recv_exit_status()
print(out)
if err.strip():
    print(err, file=sys.stderr)
# smoke
stdin2, stdout2, stderr2 = client.exec_command(
    "curl -sI 'https://chat.example.com/steam/link/callback?uid=0' | head -8",
    timeout=30,
)
print(stdout2.read().decode("utf-8", "replace"))
client.close()
raise SystemExit(code)
