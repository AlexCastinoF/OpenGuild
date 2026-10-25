"""Set RUSTDESK_* on VPS steamfarm-react .env. Requires SF_DEPLOY_PASS."""
from __future__ import annotations

import os
import sys

import paramiko

PASSWORD = os.environ.get("SF_DEPLOY_PASS") or ""
KEY = "Wy5yhRDXPNKLh6ogIMLRpHHQBXWoXSvuBBE01CZO56c="
ID_SERVER = "vps.example.com"
ENV_PATH = "/opt/steamfarm-react/.env"


def main() -> int:
    if not PASSWORD:
        print("Defina SF_DEPLOY_PASS", file=sys.stderr)
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
    sftp = c.open_sftp()
    try:
        with sftp.file(ENV_PATH, "r") as f:
            lines = f.read().decode("utf-8", "replace").splitlines()
    except OSError:
        lines = []
    out = []
    seen_id = seen_key = False
    for line in lines:
        if line.startswith("RUSTDESK_ID_SERVER="):
            out.append(f"RUSTDESK_ID_SERVER={ID_SERVER}")
            seen_id = True
        elif line.startswith("RUSTDESK_KEY="):
            out.append(f"RUSTDESK_KEY={KEY}")
            seen_key = True
        else:
            out.append(line)
    if not seen_id:
        out.append(f"RUSTDESK_ID_SERVER={ID_SERVER}")
    if not seen_key:
        out.append(f"RUSTDESK_KEY={KEY}")
    data = ("\n".join(out).rstrip() + "\n").encode("utf-8")
    with sftp.file(ENV_PATH, "w") as f:
        f.write(data)
    sftp.close()
    _, stdout, _ = c.exec_command(f"grep -E '^RUSTDESK_' {ENV_PATH}; ss -lntp | grep -E '2111[5-9]' || true")
    print(stdout.read().decode())
    c.close()
    print("OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
