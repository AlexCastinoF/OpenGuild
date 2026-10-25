"""Pack 1.4.5 + wizard bots/warmup no web da VPS."""
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
PACK = ROOT / "match-packs" / "1.4.12"
INDEX = ROOT / "match-packs" / "index.json"
WEB_FILES = [
    ("apps/web/src/components/PrivateMatchDialogs.tsx", f"{APP}/apps/web/src/components/PrivateMatchDialogs.tsx"),
    ("apps/web/src/lib/matchAdminCvars.ts", f"{APP}/apps/web/src/lib/matchAdminCvars.ts"),
    ("apps/web/src/styles/steamfarm-style.css", f"{APP}/apps/web/src/styles/steamfarm-style.css"),
]


def main() -> int:
    if not (PACK / "SfAssignTeams.dll").is_file():
        print("pack 1.4.12 em falta", file=sys.stderr)
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

    def put_bytes(data: bytes, remote: str) -> None:
        parent = str(Path(remote).parent).replace("\\", "/")
        client.exec_command(f"mkdir -p {parent}")[1].channel.recv_exit_status()
        with sftp.file(remote, "wb") as rf:
            rf.write(data)

    for name in ("manifest.json", "sounds-catalog.json", "SfAssignTeams.dll", "SfKillSounds.dll"):
        src = PACK / name
        if src.is_file():
            print(f"put pack {name}")
            put_bytes(src.read_bytes(), f"{APP}/match-packs/1.4.12/{name}")
    if INDEX.is_file():
        print("put index.json")
        put_bytes(INDEX.read_bytes(), f"{APP}/match-packs/index.json")
    for rel, remote in WEB_FILES:
        local = ROOT / rel
        if not local.is_file():
            print(f"skip {rel}")
            continue
        print(f"put {rel}")
        put_bytes(local.read_bytes().replace(b"\r\n", b"\n"), remote)
    sftp.close()

    cmd = r'''
set -e
export CI=1 FORCE_COLOR=0
echo '==== packs ===='
ls -lah /opt/steamfarm-react/match-packs /opt/steamfarm-react/match-packs/1.4.12
echo '==== smoke ===='
curl -sS -m 8 -o /tmp/mp1412.json -w 'pack:%{http_code}\n' https://chat.example.com/api/match-packs/1.4.12
head -c 200 /tmp/mp1412.json; echo
echo HOTFIX_BOTS_OK
'''
    print("Build web na VPS...")
    _i, stdout, stderr = client.exec_command(cmd, get_pty=True, timeout=420)
    while True:
        raw = stdout.readline()
        if not raw:
            break
        line = raw if isinstance(raw, str) else raw.decode("utf-8", errors="replace")
        sys.stdout.write(line.encode("ascii", "replace").decode("ascii"))
        sys.stdout.flush()
    err = stderr.read().decode("utf-8", errors="replace")
    if err.strip():
        print(err.encode("ascii", "replace").decode("ascii"))
    code = stdout.channel.recv_exit_status()
    client.close()
    return code


if __name__ == "__main__":
    raise SystemExit(main())
