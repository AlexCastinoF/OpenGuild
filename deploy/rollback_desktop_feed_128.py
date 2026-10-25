"""Roll back Electron auto-update feed to 1.2.28 (keep 1.2.29 exe on disk for later)."""
from __future__ import annotations

import os
import sys
from pathlib import Path

import paramiko

ROOT = Path(__file__).resolve().parent.parent


def _load_pass() -> str:
    env = os.environ.get("SF_DEPLOY_PASS") or ""
    if env:
        return env
    for path in (ROOT / ".env", ROOT.parent / "archi-steam-farm-py" / ".env"):
        if not path.is_file():
            continue
        for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
            raw = line.strip()
            if raw.startswith("SF_DEPLOY_PASS="):
                return raw.split("=", 1)[1].strip().strip('"').strip("'")
    return ""


YML_128 = """version: 1.2.28
files:
  - url: SteamFarm-Comunidade-1.2.28-x64.exe
    sha512: nFu6o3SOL4CMSLsiVpls9xvalq++EYyRFZd6NkYJiwQtdZSu+sjc45uueW6FLdrZZlBZ8E2lQnyIkRovKSIsRg==
    size: 154962148
path: SteamFarm-Comunidade-1.2.28-x64.exe
sha512: nFu6o3SOL4CMSLsiVpls9xvalq++EYyRFZd6NkYJiwQtdZSu+sjc45uueW6FLdrZZlBZ8E2lQnyIkRovKSIsRg==
releaseDate: '2026-09-08T23:19:34.321Z'
"""


def main() -> int:
    password = _load_pass()
    if not password:
        print("Defina SF_DEPLOY_PASS", file=sys.stderr)
        return 2
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(
        hostname=os.environ.get("SF_DEPLOY_HOST", "vps.example.com"),
        port=int(os.environ.get("SF_DEPLOY_PORT", "22") or "22"),
        username=os.environ.get("SF_DEPLOY_USER", "root"),
        password=password,
        timeout=45,
        allow_agent=False,
        look_for_keys=False,
    )
    sftp = client.open_sftp()
    for remote_dir in (
        "/opt/steamfarm-react/desktop",
        "/opt/steamfarm/asf_py/static/desktop",
    ):
        # backup current
        try:
            sftp.stat(f"{remote_dir}/latest.yml")
            client.exec_command(
                f"cp -a {remote_dir}/latest.yml {remote_dir}/latest.yml.bak-1.2.29"
            )[1].channel.recv_exit_status()
        except OSError:
            pass
        remote = f"{remote_dir}/latest.yml"
        with sftp.file(remote, "w") as rf:
            rf.write(YML_128)
        print(f"restored {remote} -> 1.2.28")
    sftp.close()
    _i, out, _e = client.exec_command(
        "head -6 /opt/steamfarm-react/desktop/latest.yml; "
        "test -f /opt/steamfarm-react/desktop/SteamFarm-Comunidade-1.2.28-x64.exe && echo EXE_128=ok; "
        "test -f /opt/steamfarm-react/desktop/SteamFarm-Comunidade-1.2.29-x64.exe && echo EXE_129=kept"
    )
    print(out.read().decode("utf-8", errors="replace"))
    client.close()
    print("OK feed rollback to 1.2.28 (1.2.29 exe kept on disk)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
