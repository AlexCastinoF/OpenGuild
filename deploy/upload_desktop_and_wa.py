"""Sobe feed Electron + gateway WA na VPS (após update_vps).

Uso:
  $env:SF_DEPLOY_PASS = '...'
  python deploy/upload_desktop_and_wa.py
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import paramiko

ROOT = Path(__file__).resolve().parent.parent


def _load_pass_from_dotenv() -> str:
    for path in (
        ROOT / ".env",
        ROOT.parent / "archi-steam-farm-py" / ".env",
        Path.home() / ".steamfarm-deploy.env",
    ):
        if not path.is_file():
            continue
        try:
            for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
                raw = line.strip()
                if not raw or raw.startswith("#") or "=" not in raw:
                    continue
                key, _, val = raw.partition("=")
                if key.strip() in ("SF_DEPLOY_PASS", "WM_DEPLOY_PASS", "DEPLOY_PASS", "VPS_PASS"):
                    return val.strip().strip('"').strip("'")
        except OSError:
            continue
    return ""


HOST = os.environ.get("SF_DEPLOY_HOST", "vps.example.com")
USER = os.environ.get("SF_DEPLOY_USER", "root")
PORT = int(os.environ.get("SF_DEPLOY_PORT", "22") or "22")
PASSWORD = os.environ.get("SF_DEPLOY_PASS") or _load_pass_from_dotenv()

DESKTOP_REMOTE = "/opt/steamfarm-react/desktop"
FLASK_DESKTOP = "/opt/steamfarm/asf_py/static/desktop"
WA_REMOTE = "/opt/steamfarm/whatsapp/gateway.mjs"


def main() -> int:
    if not PASSWORD:
        print("Defina SF_DEPLOY_PASS", file=sys.stderr)
        return 2

    releases = ROOT / "desktop-releases"
    yml = releases / "latest.yml"
    if not yml.is_file():
        print(f"missing {yml}", file=sys.stderr)
        return 2
    meta = yml.read_text(encoding="utf-8")
    exe_name = ""
    for line in meta.splitlines():
        if line.startswith("path:"):
            exe_name = line.split(":", 1)[1].strip().strip("\"'")
            break
    exe = releases / exe_name
    if not exe.is_file():
        print(f"missing exe {exe}", file=sys.stderr)
        return 2
    blockmap = Path(str(exe) + ".blockmap")
    # .exe/.blockmap primeiro; latest.yml por último — evita clients a pedirem um exe a meio do upload
    files = [exe]
    if blockmap.is_file():
        files.append(blockmap)
    files.append(yml)

    wa_local = ROOT / "whatsapp" / "gateway.mjs"
    if not wa_local.is_file():
        wa_local = ROOT.parent / "archi-steam-farm-py" / "whatsapp" / "gateway.mjs"

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    print(f"Conectando {USER}@{HOST}:{PORT}...")
    client.connect(
        hostname=HOST,
        port=PORT,
        username=USER,
        password=PASSWORD,
        timeout=45,
        allow_agent=False,
        look_for_keys=False,
    )
    sftp = client.open_sftp()

    for remote_dir in (DESKTOP_REMOTE, FLASK_DESKTOP):
        try:
            sftp.stat(remote_dir)
        except OSError:
            stdin, stdout, stderr = client.exec_command(f"mkdir -p {remote_dir}")
            stdout.channel.recv_exit_status()
        for local in files:
            remote = f"{remote_dir}/{local.name}"
            print(f"upload {local.name} -> {remote} ({local.stat().st_size / 1e6:.1f} MB)")
            sftp.put(str(local), remote)

    if wa_local.is_file():
        print(f"upload gateway -> {WA_REMOTE}")
        sftp.put(str(wa_local), WA_REMOTE)
        # React copy if present
        react_wa = "/opt/steamfarm-react/whatsapp/gateway.mjs"
        try:
            sftp.stat("/opt/steamfarm-react/whatsapp")
            sftp.put(str(wa_local), react_wa)
            print(f"upload gateway -> {react_wa}")
        except OSError:
            pass

    sftp.close()

    cmd = (
        "systemctl restart steamfarm-wa 2>/dev/null || "
        "systemctl restart zapo-gateway 2>/dev/null || "
        "systemctl restart steamfarm 2>/dev/null || true; "
        "ls -lah /opt/steamfarm-react/desktop/ | head -20; "
        "echo ---; "
        "head -5 /opt/steamfarm-react/desktop/latest.yml; "
        "systemctl is-active steamfarm-react steamfarm 2>/dev/null || true"
    )
    print("Reiniciando gateway WA (best-effort)…")
    _i, out, _e = client.exec_command(cmd, timeout=120)
    print(out.read().decode("utf-8", errors="replace"))
    client.close()
    print("OK desktop + WA")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
