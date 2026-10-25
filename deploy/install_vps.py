"""Instala ou atualiza SteamFarm Comunidade na VPS.

Uso (PowerShell) — VPS limpa:
  $env:SF_DEPLOY_PASS = 'senha-ssh'
  $env:SF_DEPLOY_DOMAIN = 'chat.seudominio.com'
  $env:SF_DEPLOY_HOST = '203.0.113.10'
  $env:SF_DEPLOY_EMAIL = 'voce@email.com'
  $env:SF_DEPLOY_APP_PORT = '5071'
  $env:SF_REUSE_STEAMFARM_DB = '0'
  $env:SF_REUSE_LIVEKIT = '0'
  python deploy/install_vps.py

Mesma VPS do Flask (compartilha Postgres steamfarm + LiveKit):
  $env:SF_REUSE_STEAMFARM_DB = '1'
  $env:SF_REUSE_LIVEKIT = '1'
  python deploy/install_vps.py

Atualizar só o código:
  python deploy/update_vps.py
"""

from __future__ import annotations

import os
import subprocess
import sys
import tarfile
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


HOST = os.environ.get("WM_DEPLOY_HOST") or os.environ.get("SF_DEPLOY_HOST", "vps.example.com")
USER = os.environ.get("WM_DEPLOY_USER") or os.environ.get("SF_DEPLOY_USER", "root")
PORT = int(os.environ.get("WM_DEPLOY_PORT") or os.environ.get("SF_DEPLOY_PORT", "22") or "22")
PASSWORD = os.environ.get("WM_DEPLOY_PASS") or os.environ.get("SF_DEPLOY_PASS") or _load_pass_from_dotenv()
DOMAIN = (
    os.environ.get("WM_DEPLOY_DOMAIN")
    or os.environ.get("SF_DEPLOY_DOMAIN")
    or ""
).strip()
EMAIL = (os.environ.get("WM_DEPLOY_EMAIL") or os.environ.get("SF_DEPLOY_EMAIL") or "").strip()
APP_PORT = (os.environ.get("WM_DEPLOY_APP_PORT") or os.environ.get("SF_DEPLOY_APP_PORT") or "5071").strip()
MODE = (os.environ.get("WM_DEPLOY_MODE") or os.environ.get("SF_DEPLOY_MODE") or "install").strip().lower()
PUBLIC_URL = (
    os.environ.get("WM_DEPLOY_URL")
    or os.environ.get("SF_DEPLOY_URL")
    or (f"https://{DOMAIN}" if DOMAIN else "")
)
REUSE_STEAMFARM_DB = (
    os.environ.get("SF_REUSE_STEAMFARM_DB")
    or os.environ.get("REUSE_STEAMFARM_DB")
    or "0"
).strip()
REUSE_LIVEKIT = (
    os.environ.get("SF_REUSE_LIVEKIT")
    or os.environ.get("REUSE_LIVEKIT")
    or "1"
).strip()


def bash_single_quote(value: str) -> str:
    return "'" + value.replace("'", "'\"'\"'") + "'"


SKIP_DIR_NAMES = {
    ".git",
    "node_modules",
    "dist",
    "installer-win",
    "desktop-releases",
    "data",
    "__pycache__",
    "cs2-overlay",
}


def _skip_dir(name: str) -> bool:
    return name in SKIP_DIR_NAMES or name.endswith(".egg-info")


def build_archive(path: Path) -> Path:
    if path.is_file():
        try:
            path.unlink()
        except OSError:
            path = path.with_name(f"{path.stem}-{os.getpid()}{path.suffix}")
    with tarfile.open(path, "w:gz") as tar:
        for dirpath, dirnames, filenames in os.walk(ROOT):
            rel_dir = Path(dirpath).relative_to(ROOT).as_posix()
            dirnames[:] = [d for d in dirnames if not _skip_dir(d)]
            if rel_dir == "apps":
                dirnames[:] = [d for d in dirnames if d != "desktop"]
            if rel_dir.startswith("apps/desktop"):
                continue
            for name in filenames:
                if name.endswith((".db", ".pyc", ".log", ".tgz", ".zip", ".rar", ".7z")):
                    continue
                if name in {".env", ".deploy-steamfarm-react.tgz"}:
                    continue
                full = Path(dirpath) / name
                arc = str(full.relative_to(ROOT)).replace("\\", "/")
                tar.add(full, arcname=arc, recursive=False)
    if not path.is_file() or path.stat().st_size < 1000:
        raise RuntimeError(f"Pacote inválido: {path}")
    return path


def main() -> int:
    if not PASSWORD:
        print("Defina SF_DEPLOY_PASS com a senha SSH da VPS.", file=sys.stderr)
        return 2
    if not HOST:
        print("Defina SF_DEPLOY_HOST (IP ou hostname da VPS).", file=sys.stderr)
        return 2
    if MODE == "install" and not DOMAIN:
        print("Defina SF_DEPLOY_DOMAIN (ex.: chat.seudominio.com).", file=sys.stderr)
        return 2
    if APP_PORT in ("5050", "5060", "5070"):
        print("Porta reservada (SteamFarm/Meeting/Woulz). Use 5071.", file=sys.stderr)
        return 2

    bootstrap = ROOT / "deploy" / "remote-bootstrap.sh"
    if not bootstrap.is_file():
        print(f"Bootstrap ausente: {bootstrap}", file=sys.stderr)
        return 2

    archive_dir = Path(os.environ.get("TEMP") or os.environ.get("TMP") or str(ROOT / "data"))
    archive_dir.mkdir(parents=True, exist_ok=True)
    archive = archive_dir / f"steamfarm-react-deploy-{os.getpid()}.tgz"
    try:
        print("Empacotando SteamFarm Comunidade...")
        sys.stdout.flush()
        archive = build_archive(archive)
        print(f"Pacote: {archive.stat().st_size / (1024 * 1024):.1f} MB")
        sys.stdout.flush()

        remote_archive = "/tmp/steamfarm-react.tgz"
        remote_script = "/tmp/steamfarm-react-bootstrap.sh"

        client = paramiko.SSHClient()
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        print(f"Conectando {USER}@{HOST}:{PORT}...")
        client.connect(
            hostname=HOST,
            port=PORT,
            username=USER,
            password=PASSWORD,
            timeout=45,
            banner_timeout=45,
            auth_timeout=45,
            allow_agent=False,
            look_for_keys=False,
        )
        transport = client.get_transport()
        if transport:
            transport.set_keepalive(20)

        print("Conferindo serviços existentes...")
        _i, pre_out, _e = client.exec_command(
            "systemctl is-active steamfarm steamfarmmeeting steamfarm-react nginx 2>/dev/null; "
            "ss -lntp | grep -E ':(5050|5060|5070|5071)\\s' || true; "
            "ls /etc/nginx/sites-enabled/ 2>/dev/null || true",
            timeout=30,
        )
        print(pre_out.read().decode("utf-8", errors="replace"))

        print("Enviando pacote...")
        # Remove leftovers de uploads truncados (senão o SFTP compara tamanho antigo)
        _i, _o, _e = client.exec_command(
            f"rm -f {bash_single_quote(remote_archive)} {bash_single_quote(remote_script)}",
            timeout=30,
        )
        _o.channel.recv_exit_status()
        sftp = client.open_sftp()
        sftp.put(str(archive), remote_archive, confirm=True)
        script_bytes = bootstrap.read_bytes().replace(b"\r\n", b"\n").replace(b"\r", b"\n")
        with sftp.file(remote_script, "wb") as rf:
            rf.write(script_bytes)
        sftp.chmod(remote_script, 0o755)
        sftp.close()

        env_parts = [
            f"MODE={bash_single_quote(MODE)}",
            f"APP_ARCHIVE={bash_single_quote(remote_archive)}",
            f"APP_PORT={bash_single_quote(APP_PORT if MODE == 'install' else 'keep')}",
            "ENABLE_SSL=1",
            f"REUSE_LIVEKIT={bash_single_quote(REUSE_LIVEKIT)}",
            # update: NUNCA forçar 0 — isso dispara prisma db push no Postgres compartilhado
            f"REUSE_STEAMFARM_DB={bash_single_quote(REUSE_STEAMFARM_DB if MODE == 'install' else (REUSE_STEAMFARM_DB or '1'))}",
            "LIVEKIT_ROOM_PREFIX=sfr",
            "LIVEKIT_IDENTITY_PREFIX=sfr",
            "AUTH_COOKIE_NAME=sf_react_token",
            f"SKIP_CERTBOT={bash_single_quote('1' if MODE == 'update' else '0')}",
        ]
        if DOMAIN:
            env_parts.append(f"DOMAIN_NAME={bash_single_quote(DOMAIN)}")
        if PUBLIC_URL:
            env_parts.append(f"PUBLIC_URL={bash_single_quote(PUBLIC_URL)}")
        if EMAIL:
            env_parts.append(f"SSL_EMAIL={bash_single_quote(EMAIL)}")

        cmd = (
            f"chmod +x {bash_single_quote(remote_script)}; "
            f"sed -i 's/\\r$//' {bash_single_quote(remote_script)}; "
            + " ".join(env_parts)
            + f" bash {bash_single_quote(remote_script)}"
        )
        print(f"Executando bootstrap ({MODE})...")
        _stdin, stdout, stderr = client.exec_command(cmd, get_pty=True, timeout=3600)
        out_path = Path(os.environ.get("TEMP", "/tmp")) / "sfr_vps_out.txt"
        chunks: list[str] = []
        while True:
            line = stdout.readline()
            if not line:
                break
            try:
                sys.stdout.write(line)
            except UnicodeEncodeError:
                safe = line.encode(sys.stdout.encoding or "utf-8", errors="replace").decode(
                    sys.stdout.encoding or "utf-8", errors="replace"
                )
                sys.stdout.write(safe)
            chunks.append(line)
        err = stderr.read().decode("utf-8", errors="replace")
        if err:
            sys.stderr.write(err)
            chunks.append(err)
        out_path.write_text("".join(chunks), encoding="utf-8", errors="replace")
        print(f"Log: {out_path}")
        code = stdout.channel.recv_exit_status()

        print("Conferindo serviços após install...")
        _i, post_out, _e = client.exec_command(
            "systemctl is-active steamfarm steamfarmmeeting steamfarm-react nginx 2>/dev/null; "
            "ss -lntp | grep -E ':(5050|5060|5070|5071)\\s' || true",
            timeout=30,
        )
        print(post_out.read().decode("utf-8", errors="replace"))
        client.close()
        if code != 0:
            print(f"Bootstrap falhou (exit {code})", file=sys.stderr)
            return code
        print("Concluído.")
        if DOMAIN:
            print(f"Acesse: https://{DOMAIN}")
            print(f"Feed Electron: https://{DOMAIN}/desktop/")
        return 0
    finally:
        try:
            if archive.is_file():
                archive.unlink()
        except OSError:
            pass


if __name__ == "__main__":
    raise SystemExit(main())
