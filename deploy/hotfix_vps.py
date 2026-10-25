"""Hotfix rápido: envia fontes críticas, rebuild e restart na VPS."""
from __future__ import annotations

import os
import sys
from pathlib import Path

import paramiko

ROOT = Path(__file__).resolve().parent.parent
HOST = os.environ.get("SF_DEPLOY_HOST", "vps.example.com")
USER = os.environ.get("SF_DEPLOY_USER", "root")
PORT = int(os.environ.get("SF_DEPLOY_PORT", "22") or "22")
PASSWORD = os.environ.get("SF_DEPLOY_PASS") or ""
APP = "/opt/steamfarm-react"

FILES = [
    ("apps/web/src/components/SteamDialogs.tsx", f"{APP}/apps/web/src/components/SteamDialogs.tsx"),
    ("apps/web/src/components/ItemDetailDialog.tsx", f"{APP}/apps/web/src/components/ItemDetailDialog.tsx"),
    ("apps/web/src/components/ProfileEditDialog.tsx", f"{APP}/apps/web/src/components/ProfileEditDialog.tsx"),
    ("apps/web/src/components/NativeDialog.tsx", f"{APP}/apps/web/src/components/NativeDialog.tsx"),
    ("apps/web/src/components/SkinPickItem.tsx", f"{APP}/apps/web/src/components/SkinPickItem.tsx"),
    ("apps/web/src/components/wa/useWaHub.ts", f"{APP}/apps/web/src/components/wa/useWaHub.ts"),
    ("apps/web/src/components/wa/WaHub.tsx", f"{APP}/apps/web/src/components/wa/WaHub.tsx"),
    ("apps/web/src/components/wa/WaDialogs.tsx", f"{APP}/apps/web/src/components/wa/WaDialogs.tsx"),
    ("apps/web/src/lib/steamProvenance.ts", f"{APP}/apps/web/src/lib/steamProvenance.ts"),
    ("apps/web/src/styles/steamfarm-style.css", f"{APP}/apps/web/src/styles/steamfarm-style.css"),
    ("apps/api/src/steam/steam.service.ts", f"{APP}/apps/api/src/steam/steam.service.ts"),
    ("whatsapp/gateway.mjs", f"{APP}/whatsapp/gateway.mjs"),
]

FLASK_WA = "/opt/steamfarm/whatsapp/gateway.mjs"
DESKTOP_LOCAL = ROOT / "desktop-releases"
DESKTOP_REMOTE = f"{APP}/desktop"


def main() -> int:
    if not PASSWORD:
        print("Defina SF_DEPLOY_PASS", file=sys.stderr)
        return 2

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    print(f"Conectando {USER}@{HOST}…")
    client.connect(
        hostname=HOST,
        port=PORT,
        username=USER,
        password=PASSWORD,
        timeout=45,
        allow_agent=False,
        look_for_keys=False,
    )
    transport = client.get_transport()
    if transport:
        transport.set_keepalive(15)
    sftp = client.open_sftp()

    for rel, remote in FILES:
        local = ROOT / rel
        if not local.is_file():
            print(f"skip missing {rel}")
            continue
        print(f"put {rel}")
        remote_dir = str(Path(remote).parent).replace("\\", "/")
        client.exec_command(f"mkdir -p {remote_dir}")[1].channel.recv_exit_status()
        data = local.read_bytes().replace(b"\r\n", b"\n")
        with sftp.file(remote, "wb") as rf:
            rf.write(data)

    wa = ROOT / "whatsapp" / "gateway.mjs"
    if wa.is_file():
        print(f"put flask gateway → {FLASK_WA}")
        with sftp.file(FLASK_WA, "wb") as rf:
            rf.write(wa.read_bytes().replace(b"\r\n", b"\n"))

    if DESKTOP_LOCAL.is_dir():
        client.exec_command(f"mkdir -p {DESKTOP_REMOTE}")[1].channel.recv_exit_status()
        yml = DESKTOP_LOCAL / "latest.yml"
        if yml.is_file():
            meta = yml.read_text(encoding="utf-8")
            exe_name = ""
            for line in meta.splitlines():
                if line.startswith("path:"):
                    exe_name = line.split(":", 1)[1].strip().strip("\"'")
                    break
            for name in ("latest.yml", exe_name, f"{exe_name}.blockmap"):
                p = DESKTOP_LOCAL / name
                if not p.is_file():
                    continue
                print(f"put desktop {name} ({p.stat().st_size / 1e6:.1f} MB)")
                sftp.put(str(p), f"{DESKTOP_REMOTE}/{name}")

    sftp.close()

    cmd = f"""
set -e
cd {APP}
echo '[build] web'
cd apps/web && npm run build
echo '[build] api'
cd {APP}/apps/api && npx prisma generate >/dev/null && npm run build
echo '[restart]'
systemctl restart steamfarm-react || true
systemctl restart steamfarm-wa 2>/dev/null || systemctl restart zapo-gateway 2>/dev/null || true
# gateway sob systemd do flask?
systemctl restart steamfarm 2>/dev/null || true
systemctl is-active steamfarm-react || true
curl -sS -m 5 -o /dev/null -w 'chat:%{{http_code}}\\n' https://chat.example.com/ || true
ls -lah {DESKTOP_REMOTE}/latest.yml 2>/dev/null || true
head -3 {DESKTOP_REMOTE}/latest.yml 2>/dev/null || true
echo HOTFIX_OK
"""
    print("Build + restart na VPS…")
    _i, stdout, stderr = client.exec_command(cmd, get_pty=True, timeout=900)
    while True:
        line = stdout.readline()
        if not line:
            break
        sys.stdout.write(line)
        sys.stdout.flush()
    err = stderr.read().decode("utf-8", errors="replace")
    if err.strip():
        print(err)
    code = stdout.channel.recv_exit_status()
    client.close()
    return code


if __name__ == "__main__":
    raise SystemExit(main())
