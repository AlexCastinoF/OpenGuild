"""
Central de Deploy — núcleo sem interface.

Perfis dos sistemas, pacote do código, SSH (com verificação da chave do servidor),
instalação/atualização via remote-bootstrap.sh, build do Electron e gestão das
versões do feed de auto-update na VPS.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import secrets
import shlex
import string
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

LogFn = Callable[[str], None]
ProgressFn = Callable[[float, str], None]
ConfirmFn = Callable[[str, str], bool]


# --------------------------------------------------------------------------- perfis


@dataclass(frozen=True)
class InstallOption:
    key: str
    label: str
    env: str
    default: bool
    on_update: bool  # valor enviado no modo atualizar (o campo não aparece)


@dataclass(frozen=True)
class DesktopProfile:
    workspace: str
    package_json: str  # relativo à raiz do repositório
    releases_dir: str  # onde copy-desktop-release.js deixa exe + latest.yml
    artifact_prefix: str
    feed_url: str
    # Pastas servidas em /desktop/ (a primeira é a principal; as demais são espelhos)
    served_dirs: tuple[str, ...]
    # Pastas que o bootstrap copia por cima da principal a cada deploy (rsync)
    shadow_dirs: tuple[str, ...] = ()

    @property
    def build_cmd(self) -> str:
        return f"npm run dist:publish -w {self.workspace}"


@dataclass(frozen=True)
class SystemProfile:
    key: str
    name: str
    tagline: str
    folder: str
    stack: str
    accent: str
    archive: str
    excludes: tuple[str, ...]
    default_port: int
    app_dir: str
    service: str
    domain_hint: str
    install_desc: str
    update_desc: str
    extra_env: tuple[str, ...] = ()
    options: tuple[InstallOption, ...] = ()
    ok_marker: str | None = "INSTALL_OK"
    port_keep_on_update: bool = True
    # False: o bootstrap reescreve o Nginx no update, então precisa de domínio e e-mail
    update_keeps_nginx: bool = True
    default_domain: str = ""
    # Segundo host, só da Barbearia: fila e agenda. Vazio nos outros sistemas.
    public_domain_hint: str = ""
    default_public_domain: str = ""
    bootstrap: str = "deploy/remote-bootstrap.sh"
    desktop: DesktopProfile | None = None
    # Caminhos absolutos usados se a pasta irmã do workspace não tiver o bootstrap
    fallback_paths: tuple[str, ...] = ()
    post_install_note: str = "No primeiro acesso, crie o super admin em /setup."

    @property
    def remote_archive(self) -> str:
        return f"/tmp/{self.archive}"

    @property
    def remote_script(self) -> str:
        return f"/tmp/{self.key}-bootstrap.sh"


PROFILES: tuple[SystemProfile, ...] = (
    SystemProfile(
        key="steamfarm-react",
        name="SteamFarm Comunidade",
        tagline="Comunidade React com app desktop",
        folder="SteamFarmReact",
        stack="NestJS · React · Electron",
        accent="#5bc4e9",
        archive="steamfarm-react.tgz",
        excludes=(
            ".git", "installer-win", "node_modules", "dist", "apps/desktop",
            "apps/desktop/dist", "desktop-releases", "data", "*.db", "__pycache__",
            "*.pyc", "*.log", ".env",
        ),
        default_port=5071,
        app_dir="/opt/steamfarm-react",
        service="steamfarm-react",
        domain_hint="chat.example.com",
        install_desc="Cria /opt/steamfarm-react, Postgres, Nginx e HTTPS. Serve em VPS limpa ou ao lado do Flask.",
        update_desc="Preserva .env, banco, Nginx, SSL e a pasta /desktop. Não roda prisma db push; faz pg_dump antes do SQL aditivo.",
        extra_env=(
            "LIVEKIT_ROOM_PREFIX=sfr",
            "LIVEKIT_IDENTITY_PREFIX=sfr",
            "AUTH_COOKIE_NAME=sf_react_token",
        ),
        options=(
            InstallOption(
                "reuse_db",
                "Reutilizar o Postgres do SteamFarm Flask (/opt/steamfarm)",
                "REUSE_STEAMFARM_DB",
                default=False,
                on_update=True,
            ),
            InstallOption(
                "reuse_lk",
                "Reutilizar o LiveKit do SteamFarm/Woulz (salas sfr-*)",
                "REUSE_LIVEKIT",
                default=True,
                on_update=True,
            ),
        ),
        desktop=DesktopProfile(
            workspace="@steamfarm/desktop",
            package_json="apps/desktop/package.json",
            releases_dir="desktop-releases",
            artifact_prefix="SteamFarm-Comunidade",
            feed_url="https://chat.example.com/desktop/",
            served_dirs=("/opt/steamfarm-react/desktop", "/opt/steamfarm/asf_py/static/desktop"),
            shadow_dirs=("/opt/steamfarm-react/desktop-releases",),
        ),
    ),
    SystemProfile(
        key="woulzmeeting-react",
        name="WOULZ Meeting React",
        tagline="Reuniões React com app desktop",
        folder="WoulzMeetingReact",
        stack="NestJS · React · Electron",
        accent="#a78bfa",
        archive="woulzmeeting-react.tgz",
        excludes=(
            ".git", "installer-win", "node_modules", "dist", "apps/desktop",
            "desktop-releases", "releases", "data", "*.db", "__pycache__", "*.pyc",
            "*.log", ".env",
        ),
        default_port=5070,
        app_dir="/opt/woulzmeeting-react",
        service="woulzmeeting-react",
        domain_hint="meet.example.com",
        install_desc="Cria a pasta, o banco, o Nginx deste domínio e o HTTPS. Não mexe no Flask nem no SteamFarm.",
        update_desc="Reaproveita SSL, banco e contas. Não reescreve o Nginx nem a pasta /desktop.",
        extra_env=(
            "REUSE_LIVEKIT=1",
            "LIVEKIT_ROOM_PREFIX=wmr",
            "LIVEKIT_IDENTITY_PREFIX=wmr",
            "AUTH_COOKIE_NAME=woulz_react_token",
        ),
        desktop=DesktopProfile(
            workspace="@woulz/desktop",
            package_json="apps/desktop/package.json",
            releases_dir="desktop-releases",
            artifact_prefix="WOULZ-Meeting-React",
            feed_url="https://meet.example.com/desktop/",
            served_dirs=("/opt/woulzmeeting-react/desktop",),
            shadow_dirs=("/opt/woulzmeeting-react/desktop-releases",),
        ),
    ),
    SystemProfile(
        key="steamfarm",
        name="SteamFarm (Flask)",
        tagline="Sistema legado em Python",
        folder="archi-steam-farm-py",
        stack="Flask · Python",
        accent="#34d399",
        archive="steamfarm.tgz",
        excludes=(
            ".venv", ".git", "installer-win", "data", "configs/.state",
            "configs/.secret.key", "whatsapp/node_modules", "node_modules",
            "__pycache__", "*.pyc", "*.log", ".env",
        ),
        default_port=5050,
        app_dir="/opt/steamfarm",
        service="steamfarm",
        domain_hint="vps.example.com",
        install_desc="Python, PostgreSQL próprio, Nginx só deste domínio e systemd.",
        update_desc="Troca o código e preserva banco, .env, Nginx e certificado.",
    ),
    SystemProfile(
        key="woulzmeeting",
        name="WOULZ Meeting (Flask)",
        tagline="Reuniões, versão Flask",
        folder="WoulzMeeting",
        stack="Flask · Python",
        accent="#f472b6",
        archive="woulzmeeting.tgz",
        excludes=(
            ".venv", ".git", "installer-win", "desktop/node_modules", "desktop/dist",
            "woulz/static/desktop/*.exe", "woulz/static/desktop/*.blockmap", "data",
            "node_modules", "__pycache__", "*.pyc", "*.log", ".env",
        ),
        default_port=5060,
        app_dir="/opt/woulzmeeting",
        service="woulzmeeting",
        domain_hint="meet.seudominio.com",
        install_desc="Cria usuário, banco, Nginx deste domínio e HTTPS. Não apaga outros sites.",
        update_desc="Troca o código e preserva banco e contas. O bootstrap reescreve o Nginx deste site, então o domínio é reenviado para manter o HTTPS (o certificado existente é reaproveitado).",
        # ENABLE_LIVEKIT=0: o fallback do bootstrap recria o LiveKit compartilhado e troca o segredo
        extra_env=("REUSE_LIVEKIT=1", "ENABLE_LIVEKIT=0"),
        # Com SKIP_CERTBOT=1 o update deixa só o vhost HTTP e o domínio perde o HTTPS
        update_keeps_nginx=False,
    ),
    SystemProfile(
        key="vps-control",
        name="VPS Control Panel",
        tagline="Painel que gerencia a VPS",
        folder="VpsControlPanel",
        stack="NestJS · React",
        accent="#fbbf24",
        archive="vps-control.tgz",
        excludes=(
            ".git", "installer-win", "node_modules", "apps/api/dist", "apps/web/dist", ".env",
        ),
        default_port=5080,
        app_dir="/opt/vps-control",
        service="vps-control",
        domain_hint="painel.example.com",
        install_desc="Cria /opt/vps-control, Postgres vps_control, Nginx e HTTPS.",
        update_desc="Preserva o .env e o banco. O Nginx deste painel é reescrito, então o certificado é renovado junto.",
        ok_marker=None,
        port_keep_on_update=False,
        update_keeps_nginx=False,
        default_domain="painel.example.com",
    ),
    SystemProfile(
        key="soundpulse",
        name="SoundPulse",
        tagline="Filmes, séries e músicas",
        folder="App de musica",
        stack="Express · React",
        accent="#1ed760",
        archive="soundpulse.tgz",
        excludes=(
            ".git", "node_modules", "dist", "dist-ssr", "android", "./data", "./uploads",
            "scratch", ".env", "*.apk", "*.log",
        ),
        default_port=5090,
        app_dir="/opt/soundpulse",
        service="soundpulse",
        domain_hint="midia.example.com",
        install_desc="Cria /opt/soundpulse, o serviço soundpulse na porta 5090 (só localhost) e um site Nginx só deste domínio. Não cria banco e não altera Postgres, Redis, LiveKit nem os outros sites.",
        update_desc="Troca o código e preserva .env, data/ e uploads/. Não reescreve o Nginx dos outros domínios e não reinicia os outros serviços.",
        default_domain="midia.example.com",
        fallback_paths=("H:/App de musica",),
        post_install_note=(
            "Entre com admin@soundpulse.com (senha inicial admin123; troque depois). "
            "O catálogo fica em /opt/soundpulse/data e os arquivos em /opt/soundpulse/uploads; "
            "a atualização não apaga nenhum dos dois. O acesso público é o domínio no Nginx; "
            "a porta 5090 escuta só em localhost."
        ),
    ),
    SystemProfile(
        key="barbearia",
        name="Barbearia",
        tagline="Caixa, fila, agenda e WhatsApp",
        folder="Barbearia",
        stack="FastAPI · React · Postgres",
        accent="#c4a574",
        archive="barbearia.tgz",
        excludes=(
            ".git", "__pycache__", "*.pyc", "node_modules", ".venv",
            "./data", "./uploads", ".env", "build", "testes",
            "Versao barbearia", "*.exe", "*.log",
            # Mantém frontend/dist no pacote para update rápido (sem npm build na VPS).
        ),
        default_port=5100,
        app_dir="/opt/barbearia",
        service="barbearia",
        domain_hint="painel.example.com",
        install_desc=(
            "Cria /opt/barbearia, o banco Postgres barbearia, os serviços barbearia e "
            "barbearia-whatsapp, e o site Nginx da Barbearia com o domínio do painel "
            "e o domínio público da fila e da agenda. A porta 5100 escuta só em localhost. "
            "Não reinicia os outros sistemas."
        ),
        update_desc=(
            "Troca o código e preserva .env, o banco, data/ e uploads/. "
            "O site Nginx da Barbearia usa os dois domínios informados. "
            "Não reescreve o Nginx dos outros domínios e não reinicia os outros serviços."
        ),
        default_domain="painel.example.com",
        public_domain_hint="fila.example.com",
        default_public_domain="fila.example.com",
        fallback_paths=("H:/Barbearia",),
        post_install_note=(
            "O painel abre no domínio administrativo. A fila e a agenda abrem no domínio público. "
            "O .exe do caixa é só a janela do painel. "
            "O WhatsApp pede um QR novo em Conexões na primeira vez. "
            "Para levar o SQLite da loja: python scripts/importar_sqlite.py no servidor, com DATABASE_URL no ambiente."
        ),
    ),
    SystemProfile(
        key="rhwhatsapp",
        name="RH WhatsApp",
        tagline="Recrutamento e atendimento no WhatsApp",
        folder="RHWhatsAppPlan",
        stack="Express · Postgres embutido",
        accent="#00a884",
        archive="rhwhatsapp.tgz",
        excludes=(
            ".git", "node_modules", "data", "uploads", "auth_data", ".env", "*.log",
        ),
        default_port=5110,
        app_dir="/opt/rhwhatsapp",
        service="rhwhatsapp",
        domain_hint="rh.example.com",
        install_desc=(
            "Cria /opt/rhwhatsapp, o serviço rhwhatsapp na porta 5110 (só localhost) e um site "
            "Nginx só deste domínio. O Postgres é o embutido do próprio RH, em 127.0.0.1:54329, "
            "dentro de data/. Não cria banco no Postgres da VPS e não reinicia os outros sistemas."
        ),
        update_desc=(
            "Troca o código e preserva .env, data/ (Postgres e chave das conversas), uploads/ e "
            "auth_data/. Não reescreve o Nginx dos outros domínios e não reinicia os outros serviços."
        ),
        default_domain="rh.example.com",
        fallback_paths=("H:/RHWhatsAppPlan",),
        post_install_note=(
            "No primeiro acesso o painel pede a empresa e o administrador. "
            "O WhatsApp pede um QR em Conexões. "
            "O banco fica em /opt/rhwhatsapp/data e as mídias em /opt/rhwhatsapp/uploads; "
            "a atualização não apaga nenhum dos dois."
        ),
    ),
)

PROFILE_BY_KEY = {p.key: p for p in PROFILES}

RESERVED_PORTS = {p.default_port: p.name for p in PROFILES}


# --------------------------------------------------------------------------- config local


def config_dir() -> Path:
    base = os.environ.get("APPDATA") or str(Path.home())
    path = Path(base) / "CentralDeploy"
    path.mkdir(parents=True, exist_ok=True)
    return path


def load_config() -> dict:
    try:
        return json.loads((config_dir() / "config.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def save_config(cfg: dict) -> None:
    # Nunca grava a senha SSH
    cfg = {k: v for k, v in cfg.items() if k != "password"}
    (config_dir() / "config.json").write_text(json.dumps(cfg, indent=2), encoding="utf-8")


def default_workspace() -> Path:
    if not getattr(sys, "frozen", False):
        return Path(__file__).resolve().parent.parent.parent
    exe = Path(sys.executable).resolve()
    for parent in exe.parents:
        if any((parent / p.folder).is_dir() for p in PROFILES):
            return parent
    return exe.parent


def repo_path(profile: SystemProfile, cfg: dict) -> Path:
    override = (cfg.get("paths") or {}).get(profile.key)
    if override:
        return Path(override)
    base = Path(cfg.get("workspace") or default_workspace()) / profile.folder
    if (base / profile.bootstrap).is_file():
        return base
    for extra in profile.fallback_paths:
        candidate = Path(extra)
        if (candidate / profile.bootstrap).is_file():
            return candidate
    return base


def repo_ok(profile: SystemProfile, repo: Path) -> bool:
    return (repo / profile.bootstrap).is_file()


def saved_password() -> str:
    for key in ("SF_DEPLOY_PASS", "WM_DEPLOY_PASS", "DEPLOY_PASS", "VPS_PASS"):
        if os.environ.get(key):
            return os.environ[key]
    path = Path.home() / ".steamfarm-deploy.env"
    try:
        for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
            key, _, val = line.strip().partition("=")
            if key.strip() in ("SF_DEPLOY_PASS", "WM_DEPLOY_PASS", "DEPLOY_PASS", "VPS_PASS"):
                return val.strip().strip('"').strip("'")
    except OSError:
        pass
    return ""


# --------------------------------------------------------------------------- utilitários


def gen_secret(n: int = 24) -> str:
    alphabet = string.ascii_letters + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(n))


def bash_single_quote(value: str) -> str:
    return "'" + value.replace("'", "'\"'\"'") + "'"


def extract_domain(url_or_host: str) -> str:
    raw = url_or_host.strip().replace("https://", "").replace("http://", "").split("/")[0]
    raw = raw.split(":")[0].strip().lower()
    if not raw or re.fullmatch(r"\d{1,3}(\.\d{1,3}){3}", raw):
        return ""
    return raw


def tail(text: str, lines: int = 30) -> str:
    cleaned = [ln.strip() for ln in text.replace("\r", "").splitlines() if ln.strip()]
    if not cleaned:
        return "(sem detalhes do servidor)"
    return "\n".join(cleaned[-lines:])[:8000]


ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")


def strip_ansi(text: str) -> str:
    return ANSI_RE.sub("", text)


VERSION_RE = re.compile(r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$")


def valid_version(v: str) -> bool:
    return bool(VERSION_RE.match(v.strip()))


def version_key(v: str) -> tuple:
    core, _, pre = v.partition("-")
    nums = [int(p) if p.isdigit() else 0 for p in core.split(".")]
    # 1.2.0-beta vem antes de 1.2.0
    return (nums, 0 if pre else 1, pre)


def bump_version(v: str, part: str) -> str:
    core = v.partition("-")[0]
    try:
        major, minor, patch = (int(x) for x in core.split(".")[:3])
    except ValueError:
        return v
    if part == "major":
        return f"{major + 1}.0.0"
    if part == "minor":
        return f"{major}.{minor + 1}.0"
    return f"{major}.{minor}.{patch + 1}"


def human_size(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit in ("B", "KB") else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} GB"


def _no_window() -> int:
    return getattr(subprocess, "CREATE_NO_WINDOW", 0)


# --------------------------------------------------------------------------- pacote


def tar_binary() -> str:
    # O tar do Git Bash (GNU) entende "C:\..." como host remoto; o bsdtar do Windows não.
    system_tar = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "tar.exe"
    return str(system_tar) if system_tar.is_file() else "tar"


def tar_exclude_args(profile: SystemProfile, repo: Path) -> list[str]:
    """Monta os --exclude do bsdtar.

    Um nome solto como "data" casa com qualquer pasta com esse nome, então
    src/data sumiria junto com a pasta de runtime. Padrões "./pasta" excluem
    só os arquivos daquela pasta na raiz do projeto.
    """
    args: list[str] = []
    for ex in profile.excludes:
        if not ex.startswith("./"):
            args.append(f"--exclude={ex}")
            continue
        rel = ex[2:].strip("/")
        target = repo / rel
        if target.is_file():
            args.append(f"--exclude=./{rel}")
            continue
        if not target.is_dir():
            continue
        for path in target.rglob("*"):
            if path.is_file():
                args.append(f"--exclude=./{path.relative_to(repo).as_posix()}")
    return args


def build_archive(profile: SystemProfile, repo: Path) -> Path:
    out_dir = config_dir() / "payload"
    out_dir.mkdir(parents=True, exist_ok=True)
    archive = out_dir / profile.archive
    if archive.exists():
        archive.unlink()
    cmd = [tar_binary(), "-czf", str(archive)]
    cmd += tar_exclude_args(profile, repo)
    cmd.append(".")
    res = subprocess.run(
        cmd, cwd=str(repo), capture_output=True, creationflags=_no_window()
    )
    if res.returncode != 0:
        raise RuntimeError(
            "Falha ao empacotar o código:\n"
            + tail(res.stderr.decode("utf-8", errors="replace"), 15)
        )
    if not archive.is_file() or archive.stat().st_size < 5_000:
        raise RuntimeError(f"Pacote inválido: {archive}")
    return archive


def bootstrap_bytes(profile: SystemProfile, repo: Path) -> bytes:
    src = repo / profile.bootstrap
    if not src.is_file():
        raise FileNotFoundError(f"Bootstrap não encontrado: {src}")
    return src.read_bytes().replace(b"\r\n", b"\n").replace(b"\r", b"\n")


# --------------------------------------------------------------------------- SSH


@dataclass
class VpsConn:
    host: str
    port: int
    user: str
    password: str


class HostKeyRejected(Exception):
    pass


def known_hosts_path() -> Path:
    return config_dir() / "known_hosts"


def fingerprint(key) -> str:
    digest = hashlib.sha256(key.asbytes()).digest()
    return "SHA256:" + base64.b64encode(digest).decode().rstrip("=")


def connect(conn: VpsConn, confirm_host_key: Callable[[str, str, str], bool]):
    import paramiko

    kh = known_hosts_path()
    client = paramiko.SSHClient()
    if kh.is_file():
        client.load_host_keys(str(kh))

    class TrustOnFirstUse(paramiko.MissingHostKeyPolicy):
        def missing_host_key(self, cl, hostname, key):  # noqa: D401
            if not confirm_host_key(hostname, key.get_name(), fingerprint(key)):
                raise HostKeyRejected("Chave do servidor recusada.")
            cl.get_host_keys().add(hostname, key.get_name(), key)
            cl.save_host_keys(str(kh))

    client.set_missing_host_key_policy(TrustOnFirstUse())
    client.connect(
        hostname=conn.host,
        port=conn.port,
        username=conn.user,
        password=conn.password,
        timeout=45,
        banner_timeout=45,
        auth_timeout=45,
        allow_agent=False,
        look_for_keys=False,
    )
    transport = client.get_transport()
    if transport:
        transport.set_keepalive(20)
    return client


def describe_error(exc: BaseException) -> str:
    try:
        import paramiko

        if isinstance(exc, paramiko.BadHostKeyException):
            return (
                "A chave SSH do servidor mudou desde a última conexão.\n"
                "Isso acontece se a VPS foi reinstalada, mas também pode ser um ataque.\n"
                f"Se tiver certeza, apague a linha do host em:\n{known_hosts_path()}"
            )
        if isinstance(exc, paramiko.AuthenticationException):
            return "Usuário ou senha SSH incorretos."
        if isinstance(exc, paramiko.SSHException):
            return f"Falha na conexão SSH:\n{exc}"
    except ImportError:
        return "Biblioteca paramiko ausente. Rode: pip install -r installer-win/requirements.txt"
    if isinstance(exc, HostKeyRejected):
        return "Conexão cancelada: a chave do servidor não foi aceita."
    if isinstance(exc, TimeoutError) or "timed out" in str(exc):
        return "A VPS não respondeu (tempo esgotado). Confira o IP e a porta SSH."
    return str(exc) or exc.__class__.__name__


def run_remote(
    client,
    command: str,
    on_line: LogFn | None = None,
    stdin_data: bytes | None = None,
    pty: bool = True,
) -> tuple[int, str]:
    chan = client.get_transport().open_session()
    if pty:
        chan.get_pty(width=200)
    chan.set_combine_stderr(True)
    chan.exec_command(command)
    if stdin_data is not None:
        chan.sendall(stdin_data)
        chan.shutdown_write()
    chunks: list[str] = []
    buf = b""
    while True:
        data = chan.recv(32768)
        if not data:
            break
        buf += data
        while b"\n" in buf:
            raw, buf = buf.split(b"\n", 1)
            line = raw.decode("utf-8", errors="replace").rstrip("\r")
            chunks.append(line)
            if on_line:
                on_line(line)
    if buf:
        line = buf.decode("utf-8", errors="replace").rstrip("\r")
        chunks.append(line)
        if on_line:
            on_line(line)
    return chan.recv_exit_status(), "\n".join(chunks)


def require_root(client, log: LogFn) -> None:
    _code, out = run_remote(
        client, "id -u; . /etc/os-release 2>/dev/null; echo SO=$PRETTY_NAME", pty=False
    )
    lines = [ln.strip() for ln in out.splitlines() if ln.strip()]
    so = next((ln for ln in lines if ln.startswith("SO=")), "")
    if so:
        log(so)
    if not lines or lines[0] != "0":
        raise RuntimeError("O usuário SSH não é root. Use o usuário root e tente de novo.")


# --------------------------------------------------------------------------- instalar / atualizar


@dataclass
class DeployRequest:
    profile: SystemProfile
    repo: Path
    mode: str  # "install" | "update"
    domain: str = ""
    public_domain: str = ""
    port: int = 0
    enable_ssl: bool = True
    ssl_email: str = ""
    options: dict[str, bool] = field(default_factory=dict)

    @property
    def is_update(self) -> bool:
        return self.mode == "update"

    def effective_domain(self) -> str:
        if self.domain:
            return self.domain
        if self.is_update and not self.profile.update_keeps_nginx:
            return self.profile.default_domain
        return ""

    def effective_public_domain(self) -> str:
        return extract_domain(self.public_domain)

    def public_url(self) -> str:
        domain = self.effective_public_domain() or self.effective_domain()
        if not domain:
            return ""
        https = self.is_update or self.enable_ssl
        return f"{'https' if https else 'http'}://{domain}"


def validate_request(req: DeployRequest) -> str:
    p = req.profile
    if p.public_domain_hint:
        publico = req.effective_public_domain()
        painel = req.effective_domain() or p.default_domain
        if not publico:
            return "Informe o domínio público da fila e da agenda."
        if publico == painel:
            return "O domínio público precisa ser diferente do domínio do painel."
    needs_site = not req.is_update or not p.update_keeps_nginx
    if not needs_site:
        return ""
    if not req.effective_domain():
        return "Informe o domínio do painel (com DNS A apontando para esta VPS)."
    if req.enable_ssl and "@" not in req.ssl_email:
        return "O Let's Encrypt exige um e-mail válido."
    if not req.is_update:
        if not (1024 <= req.port <= 65535):
            return "Use uma porta entre 1024 e 65535."
        owner = RESERVED_PORTS.get(req.port)
        if owner and owner != p.name:
            return f"A porta {req.port} é do {owner}. Use {p.default_port}."
    return ""


def bootstrap_env(req: DeployRequest, db_password: str) -> str:
    p = req.profile
    upd = req.is_update
    rewrites_site = not upd or not p.update_keeps_nginx
    enable_ssl = req.enable_ssl if rewrites_site else False
    port = "keep" if (upd and p.port_keep_on_update) else str(req.port or p.default_port)
    pairs = [
        f"APP_ARCHIVE={bash_single_quote(p.remote_archive)}",
        f"PUBLIC_URL={bash_single_quote(req.public_url())}",
        f"APP_PORT={bash_single_quote(port)}",
        f"DB_PASSWORD={bash_single_quote(db_password)}",
        f"ENABLE_SSL={'1' if enable_ssl else '0'}",
        f"DOMAIN_NAME={bash_single_quote(req.effective_domain())}",
        f"PUBLIC_DOMAIN={bash_single_quote(req.effective_public_domain())}",
        f"SSL_EMAIL={bash_single_quote(req.ssl_email)}",
        f"MODE={bash_single_quote(req.mode)}",
        f"SKIP_CERTBOT={'0' if rewrites_site else '1'}",
    ]
    for opt in p.options:
        value = opt.on_update if upd else req.options.get(opt.key, opt.default)
        pairs.append(f"{opt.env}={'1' if value else '0'}")
    pairs.extend(p.extra_env)
    return " ".join(pairs)


_STAGES = (
    ("==> [1/", 52, "Pacotes do sistema"),
    ("==> [2/", 60, "Usuário e pastas"),
    ("==> [3/", 66, "Extraindo o aplicativo"),
    ("==> [4/", 70, "Banco de dados"),
    ("==> [5/", 74, "Configurações"),
    ("==> [6/", 80, "Build Node / npm"),
    ("==> [7/", 90, "Nginx e serviço"),
    ("==> [8/", 96, "HTTPS"),
)


def deploy_system(client, req: DeployRequest, progress: ProgressFn, log: LogFn) -> str:
    p = req.profile
    build = local_build_info(req.repo)
    if build.get("commit"):
        log(
            f"Código: {build['commit']} ({build.get('branch')})"
            + (" com alterações não commitadas" if build.get("dirty") else "")
        )
    progress(6, "Empacotando o código…")
    archive = build_archive(p, req.repo)
    log(f"Pacote {archive.name}: {human_size(archive.stat().st_size)}")
    script = bootstrap_bytes(p, req.repo)

    progress(14, "Conferindo a VPS…")
    require_root(client, log)

    sftp = client.open_sftp()
    last = {"mb": -1}

    def on_put(sent: int, total: int) -> None:
        if total <= 0:
            return
        mb = sent // (1024 * 1024)
        if mb != last["mb"] or sent == total:
            last["mb"] = mb
            progress(
                18 + 22 * sent / total,
                f"Enviando o código… {human_size(sent)} de {human_size(total)}",
            )

    sftp.put(str(archive), p.remote_archive, callback=on_put)
    with sftp.file(p.remote_script, "wb") as fh:
        fh.write(script)
    sftp.chmod(p.remote_script, 0o755)
    sftp.close()

    progress(42, "Preparando a VPS (apt, rsync)…")
    code, out = run_remote(
        client,
        "export DEBIAN_FRONTEND=noninteractive; apt-get update -y >/dev/null; "
        "apt-get install -y rsync >/dev/null",
        on_line=log,
    )
    if code != 0:
        raise RuntimeError("Falha ao preparar a VPS (apt/rsync).\n\n" + tail(out, 25))

    db_password = "" if req.is_update else gen_secret(24)
    verb = "Atualizando" if req.is_update else "Instalando"
    progress(50, f"{verb} {p.name}…")

    def on_line(line: str) -> None:
        text = line.strip()
        for marker, pct, label in _STAGES:
            if marker in text:
                progress(pct, f"{label}…")
                break
        if text:
            log(text)

    code, out = run_remote(
        client, f"{bootstrap_env(req, db_password)} bash {p.remote_script}", on_line=on_line
    )
    if code != 0 or (p.ok_marker and p.ok_marker not in out):
        raise RuntimeError(
            "A operação falhou na VPS durante a configuração.\n\n" + tail(out, 40)
        )

    record_event(client, p, req.mode, log, **build)

    final_url = req.public_url()
    for ln in out.splitlines():
        if ln.startswith("PUBLIC_URL="):
            final_url = ln.split("=", 1)[1].strip() or final_url
    if "SSL_REUSED=1" in out:
        ssl_note = "HTTPS reaproveitado (o certificado já estava na VPS)."
    elif "SSL_OK=1" in out:
        ssl_note = "HTTPS ativo no domínio."
    elif req.enable_ssl and not req.is_update:
        ssl_note = "HTTPS não foi ativado. Confira o DNS A do domínio."
    else:
        ssl_note = ""

    lines = [
        f"{'Atualização' if req.is_update else 'Instalação'} de {p.name} concluída.",
        f"Endereço: {final_url or '(domínio configurado na VPS)'}",
        f"Serviço: {p.service} · Pasta: {p.app_dir}",
    ]
    if ssl_note:
        lines.append(ssl_note)
    if not req.is_update:
        lines.append(p.post_install_note)
    return "\n".join(lines)


# --------------------------------------------------------------------------- visão da VPS e histórico

HISTORY_FILE = "/var/lib/central-deploy/history.jsonl"
INFRA_UNITS = (
    "nginx", "postgresql", "redis-server", "livekit", "livekit-server", "livekit-egress",
    "steamfarm-wa", "zapo-gateway", "hbbs", "hbbr", "rustdesk-hbbs", "rustdesk-hbbr",
)


def _git(repo: Path, *args: str) -> str:
    try:
        res = subprocess.run(
            ["git", "-C", str(repo), *args],
            capture_output=True,
            timeout=15,
            creationflags=_no_window(),
        )
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return res.stdout.decode("utf-8", errors="replace").strip() if res.returncode == 0 else ""


def local_build_info(repo: Path) -> dict:
    """Commit/branch do código que está sendo enviado, para o histórico."""
    info = {
        "commit": _git(repo, "rev-parse", "--short", "HEAD"),
        "branch": _git(repo, "rev-parse", "--abbrev-ref", "HEAD"),
        "subject": _git(repo, "log", "-1", "--format=%s")[:120],
        "dirty": bool(_git(repo, "status", "--porcelain", "--untracked-files=no")),
    }
    version_file = repo / "VERSION"
    if version_file.is_file():
        info["version"] = version_file.read_text(encoding="utf-8", errors="ignore").strip()[:40]
    return info


def operator() -> str:
    import platform

    return f"{os.environ.get('USERNAME') or os.environ.get('USER') or '?'}@{platform.node()}"


def record_event(client, profile: SystemProfile, action: str, log: LogFn | None = None, **fields) -> None:
    """Acrescenta uma linha no histórico da VPS. Falha aqui nunca derruba a operação."""
    import time

    event = {"ts": int(time.time()), "system": profile.key, "action": action, "operator": operator()}
    event.update({k: v for k, v in fields.items() if v not in (None, "")})
    folder = HISTORY_FILE.rsplit("/", 1)[0]
    try:
        code, out = run_remote(
            client,
            f"mkdir -p {folder} && cat >> {HISTORY_FILE}",
            stdin_data=(json.dumps(event, ensure_ascii=False) + "\n").encode("utf-8"),
            pty=False,
        )
        if code != 0 and log:
            log(f"Aviso: não gravei o histórico na VPS ({tail(out, 3)})")
    except Exception as exc:  # noqa: BLE001
        if log:
            log(f"Aviso: não gravei o histórico na VPS ({exc})")


REMOTE_OVERVIEW = r'''
import json, os, re, shutil, socket, subprocess, sys, time

spec = json.loads(sys.argv[1])
SKIP = {"node_modules", ".venv", "venv", "data", "uploads", "desktop", "desktop-releases",
        "match-packs", "__pycache__", ".git", "logs"}


def sh(args):
    try:
        r = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=20)
        return r.returncode, r.stdout.decode("utf-8", "replace")
    except Exception:
        return 1, ""


def unit(name):
    props = "LoadState,ActiveState,SubState,ActiveEnterTimestamp,MemoryCurrent,NRestarts"
    code, out = sh(["systemctl", "show", name, "-p", props, "--timestamp=unix"])
    if code != 0:
        code, out = sh(["systemctl", "show", name, "-p", props])
    info = {}
    for ln in out.splitlines():
        k, _, v = ln.partition("=")
        info[k.strip()] = v.strip()
    return info


def listening():
    _code, out = sh(["ss", "-ltn"])
    ports = set()
    for ln in out.splitlines():
        for part in ln.split():
            m = re.search(r":(\d+)$", part)
            if m:
                ports.add(int(m.group(1)))
                break
    return ports


def history():
    try:
        with open(spec["history"], encoding="utf-8") as fh:
            lines = fh.readlines()[-1000:]
    except OSError:
        return []
    out = []
    for ln in lines:
        try:
            out.append(json.loads(ln))
        except ValueError:
            pass
    return out


def read_env(path, key):
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            for ln in fh:
                if ln.startswith(key + "="):
                    return ln.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    return ""


def feed_version(d):
    try:
        with open(os.path.join(d, "latest.yml"), encoding="utf-8") as fh:
            m = re.search(r"^version:\s*(.+)$", fh.read(), re.M)
            return m.group(1).strip().strip("'\"") if m else ""
    except OSError:
        return ""


def last_write(d):
    """Quando o código foi gravado pela última vez (ctime), sem olhar dados de runtime."""
    newest = 0
    for root, dirs, files in os.walk(d):
        depth = root[len(d):].count(os.sep)
        dirs[:] = [x for x in dirs if x not in SKIP and depth < 3]
        for f in files:
            if f.endswith((".log", ".db", ".sqlite", ".pid")) or f.startswith(".env"):
                continue
            try:
                newest = max(newest, int(os.stat(os.path.join(root, f)).st_ctime))
            except OSError:
                pass
    return newest


ports = listening()
hist = history()
systems = []
for s in spec["systems"]:
    d = s["app_dir"]
    installed = os.path.isdir(d)
    mine = [h for h in hist if h.get("system") == s["key"]]
    deploys = [h for h in mine if h.get("action") in ("install", "update")]
    systems.append({
        "key": s["key"],
        "installed": installed,
        "unit": unit(s["service"]),
        "port": s["port"],
        "port_open": s["port"] in ports,
        "public_url": read_env(os.path.join(d, ".env"), "PUBLIC_URL") if installed else "",
        "code_written": last_write(d) if installed else 0,
        "last_deploy": deploys[-1] if deploys else None,
        "feed": feed_version(s["feed_dir"]) if s.get("feed_dir") else "",
    })

infra = []
for name in spec["infra"]:
    u = unit(name)
    if u.get("LoadState") not in ("", "not-found"):
        infra.append({"name": name, "unit": u})

known = set(os.path.basename(s["app_dir"]) for s in spec["systems"])
try:
    others = sorted(n for n in os.listdir("/opt") if n not in known and not n.startswith("."))
except OSError:
    others = []

mem = {}
try:
    with open("/proc/meminfo") as fh:
        for ln in fh:
            k, _, v = ln.partition(":")
            if k in ("MemTotal", "MemAvailable"):
                mem[k] = int(v.split()[0]) * 1024
except OSError:
    pass
osname = ""
try:
    with open("/etc/os-release") as fh:
        m = re.search(r'^PRETTY_NAME="?([^"\n]+)', fh.read(), re.M)
        osname = m.group(1) if m else ""
except OSError:
    pass
try:
    with open("/proc/uptime") as fh:
        uptime = float(fh.read().split()[0])
except (OSError, ValueError):
    uptime = 0
du = shutil.disk_usage("/")
print(json.dumps({
    "ok": True, "now": int(time.time()), "host": socket.gethostname(), "os": osname,
    "uptime": uptime, "load": list(os.getloadavg()), "mem": mem,
    "disk": {"free": du.free, "total": du.total}, "systems": systems, "infra": infra,
    "others": others, "history": hist[-300:],
}))
'''


def vps_overview(client) -> dict:
    spec = {
        "history": HISTORY_FILE,
        "infra": list(INFRA_UNITS),
        "systems": [
            {
                "key": p.key,
                "service": p.service,
                "app_dir": p.app_dir,
                "port": p.default_port,
                "feed_dir": p.desktop.served_dirs[0] if p.desktop else "",
            }
            for p in PROFILES
        ],
    }
    cmd = "python3 - " + shlex.quote(json.dumps(spec))
    _code, out = run_remote(client, cmd, stdin_data=REMOTE_OVERVIEW.encode(), pty=False)
    for line in reversed(out.splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                return json.loads(line)
            except ValueError:
                break
    raise RuntimeError("Não consegui ler o estado da VPS:\n" + tail(out, 12))


def unit_since(unit: dict) -> int:
    """ActiveEnterTimestamp em epoch (0 se não der para ler)."""
    raw = (unit or {}).get("ActiveEnterTimestamp", "")
    if raw.startswith("@"):
        try:
            return int(float(raw[1:]))
        except ValueError:
            return 0
    return 0


# --------------------------------------------------------------------------- feed do Electron na VPS

# Roda na VPS com python3 (stdin). Só usa a biblioteca padrão.
REMOTE_FEED_HELPER = r'''
import base64, datetime, hashlib, json, os, re, shutil, sys


def out(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def vkey(v):
    core, _, pre = v.partition("-")
    nums = [int(p) if p.isdigit() else 0 for p in core.split(".")]
    return (nums, 0 if pre else 1, pre)


def read_feed(d):
    try:
        with open(os.path.join(d, "latest.yml"), encoding="utf-8") as fh:
            txt = fh.read()
    except OSError:
        return None
    ver = re.search(r"^version:\s*(.+)$", txt, re.M)
    path = re.search(r"^path:\s*(.+)$", txt, re.M)
    return {
        "version": ver.group(1).strip().strip("'\"") if ver else "",
        "path": path.group(1).strip().strip("'\"") if path else "",
    }


def match_owner(path, d):
    try:
        st = os.stat(d)
        os.chown(path, st.st_uid, st.st_gid)
    except (OSError, AttributeError):
        pass
    os.chmod(path, 0o644)


def place(src, d, name):
    dst = os.path.join(d, name)
    tmp = dst + ".part"
    shutil.copyfile(src, tmp)
    match_owner(tmp, d)
    os.replace(tmp, dst)


def sha512_b64(path):
    h = hashlib.sha512()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return base64.b64encode(h.digest()).decode()


def write_feed(d, text, stamp):
    target = os.path.join(d, "latest.yml")
    if os.path.isfile(target):
        shutil.copy2(target, target + ".bak-" + stamp)
    tmp = target + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(text)
    match_owner(tmp, d)
    os.replace(tmp, target)
    baks = sorted(n for n in os.listdir(d) if n.startswith("latest.yml.bak-"))
    for old in baks[:-5]:
        try:
            os.remove(os.path.join(d, old))
        except OSError:
            pass


def main():
    op, prefix, served_raw, shadow_raw = sys.argv[1:5]
    args = sys.argv[5:]
    served = [d for d in served_raw.split(":") if d and os.path.isdir(d)]
    shadow = [d for d in shadow_raw.split(":") if d and os.path.isdir(d)]
    if not served:
        return out({"ok": False, "error": "feed_dir_missing", "detail": served_raw})
    primary = served[0]
    pat = re.compile(
        "^" + re.escape(prefix)
        + r"-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)-(x64|ia32|arm64)\.exe$"
    )
    feed = read_feed(primary)
    current = feed["path"] if feed else ""

    if op == "list":
        found = {}
        for d in served + shadow:
            for name in os.listdir(d):
                m = pat.match(name)
                if not m:
                    continue
                full = os.path.join(d, name)
                st = os.stat(full)
                e = found.setdefault(name, {
                    "file": name, "version": m.group(1), "size": st.st_size,
                    "mtime": 0, "dirs": [], "blockmap": False,
                })
                e["mtime"] = max(e["mtime"], int(st.st_mtime))
                e["dirs"].append(d)
                if os.path.isfile(full + ".blockmap"):
                    e["blockmap"] = True
        versions = sorted(found.values(), key=lambda e: vkey(e["version"]), reverse=True)
        du = shutil.disk_usage(primary)
        return out({
            "ok": True, "primary": primary, "served": served, "shadow": shadow,
            "current": feed, "versions": versions, "free": du.free, "total": du.total,
        })

    if op == "commit":
        for name in args:
            part = os.path.join(primary, name + ".part")
            if not os.path.isfile(part):
                return out({"ok": False, "error": "part_missing", "detail": name})
        for name in args:
            part = os.path.join(primary, name + ".part")
            match_owner(part, primary)
            os.replace(part, os.path.join(primary, name))
        for d in served[1:]:
            for name in args:
                place(os.path.join(primary, name), d, name)
        return out({"ok": True, "mirrors": served[1:]})

    if op == "set-default":
        name = args[0]
        expected = args[1] if len(args) > 1 else ""
        m = pat.match(name)
        src = os.path.join(primary, name)
        if not m or not os.path.isfile(src):
            return out({"ok": False, "error": "not_found", "detail": name})
        digest = sha512_b64(src)
        if expected and expected != digest:
            return out({"ok": False, "error": "sha_mismatch", "detail": name})
        size = os.path.getsize(src)
        now = datetime.datetime.now(datetime.timezone.utc)
        text = (
            "version: %s\nfiles:\n  - url: %s\n    sha512: %s\n    size: %d\n"
            "path: %s\nsha512: %s\nreleaseDate: '%s'\n"
        ) % (m.group(1), name, digest, size, name, digest,
             now.strftime("%Y-%m-%dT%H:%M:%S.000Z"))
        stamp = now.strftime("%Y%m%d-%H%M%S")
        for d in served[1:]:
            for n in (name, name + ".blockmap"):
                s = os.path.join(primary, n)
                if os.path.isfile(s) and not os.path.isfile(os.path.join(d, n)):
                    place(s, d, n)
        for d in served:
            write_feed(d, text, stamp)
        for d in shadow:
            if os.path.isfile(os.path.join(d, "latest.yml")):
                write_feed(d, text, stamp)
        return out({"ok": True, "version": m.group(1), "previous": feed, "size": size})

    if op == "delete":
        for name in args:
            if not pat.match(name):
                return out({"ok": False, "error": "bad_name", "detail": name})
            if name == current:
                return out({"ok": False, "error": "is_default", "detail": name})
        removed, freed = [], 0
        for name in args:
            for d in served + shadow:
                for n in (name, name + ".blockmap"):
                    p = os.path.join(d, n)
                    if os.path.isfile(p):
                        freed += os.path.getsize(p)
                        os.remove(p)
                        removed.append(p)
        return out({"ok": True, "removed": removed, "freed": freed})

    return out({"ok": False, "error": "unknown_op", "detail": op})


try:
    main()
except Exception as exc:
    out({"ok": False, "error": "exception", "detail": repr(exc)})
'''

FEED_ERRORS = {
    "feed_dir_missing": "A pasta do feed não existe na VPS. O sistema já foi instalado?",
    "part_missing": "O arquivo enviado não chegou inteiro na VPS.",
    "not_found": "Esse instalador não está na VPS.",
    "sha_mismatch": "O arquivo na VPS não bate com o build local (hash diferente). Envie de novo.",
    "is_default": "Essa é a versão padrão. Defina outra como padrão antes de excluir.",
    "bad_name": "Nome de arquivo inválido.",
}


class FeedError(RuntimeError):
    pass


def feed_call(client, desktop: DesktopProfile, op: str, *args: str) -> dict:
    argv = [
        op,
        desktop.artifact_prefix,
        ":".join(desktop.served_dirs),
        ":".join(desktop.shadow_dirs),
        *args,
    ]
    cmd = "python3 - " + " ".join(shlex.quote(a) for a in argv)
    _code, out = run_remote(client, cmd, stdin_data=REMOTE_FEED_HELPER.encode(), pty=False)
    data = None
    for line in reversed(out.splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                data = json.loads(line)
                break
            except ValueError:
                continue
    if data is None:
        raise FeedError("Resposta inesperada da VPS:\n" + tail(out, 15))
    if not data.get("ok"):
        err = data.get("error", "")
        msg = FEED_ERRORS.get(err, f"Erro na VPS: {err}")
        detail = data.get("detail")
        raise FeedError(f"{msg}\n({detail})" if detail else msg)
    return data


def upload_release(
    client, desktop: DesktopProfile, files: list[Path], progress: ProgressFn, lo: float, hi: float
) -> None:
    primary = desktop.served_dirs[0]
    run_remote(client, f"mkdir -p {shlex.quote(primary)}", pty=False)
    total = sum(f.stat().st_size for f in files) or 1
    done = 0
    sftp = client.open_sftp()
    try:
        for f in files:
            base = done
            last = {"mb": -1}

            def on_put(sent: int, _total: int, base=base, name=f.name) -> None:
                mb = sent // (1024 * 1024)
                if mb != last["mb"]:
                    last["mb"] = mb
                    frac = (base + sent) / total
                    progress(
                        lo + (hi - lo) * frac,
                        f"Enviando {name}… {human_size(base + sent)} de {human_size(total)}",
                    )

            # Sobe como .part: a API só serve .exe/.yml/.blockmap, então nada incompleto vaza
            sftp.put(str(f), f"{primary}/{f.name}.part", callback=on_put)
            done += f.stat().st_size
    finally:
        sftp.close()
    feed_call(client, desktop, "commit", *[f.name for f in files])


# --------------------------------------------------------------------------- build local do Electron

PKG_VERSION_RE = re.compile(r'("version"\s*:\s*")([^"]+)(")')


def read_desktop_version(repo: Path, desktop: DesktopProfile) -> str:
    text = (repo / desktop.package_json).read_text(encoding="utf-8")
    m = PKG_VERSION_RE.search(text)
    return m.group(2) if m else ""


def write_desktop_version(repo: Path, desktop: DesktopProfile, version: str) -> str:
    """Troca a versão no package.json do desktop e devolve o texto antigo (para desfazer)."""
    path = repo / desktop.package_json
    old = path.read_text(encoding="utf-8")
    new, n = PKG_VERSION_RE.subn(lambda m: f"{m.group(1)}{version}{m.group(3)}", old, count=1)
    if n != 1:
        raise RuntimeError(f'Campo "version" não encontrado em {path}')
    path.write_text(new, encoding="utf-8")
    return old


def restore_desktop_package(repo: Path, desktop: DesktopProfile, old_text: str) -> None:
    (repo / desktop.package_json).write_text(old_text, encoding="utf-8")


def read_local_feed(repo: Path, desktop: DesktopProfile) -> dict | None:
    yml = repo / desktop.releases_dir / "latest.yml"
    try:
        text = yml.read_text(encoding="utf-8")
    except OSError:
        return None
    info = {}
    for key in ("version", "path", "sha512"):
        m = re.search(rf"^{key}:\s*(.+)$", text, re.M)
        info[key] = m.group(1).strip().strip("'\"") if m else ""
    return info


def local_release(repo: Path, desktop: DesktopProfile, version: str | None = None):
    """Devolve (arquivos para subir, sha512) do último build copiado para desktop-releases/."""
    info = read_local_feed(repo, desktop)
    if not info or not info.get("path"):
        raise RuntimeError(
            f"Não achei {desktop.releases_dir}/latest.yml. Gere o instalador primeiro."
        )
    if version and info["version"] != version:
        raise RuntimeError(
            f"O latest.yml local está na versão {info['version']}, esperava {version}."
        )
    exe = repo / desktop.releases_dir / info["path"]
    if not exe.is_file():
        raise RuntimeError(f"Instalador ausente: {exe}")
    files = [exe]
    blockmap = exe.with_name(exe.name + ".blockmap")
    if blockmap.is_file():
        files.append(blockmap)
    return files, info.get("sha512", ""), info["version"]


def run_local(cmd: str, cwd: Path, on_line: LogFn) -> int:
    env = dict(os.environ, FORCE_COLOR="0", NO_COLOR="1")
    proc = subprocess.Popen(
        cmd,
        cwd=str(cwd),
        shell=True,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        env=env,
        creationflags=_no_window(),
    )
    assert proc.stdout is not None
    for raw in iter(proc.stdout.readline, b""):
        line = strip_ansi(raw.decode("utf-8", errors="replace")).rstrip()
        if line:
            on_line(line)
    return proc.wait()
