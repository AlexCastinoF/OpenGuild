"""Upload Electron BETA installer only — does NOT touch latest.yml / auto-update.

Uso:
  $env:SF_DEPLOY_PASS = '...'
  python deploy/upload_desktop_beta.py [path-to-exe]

Default: finds newest SteamFarm-Comunidade-*-beta*.exe under apps/desktop/dist
          or desktop-releases/
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import paramiko

ROOT = Path(__file__).resolve().parent.parent


def _load_pass_from_dotenv() -> str:
    """Load SF_DEPLOY_PASS from common local .env files without printing it."""
    candidates = [
        ROOT / ".env",
        ROOT.parent / "archi-steam-farm-py" / ".env",
        Path.home() / ".steamfarm-deploy.env",
    ]
    for path in candidates:
        if not path.is_file():
            continue
        try:
            for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
                raw = line.strip()
                if not raw or raw.startswith("#") or "=" not in raw:
                    continue
                key, _, val = raw.partition("=")
                key = key.strip()
                if key in ("SF_DEPLOY_PASS", "WM_DEPLOY_PASS", "DEPLOY_PASS", "VPS_PASS"):
                    return val.strip().strip('"').strip("'")
        except OSError:
            continue
    return ""


HOST = os.environ.get("SF_DEPLOY_HOST", "vps.example.com")
USER = os.environ.get("SF_DEPLOY_USER", "root")
PORT = int(os.environ.get("SF_DEPLOY_PORT", "22") or "22")
PASSWORD = os.environ.get("SF_DEPLOY_PASS") or _load_pass_from_dotenv()

# Same static dir as production, but NEVER upload/overwrite latest.yml.
# Nginx only serves /desktop/* from this folder (subfolders like /beta/ hit Express → 404).
REMOTE_BETA = "/opt/steamfarm-react/desktop"
FLASK_MIRROR = "/opt/steamfarm/asf_py/static/desktop"


def find_exe(explicit: str | None) -> Path:
    if explicit:
        p = Path(explicit)
        if not p.is_file():
            raise SystemExit(f"missing {p}")
        return p
    candidates: list[Path] = []
    for folder in (ROOT / "apps" / "desktop" / "dist", ROOT / "desktop-releases"):
        if not folder.is_dir():
            continue
        for f in folder.glob("SteamFarm-Comunidade-*.exe"):
            if "portable" in f.name.lower():
                continue
            candidates.append(f)
    if not candidates:
        raise SystemExit("Nenhum .exe encontrado em apps/desktop/dist ou desktop-releases")
    candidates.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return candidates[0]


def main() -> int:
    if not PASSWORD:
        print("Defina SF_DEPLOY_PASS", file=sys.stderr)
        return 2

    exe = find_exe(sys.argv[1] if len(sys.argv) > 1 else None)
    print(f"Beta EXE: {exe.name} ({exe.stat().st_size / 1e6:.1f} MB)")

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
    for remote_dir in (REMOTE_BETA, FLASK_MIRROR):
        stdin, stdout, stderr = client.exec_command(f"mkdir -p {remote_dir}")
        stdout.channel.recv_exit_status()
        remote = f"{remote_dir}/{exe.name}"
        print(f"upload -> {remote} (sem latest.yml)")
        sftp.put(str(exe), remote)
    sftp.close()

    # Verify production feed untouched
    cmd = (
        f"ls -lah {REMOTE_BETA}/ | tail -15; "
        "echo '--- production latest.yml (must stay 1.2.28) ---'; "
        "head -8 /opt/steamfarm-react/desktop/latest.yml"
    )
    _i, out, _e = client.exec_command(cmd, timeout=60)
    print(out.read().decode("utf-8", errors="replace"))
    client.close()

    public = f"https://chat.example.com/desktop/{exe.name}"
    print("OK beta upload")
    print(f"Link manual: {public}")
    print("Auto-update: latest.yml NAO foi alterado")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
