"""Publica pack 1.4.4, API pública e proxy farmsteam → NestJS."""
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

APP = "/opt/steamfarm-react"
LOCAL_PACK = ROOT / "match-packs" / "1.4.4"
LOCAL_INDEX = ROOT / "match-packs" / "index.json"
LOCAL_CTRL = ROOT / "apps" / "api" / "src" / "match-packs" / "match-packs.controller.ts"


def main() -> int:
    if not LOCAL_PACK.is_dir() or not (LOCAL_PACK / "SfAssignTeams.dll").is_file():
        print("pack 1.4.4 local em falta", file=sys.stderr)
        return 2
    if not LOCAL_CTRL.is_file():
        print("controller em falta", file=sys.stderr)
        return 2

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    print(f"Conectando {USER}@{HOST}...")
    client.connect(
        hostname=HOST,
        port=22,
        username=USER,
        password=PASS,
        timeout=45,
        allow_agent=False,
        look_for_keys=False,
    )
    sftp = client.open_sftp()

    def put(local: Path, remote: str) -> None:
        parent = str(Path(remote).parent).replace("\\", "/")
        client.exec_command(f"mkdir -p {parent}")[1].channel.recv_exit_status()
        print(f"put {local.name} -> {remote}")
        sftp.put(str(local), remote)

    for name in ("manifest.json", "sounds-catalog.json", "SfAssignTeams.dll", "SfKillSounds.dll"):
        src = LOCAL_PACK / name
        if src.is_file():
            put(src, f"{APP}/match-packs/1.4.4/{name}")
    if LOCAL_INDEX.is_file():
        put(LOCAL_INDEX, f"{APP}/match-packs/index.json")
    put(LOCAL_CTRL, f"{APP}/apps/api/src/match-packs/match-packs.controller.ts")
    sftp.close()

    cmd = r'''
set -e
echo '==== packs ===='
ls -lah /opt/steamfarm-react/match-packs /opt/steamfarm-react/match-packs/1.4.4
echo '==== api port ===='
systemctl show -p Environment steamfarm-react | tr ' ' '\n' | grep -E 'PORT|MATCH' || true
ss -lntp | grep -E ':(5071|8014)\s' || true
echo '==== nginx sites ===='
ls /etc/nginx/sites-enabled
echo '==== farmsteam api now ===='
curl -sI -m 8 https://vps.example.com/api/match-packs/1.4.4 | head -12
echo '==== build api ===='
cd /opt/steamfarm-react/apps/api
export CI=1 FORCE_COLOR=0
npx prisma generate >/dev/null
npx nest build
systemctl restart steamfarm-react
sleep 2
systemctl is-active steamfarm-react
echo '==== patch farmsteam nginx ===='
python3 << 'PY'
from pathlib import Path
import re, subprocess
cands = list(Path("/etc/nginx/sites-enabled").iterdir()) + list(Path("/etc/nginx/sites-available").iterdir())
changed = []
block_tpl = (
    "\n    location ^~ /api/match-packs {\n"
    "        proxy_pass http://127.0.0.1:%s;\n"
    "        proxy_http_version 1.1;\n"
    "        proxy_set_header Host $host;\n"
    "        proxy_set_header X-Real-IP $remote_addr;\n"
    "        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n"
    "        proxy_set_header X-Forwarded-Proto $scheme;\n"
    "        proxy_read_timeout 120s;\n"
    "    }\n"
)
port = "5071"
try:
    env = subprocess.check_output(["systemctl", "show", "-p", "Environment", "steamfarm-react"], text=True)
    m = re.search(r"PORT=(\d+)", env)
    if m:
        port = m.group(1)
except Exception:
    pass
for p in cands:
    if not p.is_file():
        continue
    text = p.read_text(errors="replace")
    if "vps.example.com" not in text and "server_name farmsteam" not in text:
        continue
    if "location ^~ /api/match-packs" in text:
        print("ALREADY", p)
        continue
    needle = None
    for cand in ("    location /api/", "    location /api ", "    location / {"):
        if cand in text:
            needle = cand
            break
    if not needle:
        print("SKIP no insert point", p)
        continue
    text = text.replace(needle, (block_tpl % port) + needle, 1)
    p.write_text(text)
    changed.append(str(p))
    print("PATCHED", p, "port=" + port)
print("CHANGED", changed)
PY
nginx -t
systemctl reload nginx
echo '==== smoke ===='
echo -n 'chat: '; curl -sS -m 8 -o /tmp/mp-chat.json -w '%{http_code}' https://chat.example.com/api/match-packs/1.4.4; echo; head -c 180 /tmp/mp-chat.json; echo
echo -n 'farm: '; curl -sS -m 8 -o /tmp/mp-farm.json -w '%{http_code}' https://vps.example.com/api/match-packs/1.4.4; echo; head -c 180 /tmp/mp-farm.json; echo
echo HOTFIX_PACKS_OK
'''
    print("Build + nginx na VPS...")
    _i, stdout, stderr = client.exec_command(cmd, get_pty=True, timeout=300)
    while True:
        raw = stdout.readline()
        if not raw:
            break
        line = raw if isinstance(raw, str) else raw.decode("utf-8", errors="replace")
        sys.stdout.write(line.encode("ascii", "replace").decode("ascii"))
        sys.stdout.flush()
    err = stderr.read().decode("utf-8", errors="replace")
    if err.strip():
        print(err)
    code = stdout.channel.recv_exit_status()
    client.close()
    return code


if __name__ == "__main__":
    raise SystemExit(main())
