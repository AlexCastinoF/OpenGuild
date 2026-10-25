#!/usr/bin/env bash
# SteamFarm Comunidade React — bootstrap na VPS (Ubuntu/Debian).
# Isolado do Flask SteamFarm (/opt/steamfarm :5050) e de WoulzMeeting.
# Padrão: /opt/steamfarm-react :5071 · rooms LiveKit sfr-* · cookie sf_react_token
# DB: REUSE_STEAMFARM_DB=1 → Postgres legado; =0 → cria steamfarm_react local.
set -euo pipefail

APP_ARCHIVE="${APP_ARCHIVE:-/tmp/steamfarm-react.tgz}"
APP_DIR="/opt/steamfarm-react"
APP_USER="steamfarmreact"
APP_PORT="${APP_PORT:-5071}"
DOMAIN_NAME="${DOMAIN_NAME:-}"
SSL_EMAIL="${SSL_EMAIL:-}"
ENABLE_SSL="${ENABLE_SSL:-1}"
PUBLIC_URL="${PUBLIC_URL:-}"
SITE_NAME="steamfarm-react"
SERVICE_NAME="steamfarm-react"
MODE="${MODE:-install}"
SKIP_CERTBOT="${SKIP_CERTBOT:-0}"
REUSE_LIVEKIT="${REUSE_LIVEKIT:-1}"
REUSE_STEAMFARM_DB="${REUSE_STEAMFARM_DB:-1}"
LIVEKIT_ROOM_PREFIX="${LIVEKIT_ROOM_PREFIX:-sfr}"
LIVEKIT_IDENTITY_PREFIX="${LIVEKIT_IDENTITY_PREFIX:-sfr}"
AUTH_COOKIE_NAME="${AUTH_COOKIE_NAME:-sf_react_token}"
NODE_MAJOR="${NODE_MAJOR:-22}"
STEAMFARM_ENV="${STEAMFARM_ENV:-/opt/steamfarm/.env}"

export DEBIAN_FRONTEND=noninteractive

log() { echo "==> $*"; }

wait_apt() {
  local i
  for i in $(seq 1 60); do
    if ! fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1 \
      && ! fuser /var/lib/apt/lists/lock >/dev/null 2>&1; then
      return 0
    fi
    echo "Aguardando liberação do apt (${i}/60)..."
    sleep 5
  done
}

need_root() {
  if [[ "$(id -u)" != "0" ]]; then
    echo "ERRO: rode como root"
    exit 1
  fi
}

write_nginx_http() {
  local domain="$1"
  local port="$2"
  local web_root="$3"
  cat > "/etc/nginx/sites-available/${SITE_NAME}" <<NGX
server {
    listen 80;
    listen [::]:80;
    server_name ${domain};

    client_max_body_size 200m;
    root ${web_root};
    index index.html;

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/certbot;
        default_type "text/plain";
        allow all;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    location /steam/ {
        proxy_pass http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 120s;
    }

    location /uploads/ {
        proxy_pass http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location /socket.io/ {
        proxy_pass http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 3600s;
    }

    location /ws/ {
        proxy_pass http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_read_timeout 3600s;
    }

    location /desktop/ {
        proxy_pass http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location = /index.html {
        add_header Cache-Control "no-store, no-cache, must-revalidate" always;
        try_files /index.html =404;
    }

    location / {
        add_header Cache-Control "no-cache" always;
        try_files \$uri \$uri/ /index.html;
    }
}
NGX
}

write_nginx_https() {
  local domain="$1"
  local port="$2"
  local web_root="$3"
  cat > "/etc/nginx/sites-available/${SITE_NAME}" <<NGX
server {
    listen 80;
    listen [::]:80;
    server_name ${domain};

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/certbot;
        default_type "text/plain";
        allow all;
    }

    location / {
        return 301 https://\$host\$request_uri;
    }
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name ${domain};

    ssl_certificate /etc/letsencrypt/live/${domain}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${domain}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;

    client_max_body_size 200m;
    root ${web_root};
    index index.html;

    location /api/ {
        proxy_pass http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    location /steam/ {
        proxy_pass http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 120s;
    }

    location /uploads/ {
        proxy_pass http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location /socket.io/ {
        proxy_pass http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 3600s;
    }

    location /ws/ {
        proxy_pass http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_read_timeout 3600s;
    }

    location /desktop/ {
        proxy_pass http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location = /index.html {
        add_header Cache-Control "no-store, no-cache, must-revalidate" always;
        try_files /index.html =404;
    }

    location / {
        add_header Cache-Control "no-cache" always;
        try_files \$uri \$uri/ /index.html;
    }
}
NGX
}

nginx_domain_claimed_elsewhere() {
  local domain="$1"
  local f
  shopt -s nullglob
  for f in /etc/nginx/sites-enabled/* /etc/nginx/conf.d/*.conf; do
    [[ -e "$f" ]] || continue
    if [[ "$(basename "$f")" == "$SITE_NAME" ]]; then
      continue
    fi
    if grep -Eiq "server_name[[:space:]]+([^;]*[[:space:]])?${domain}([;[:space:]]|$)" "$f" 2>/dev/null; then
      echo "$f"
      return 0
    fi
  done
  return 1
}

reload_nginx_safe() {
  if nginx -t; then
    systemctl reload nginx
    return 0
  fi
  echo "ERRO: nginx -t falhou — desabilitando só o site ${SITE_NAME}"
  rm -f "/etc/nginx/sites-enabled/${SITE_NAME}"
  nginx -t && systemctl reload nginx || true
  return 1
}

copy_kv_from_env() {
  local src="$1"
  local dest="$2"
  local pattern="$3"
  local tmp="/tmp/sfr-env-copy.$$"
  [[ -f "$src" ]] || return 1
  grep -E "$pattern" "$src" >"$tmp" || true
  if [[ ! -s "$tmp" ]]; then
    rm -f "$tmp"
    return 1
  fi
  touch "$dest"
  while IFS= read -r line; do
    local key="${line%%=*}"
    if grep -q "^${key}=" "$dest" 2>/dev/null; then
      sed -i "s|^${key}=.*|${line}|" "$dest"
    else
      echo "$line" >> "$dest"
    fi
  done < "$tmp"
  rm -f "$tmp"
  return 0
}

copy_livekit_from_env() {
  local src="$1"
  local dest="$2"
  if copy_kv_from_env "$src" "$dest" '^LIVEKIT_(URL|API_URL|API_KEY|API_SECRET)='; then
    echo "LIVEKIT_REUSED=1 (de $src) · rooms prefix=${LIVEKIT_ROOM_PREFIX}"
    return 0
  fi
  return 1
}

ensure_node() {
  if command -v node >/dev/null 2>&1; then
    local major
    major="$(node -v | sed -E 's/^v([0-9]+).*/\1/')"
    if [[ "$major" -ge 20 ]]; then
      echo "NODE_OK=$(node -v)"
      return 0
    fi
  fi
  log "Instalando Node.js ${NODE_MAJOR}.x"
  wait_apt
  apt-get install -y ca-certificates curl gnupg
  mkdir -p /etc/apt/keyrings
  curl -fsSL "https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key" \
    | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -y
  apt-get install -y nodejs
  echo "NODE_OK=$(node -v)"
}

resolve_steamfarm_database_url() {
  normalize_pg_url() {
    local url="$1"
    # SQLAlchemy drivers → Prisma
    url="${url//postgresql+psycopg2:\/\//postgresql:\/\/}"
    url="${url//postgresql+psycopg:\/\//postgresql:\/\/}"
    url="${url//postgres+psycopg2:\/\//postgresql:\/\/}"
    url="${url//postgres+psycopg:\/\//postgresql:\/\/}"
    url="${url//postgres:\/\//postgresql:\/\/}"
    # strip surrounding quotes
    url="${url%\"}"
    url="${url#\"}"
    url="${url%\'}"
    url="${url#\'}"
    printf '%s' "$url"
  }

  ensure_local_postgres() {
    local pass="${DB_PASSWORD:-}"
    local dbname="${DB_NAME:-steamfarm_react}"
    local dbuser="${DB_USER:-steamfarmreact}"
    if [[ -z "$pass" ]]; then
      pass="$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')"
    fi
    wait_apt
    apt-get install -y postgresql postgresql-contrib
    systemctl enable --now postgresql
    if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='${dbuser}'" | grep -q 1; then
      sudo -u postgres psql -v ON_ERROR_STOP=1 -c "CREATE USER ${dbuser} WITH PASSWORD '${pass}';"
    else
      sudo -u postgres psql -v ON_ERROR_STOP=1 -c "ALTER USER ${dbuser} WITH PASSWORD '${pass}';"
    fi
    if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${dbname}'" | grep -q 1; then
      sudo -u postgres psql -v ON_ERROR_STOP=1 -c "CREATE DATABASE ${dbname} OWNER ${dbuser};"
    fi
    DATABASE_URL="postgresql://${dbuser}:${pass}@127.0.0.1:5432/${dbname}"
    echo "DB_CREATE=1 (Postgres local ${dbname})"
  }

  if [[ -f "$APP_DIR/.env" ]] && grep -q '^DATABASE_URL=' "$APP_DIR/.env" 2>/dev/null; then
    DATABASE_URL="$(normalize_pg_url "$(grep '^DATABASE_URL=' "$APP_DIR/.env" | head -1 | cut -d= -f2-)")"
    if [[ "$DATABASE_URL" == postgresql://* || "$DATABASE_URL" == postgres://* ]]; then
      echo "DB_REUSE=1 (env do app, normalizado)"
      return 0
    fi
  fi
  if [[ "$REUSE_STEAMFARM_DB" == "1" && -f "$STEAMFARM_ENV" ]]; then
    local url
    url="$(grep -E '^DATABASE_URL=' "$STEAMFARM_ENV" | head -1 | cut -d= -f2- || true)"
    url="$(normalize_pg_url "$url")"
    if [[ -n "$url" && ( "$url" == postgresql://* || "$url" == postgres://* ) ]]; then
      DATABASE_URL="$url"
      echo "DB_REUSE=1 (de $STEAMFARM_ENV → steamfarm legado)"
      return 0
    fi
    for key in SQLALCHEMY_DATABASE_URI DATABASE_URI POSTGRES_URL; do
      url="$(grep -E "^${key}=" "$STEAMFARM_ENV" | head -1 | cut -d= -f2- || true)"
      url="$(normalize_pg_url "$url")"
      if [[ -n "$url" && ( "$url" == postgresql://* || "$url" == postgres://* ) ]]; then
        DATABASE_URL="$url"
        echo "DB_REUSE=1 (de $STEAMFARM_ENV chave ${key})"
        return 0
      fi
    done
    echo "WARN: REUSE_STEAMFARM_DB=1 mas não achou DATABASE_URL em $STEAMFARM_ENV — criando Postgres local."
  fi
  # VPS limpa / sem Flask: cria banco próprio e usa prisma db push
  REUSE_STEAMFARM_DB=0
  ensure_local_postgres
}

need_root

if [[ -z "$DOMAIN_NAME" && -f "/etc/nginx/sites-available/${SITE_NAME}" ]]; then
  DOMAIN_NAME="$(awk '/server_name/ {print $2; exit}' "/etc/nginx/sites-available/${SITE_NAME}" | tr -d ';')"
fi
if [[ -z "$DOMAIN_NAME" && -f "$APP_DIR/.env" ]]; then
  DOMAIN_NAME="$(grep -E '^PUBLIC_URL=' "$APP_DIR/.env" | head -1 | cut -d= -f2- | sed -E 's#https?://##; s#/.*##; s/:.*##')"
fi

if [[ -z "$APP_PORT" || "$APP_PORT" == "keep" ]] && [[ -f "$APP_DIR/.env" ]]; then
  APP_PORT="$(grep -E '^PORT=' "$APP_DIR/.env" | head -1 | cut -d= -f2- || true)"
  APP_PORT="${APP_PORT:-5071}"
fi

if [[ "$MODE" == "update" && ! -d "$APP_DIR" ]]; then
  echo "ERRO: SteamFarm React ainda não está instalado. Use MODE=install."
  exit 1
fi

if [[ -z "$DOMAIN_NAME" ]]; then
  echo "ERRO: DOMAIN_NAME é obrigatório (vhost Nginx isolado por domínio)."
  exit 1
fi

if [[ ! "$APP_PORT" =~ ^[0-9]+$ ]] || [[ "$APP_PORT" -lt 1024 ]] || [[ "$APP_PORT" -gt 65535 ]]; then
  echo "ERRO: APP_PORT inválida: $APP_PORT"
  exit 1
fi

if [[ "$APP_PORT" == "5050" || "$APP_PORT" == "5060" || "$APP_PORT" == "5070" ]]; then
  echo "ERRO: portas 5050/5060/5070 reservadas (SteamFarm / Meeting / Woulz React). Use 5071."
  exit 1
fi

log "[1/8] Pacotes do sistema"
if [[ "$MODE" == "update" ]]; then
  echo "Atualização: pulando apt (exceto node se preciso)"
  ensure_node
else
  wait_apt
  apt-get update -y
  apt-get install -y nginx rsync curl ca-certificates build-essential python3
  apt-get install -y certbot python3-certbot-nginx || true
  mkdir -p /var/www/certbot
  systemctl enable --now nginx
  ensure_node
fi

if [[ "$MODE" != "update" ]]; then
  claimed="$(nginx_domain_claimed_elsewhere "$DOMAIN_NAME" || true)"
  if [[ -n "$claimed" ]]; then
    echo "ERRO: o domínio ${DOMAIN_NAME} já está no Nginx em: ${claimed}"
    echo "Use um subdomínio só do SteamFarm React (ex.: chat.example.com)."
    exit 1
  fi
fi

if ss -lnt 2>/dev/null | grep -qE ":${APP_PORT}[[:space:]]" || \
   ss -lntH 2>/dev/null | awk '{print $4}' | grep -qE ":${APP_PORT}$"; then
  if ! systemctl is-active --quiet "$SERVICE_NAME"; then
    echo "ERRO: a porta ${APP_PORT} já está em uso nesta VPS."
    echo "Escolha outra (SteamFarm=5050, Meeting=5060, Woulz React=5070, SteamFarm React=5071)."
    ss -lntp | grep ":${APP_PORT}" || true
    exit 1
  fi
fi

log "[2/8] Usuário e diretórios"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR" "$APP_DIR/data" "$APP_DIR/apps/api/uploads" "$APP_DIR/desktop" "$APP_DIR/desktop-releases" "$APP_DIR/match-packs"
# nginx (www-data) precisa de traverse em APP_DIR para servir apps/web/dist
chmod 755 "$APP_DIR"

log "[3/8] Extração do aplicativo"
if [[ ! -f "$APP_ARCHIVE" ]]; then
  echo "ERRO: arquivo não encontrado: $APP_ARCHIVE"
  exit 1
fi

# Para o serviço ANTES do rsync/build — evita 404 enquanto o Vite apaga dist/
if systemctl list-unit-files "${SERVICE_NAME}.service" >/dev/null 2>&1; then
  systemctl stop "$SERVICE_NAME" || true
fi

TMP_EXTRACT="$(mktemp -d)"
tar -xzf "$APP_ARCHIVE" -C "$TMP_EXTRACT"
SRC="$TMP_EXTRACT"
if [[ -d "$TMP_EXTRACT/SteamFarmReact" ]]; then
  SRC="$TMP_EXTRACT/SteamFarmReact"
fi

# Protege dist/uploads/.env: nunca apagar com --delete
rsync -a --delete \
  --exclude 'node_modules/' \
  --exclude 'apps/*/node_modules/' \
  --exclude 'packages/*/node_modules/' \
  --exclude 'apps/*/dist/' \
  --exclude 'apps/*/dist-next/' \
  --exclude 'packages/*/dist/' \
  --exclude 'data/' \
  --exclude 'uploads/' \
  --exclude 'apps/api/uploads/' \
  --exclude '.env' \
  --exclude '.git/' \
  --exclude 'installer-win/' \
  --exclude 'apps/desktop/' \
  --exclude 'apps/desktop/dist/' \
  --exclude 'apps/desktop/node_modules/' \
  --exclude 'desktop/' \
  --exclude 'desktop-releases/' \
  --filter 'P apps/web/dist/' \
  --filter 'P apps/web/dist/***' \
  --filter 'P apps/api/dist/' \
  --filter 'P apps/api/dist/***' \
  "$SRC/" "$APP_DIR/"

mkdir -p "$APP_DIR/data" "$APP_DIR/apps/api/uploads" "$APP_DIR/desktop" "$APP_DIR/desktop-releases" "$APP_DIR/match-packs"
if [[ -d "$APP_DIR/desktop-releases" ]] && [[ -n "$(ls -A "$APP_DIR/desktop-releases" 2>/dev/null || true)" ]]; then
  rsync -a "$APP_DIR/desktop-releases/" "$APP_DIR/desktop/" || true
fi
# Packs de partida (DLL + manifest) — mantém versões já publicadas se o tarball não trouxer pasta
if [[ -d "$SRC/match-packs" ]]; then
  rsync -a "$SRC/match-packs/" "$APP_DIR/match-packs/"
fi
rm -rf "$TMP_EXTRACT"

log "[4/8] Banco PostgreSQL (reusa steamfarm legado — sem criar DB novo)"
resolve_steamfarm_database_url

log "[5/8] Variáveis de ambiente"
PUBLIC_URL="${PUBLIC_URL:-https://${DOMAIN_NAME}}"
ENV_FILE="$APP_DIR/.env"
JWT_SECRET_VAL="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
if [[ ! -f "$ENV_FILE" ]]; then
  cat > "$ENV_FILE" <<EOF
PUBLIC_URL=${PUBLIC_URL}
PUBLIC_BASE_URL=${PUBLIC_URL}
PORT=${APP_PORT}
DATABASE_URL=${DATABASE_URL}
ZAPO_DATABASE_URL=${DATABASE_URL}
JWT_SECRET=${JWT_SECRET_VAL}
COOKIE_SECURE=true
CORS_ORIGIN=${PUBLIC_URL}
AUTH_COOKIE_NAME=${AUTH_COOKIE_NAME}
DESKTOP_COOKIE_NAME=sf_react_desktop
DESKTOP_RELEASES_DIR=${APP_DIR}/desktop
LIVEKIT_ROOM_PREFIX=${LIVEKIT_ROOM_PREFIX}
LIVEKIT_IDENTITY_PREFIX=${LIVEKIT_IDENTITY_PREFIX}
REDIS_URL=
EOF
else
  touch "$ENV_FILE"
  grep -q '^PUBLIC_URL=' "$ENV_FILE" || echo "PUBLIC_URL=${PUBLIC_URL}" >> "$ENV_FILE"
  grep -q '^PUBLIC_BASE_URL=' "$ENV_FILE" || echo "PUBLIC_BASE_URL=${PUBLIC_URL}" >> "$ENV_FILE"
  grep -q '^PORT=' "$ENV_FILE" || echo "PORT=${APP_PORT}" >> "$ENV_FILE"
  grep -q '^DATABASE_URL=' "$ENV_FILE" || echo "DATABASE_URL=${DATABASE_URL}" >> "$ENV_FILE"
  grep -q '^ZAPO_DATABASE_URL=' "$ENV_FILE" || echo "ZAPO_DATABASE_URL=${DATABASE_URL}" >> "$ENV_FILE"
  grep -q '^JWT_SECRET=' "$ENV_FILE" || echo "JWT_SECRET=${JWT_SECRET_VAL}" >> "$ENV_FILE"
  grep -q '^AUTH_COOKIE_NAME=' "$ENV_FILE" || echo "AUTH_COOKIE_NAME=${AUTH_COOKIE_NAME}" >> "$ENV_FILE"
  grep -q '^DESKTOP_RELEASES_DIR=' "$ENV_FILE" || echo "DESKTOP_RELEASES_DIR=${APP_DIR}/desktop" >> "$ENV_FILE"
  grep -q '^LIVEKIT_ROOM_PREFIX=' "$ENV_FILE" || echo "LIVEKIT_ROOM_PREFIX=${LIVEKIT_ROOM_PREFIX}" >> "$ENV_FILE"
  grep -q '^LIVEKIT_IDENTITY_PREFIX=' "$ENV_FILE" || echo "LIVEKIT_IDENTITY_PREFIX=${LIVEKIT_IDENTITY_PREFIX}" >> "$ENV_FILE"
  sed -i "s|^PUBLIC_URL=.*|PUBLIC_URL=${PUBLIC_URL}|" "$ENV_FILE"
  sed -i "s|^PUBLIC_BASE_URL=.*|PUBLIC_BASE_URL=${PUBLIC_URL}|" "$ENV_FILE"
  sed -i "s|^PORT=.*|PORT=${APP_PORT}|" "$ENV_FILE"
  if grep -q '^DATABASE_URL=file:' "$ENV_FILE" 2>/dev/null || ! grep -q '^DATABASE_URL=postgresql' "$ENV_FILE" 2>/dev/null; then
    sed -i "s|^DATABASE_URL=.*|DATABASE_URL=${DATABASE_URL}|" "$ENV_FILE" || echo "DATABASE_URL=${DATABASE_URL}" >> "$ENV_FILE"
  fi
  sed -i "s|^CORS_ORIGIN=.*|CORS_ORIGIN=${PUBLIC_URL}|" "$ENV_FILE" || echo "CORS_ORIGIN=${PUBLIC_URL}" >> "$ENV_FILE"
  sed -i "s|^COOKIE_SECURE=.*|COOKIE_SECURE=true|" "$ENV_FILE" || echo "COOKIE_SECURE=true" >> "$ENV_FILE"
  sed -i "s|^DESKTOP_RELEASES_DIR=.*|DESKTOP_RELEASES_DIR=${APP_DIR}/desktop|" "$ENV_FILE" || echo "DESKTOP_RELEASES_DIR=${APP_DIR}/desktop" >> "$ENV_FILE"
fi

# Reaproveita secret/gateway WA do SteamFarm se existir
if [[ -f "$STEAMFARM_ENV" ]]; then
  copy_kv_from_env "$STEAMFARM_ENV" "$ENV_FILE" '^ZAPO_(GATEWAY_SECRET|PORT|DATABASE_URL)=' || true
  # Se ZAPO_DATABASE_URL ainda vazio, espelha DATABASE_URL
  if ! grep -q '^ZAPO_DATABASE_URL=postgresql' "$ENV_FILE" 2>/dev/null; then
    echo "ZAPO_DATABASE_URL=${DATABASE_URL}" >> "$ENV_FILE"
  fi
fi

# Sempre re-normaliza DATABASE_URL (postgresql+psycopg → postgresql)
DATABASE_URL="$(grep '^DATABASE_URL=' "$ENV_FILE" | head -1 | cut -d= -f2- || true)"
DATABASE_URL="${DATABASE_URL//postgresql+psycopg2:\/\//postgresql:\/\/}"
DATABASE_URL="${DATABASE_URL//postgresql+psycopg:\/\//postgresql:\/\/}"
DATABASE_URL="${DATABASE_URL//postgres:\/\//postgresql:\/\/}"
sed -i "s|^DATABASE_URL=.*|DATABASE_URL=${DATABASE_URL}|" "$ENV_FILE"
if grep -q '^ZAPO_DATABASE_URL=' "$ENV_FILE"; then
  ZAPO_DB="$(grep '^ZAPO_DATABASE_URL=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
  ZAPO_DB="${ZAPO_DB//postgresql+psycopg2:\/\//postgresql:\/\/}"
  ZAPO_DB="${ZAPO_DB//postgresql+psycopg:\/\//postgresql:\/\/}"
  ZAPO_DB="${ZAPO_DB//postgres:\/\//postgresql:\/\/}"
  sed -i "s|^ZAPO_DATABASE_URL=.*|ZAPO_DATABASE_URL=${ZAPO_DB}|" "$ENV_FILE"
fi

DATABASE_URL="$(grep '^DATABASE_URL=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
chmod 640 "$ENV_FILE"
chown "$APP_USER:$APP_USER" "$ENV_FILE"

log "[6/8] Build Node (npm ci + prisma generate + build)"
cd "$APP_DIR"
sed -i '/^VITE_/d' "$ENV_FILE" 2>/dev/null || true
unset VITE_API_URL VITE_WS_URL || true
export DATABASE_URL
npm ci
cd "$APP_DIR/apps/api"
npx prisma generate
# NUNCA db push no DB compartilhado steamfarm — o schema React é subset e o push
# tentaria DROPar steam_accounts, zapo_*, billing, etc.
# update: sempre pular push (mesmo se REUSE veio errado como 0)
if [[ "$MODE" == "update" || "$REUSE_STEAMFARM_DB" == "1" ]]; then
  echo "PRISMA_PUSH_SKIP=1 (MODE=${MODE} REUSE_STEAMFARM_DB=${REUSE_STEAMFARM_DB} — schema Flask preservado)"
  # Backup do banco compartilhado antes de qualquer SQL (só leitura do Postgres; nada do
  # Flask é alterado). Mantém os 10 últimos em $APP_DIR/data/backups. SKIP_DB_BACKUP=1 pula.
  BACKUP_DIR="$APP_DIR/data/backups"
  mkdir -p "$BACKUP_DIR"
  if [[ "${SKIP_DB_BACKUP:-0}" != "1" ]]; then
    BACKUP_FILE="$BACKUP_DIR/steamfarm-$(date +%Y%m%d-%H%M%S).sql.gz"
    if sudo -u postgres pg_dump steamfarm | gzip > "$BACKUP_FILE"; then
      echo "DB_BACKUP=$BACKUP_FILE"
      ls -1t "$BACKUP_DIR"/*.sql.gz 2>/dev/null | tail -n +11 | xargs -r rm -f
    else
      echo "ERRO: pg_dump falhou; não vou aplicar SQL sem backup (SKIP_DB_BACKUP=1 força)."
      exit 1
    fi
  fi
  if [[ -f "$APP_DIR/deploy/add_react_columns.sql" ]]; then
    echo "APPLY_ADDITIVE_SQL=1"
    # O root lê o ficheiro e passa pelo stdin: o usuário postgres não precisa enxergar
    # /opt/steamfarm-react (no deploy de 30/09 o `-f` falhou por permissão da pasta recém-extraída
    # e a coluna token_version só entrou depois, à mão).
    if ! sudo -u postgres psql -v ON_ERROR_STOP=1 -d steamfarm < "$APP_DIR/deploy/add_react_columns.sql"; then
      echo "ERRO: additive SQL falhou — o código novo pode depender de colunas ausentes."
      echo "      Rode à mão: sudo -u postgres psql -d steamfarm < $APP_DIR/deploy/add_react_columns.sql"
      exit 1
    fi
  fi
  # Mesmos arquivos de mídia do Flask (avatars / community icons)
  mkdir -p "$APP_DIR/apps/api/uploads"
  if [[ -d /opt/steamfarm/data/avatars ]]; then
    ln -sfn /opt/steamfarm/data/avatars "$APP_DIR/apps/api/uploads/avatars"
  else
    mkdir -p "$APP_DIR/apps/api/uploads/avatars"
  fi
  if [[ -d /opt/steamfarm/data/community ]]; then
    ln -sfn /opt/steamfarm/data/community "$APP_DIR/apps/api/uploads/community"
  else
    mkdir -p "$APP_DIR/apps/api/uploads/community"
  fi
  mkdir -p "$APP_DIR/apps/api/uploads/themes"
  # React precisa escrever nos dirs compartilhados com o Flask
  if id steamfarmreact >/dev/null 2>&1; then
    usermod -aG steamfarm steamfarmreact 2>/dev/null || true
    for d in /opt/steamfarm/data/avatars /opt/steamfarm/data/community; do
      if [[ -d "$d" ]]; then
        chgrp -R steamfarm "$d" 2>/dev/null || true
        chmod -R g+rwXs "$d" 2>/dev/null || true
        # ACL de reforço se disponível
        setfacl -R -m u:steamfarmreact:rwx "$d" 2>/dev/null || true
        setfacl -R -d -m u:steamfarmreact:rwx "$d" 2>/dev/null || true
      fi
    done
  fi
  chmod -R a+rX /opt/steamfarm/data/avatars /opt/steamfarm/data/community 2>/dev/null || true
  chown -R steamfarmreact:steamfarmreact "$APP_DIR/apps/api/uploads/themes" 2>/dev/null || true
else
  if ! npx prisma db push; then
    echo "ERRO: prisma db push falhou."
    exit 1
  fi
fi
cd "$APP_DIR"
npm run build -w @steamfarm/shared
npm run build -w @steamfarm/api
# Frontend: build em dist-next e troca atómica — evita 404 a meio do Vite
cd "$APP_DIR/apps/web"
rm -rf dist-next
npx vite build --outDir dist-next
if [[ ! -f dist-next/index.html ]]; then
  echo "ERRO: build do frontend falhou (sem dist-next/index.html)"
  exit 1
fi
rm -rf dist.old
if [[ -d dist ]]; then mv dist dist.old; fi
mv dist-next dist
rm -rf dist.old
cd "$APP_DIR"
mkdir -p "$APP_DIR/apps/api/uploads"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
# NÃO deixar APP_DIR em 700 — www-data precisa atravessar até apps/web/dist
chmod 755 "$APP_DIR"
chmod -R a+rX "$APP_DIR/apps/web/dist" 2>/dev/null || true
# .env continua privado
if [[ -f "$APP_DIR/.env" ]]; then
  chmod 640 "$APP_DIR/.env"
  chown "$APP_USER:$APP_USER" "$APP_DIR/.env"
fi

WEB_DIST="$APP_DIR/apps/web/dist"
if [[ ! -f "$WEB_DIST/index.html" ]]; then
  echo "ERRO: build do frontend falhou (sem $WEB_DIST/index.html)"
  exit 1
fi

log "[7/8] Nginx (site isolado) + systemd"
write_nginx_http "$DOMAIN_NAME" "$APP_PORT" "$WEB_DIST"
ln -sfn "/etc/nginx/sites-available/${SITE_NAME}" "/etc/nginx/sites-enabled/${SITE_NAME}"
reload_nginx_safe

if [[ -f "/etc/letsencrypt/live/${DOMAIN_NAME}/fullchain.pem" ]]; then
  write_nginx_https "$DOMAIN_NAME" "$APP_PORT" "$WEB_DIST"
  reload_nginx_safe
  echo "SSL_REUSED=1"
elif [[ "$ENABLE_SSL" == "1" && "$SKIP_CERTBOT" != "1" ]]; then
  EMAIL_ARGS=()
  if [[ -n "$SSL_EMAIL" ]]; then
    EMAIL_ARGS=(--email "$SSL_EMAIL")
  else
    EMAIL_ARGS=(--register-unsafely-without-email)
  fi
  certbot certonly --webroot -w /var/www/certbot \
    -d "$DOMAIN_NAME" \
    "${EMAIL_ARGS[@]}" \
    --agree-tos --non-interactive || true
  if [[ -f "/etc/letsencrypt/live/${DOMAIN_NAME}/fullchain.pem" ]]; then
    write_nginx_https "$DOMAIN_NAME" "$APP_PORT" "$WEB_DIST"
    reload_nginx_safe
    echo "SSL_OK=1"
  else
    echo "SSL_PENDING=1 (DNS do domínio precisa apontar para esta VPS)"
  fi
fi

cp "$APP_DIR/deploy/steamfarm-react.service" "/etc/systemd/system/${SERVICE_NAME}.service"
systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"

# Túnel CS2 (Hamachi-like): host→VPS UDP 27040, convidados UDP 28100-28131
ufw allow 27040/udp || true
ufw allow 28100:28131/udp || true
iptables -C INPUT -p udp --dport 27040 -j ACCEPT 2>/dev/null || iptables -A INPUT -p udp --dport 27040 -j ACCEPT || true
iptables -C INPUT -p udp --dport 28100:28131 -j ACCEPT 2>/dev/null || iptables -A INPUT -p udp --dport 28100:28131 -j ACCEPT || true
if ! grep -q '^MATCH_RELAY_PUBLIC_HOST=' "$ENV_FILE" 2>/dev/null; then
  echo "MATCH_RELAY_PUBLIC_HOST=${DOMAIN_NAME}" >> "$ENV_FILE"
fi
if ! grep -q '^MATCH_RELAY_HOST=' "$ENV_FILE" 2>/dev/null; then
  echo "MATCH_RELAY_HOST=${DOMAIN_NAME}" >> "$ENV_FILE"
fi
if ! grep -q '^MATCH_RELAY_PORT=' "$ENV_FILE" 2>/dev/null; then
  echo "MATCH_RELAY_PORT=27040" >> "$ENV_FILE"
fi

log "[8/8] LiveKit (reusa credenciais; rooms com prefixo ${LIVEKIT_ROOM_PREFIX})"
LK_OK=0
if [[ "$REUSE_LIVEKIT" == "1" ]]; then
  if copy_livekit_from_env /opt/steamfarm/.env "$ENV_FILE"; then
    LK_OK=1
  elif copy_livekit_from_env /opt/woulzmeeting/.env "$ENV_FILE"; then
    LK_OK=1
  fi
fi
if grep -q '^LIVEKIT_ROOM_PREFIX=' "$ENV_FILE"; then
  sed -i "s|^LIVEKIT_ROOM_PREFIX=.*|LIVEKIT_ROOM_PREFIX=${LIVEKIT_ROOM_PREFIX}|" "$ENV_FILE"
else
  echo "LIVEKIT_ROOM_PREFIX=${LIVEKIT_ROOM_PREFIX}" >> "$ENV_FILE"
fi
if grep -q '^LIVEKIT_IDENTITY_PREFIX=' "$ENV_FILE"; then
  sed -i "s|^LIVEKIT_IDENTITY_PREFIX=.*|LIVEKIT_IDENTITY_PREFIX=${LIVEKIT_IDENTITY_PREFIX}|" "$ENV_FILE"
else
  echo "LIVEKIT_IDENTITY_PREFIX=${LIVEKIT_IDENTITY_PREFIX}" >> "$ENV_FILE"
fi

chown "$APP_USER:$APP_USER" "$ENV_FILE"
systemctl restart "$SERVICE_NAME"

echo "PUBLIC_URL=${PUBLIC_URL}"
echo "APP_PORT=${APP_PORT}"
echo "LIVEKIT_ROOM_PREFIX=${LIVEKIT_ROOM_PREFIX}"
echo "SITE_NAME=${SITE_NAME}"
echo "INSTALL_OK"
if systemctl is-active --quiet "$SERVICE_NAME"; then
  echo "SERVICE_OK=1"
else
  echo "SERVICE_OK=0"
  systemctl status "$SERVICE_NAME" --no-pager -l | head -40 || true
  echo "ERRO: serviço ${SERVICE_NAME} não ficou ativo após o update"
  exit 1
fi

# Healthcheck: Nest demora 1–3s a bindar após systemctl restart — não falhar cedo
PORT_OK=0
for _i in $(seq 1 30); do
  if ss -lnt 2>/dev/null | grep -qE ":${APP_PORT}[[:space:]]" || \
     ss -lntH 2>/dev/null | awk '{print $4}' | grep -qE ":${APP_PORT}$"; then
    PORT_OK=1
    break
  fi
  sleep 1
done
if [[ "$PORT_OK" != "1" ]]; then
  echo "ERRO: nada a escutar na porta ${APP_PORT} após 30s"
  systemctl status "$SERVICE_NAME" --no-pager -l | head -40 || true
  journalctl -u "$SERVICE_NAME" -n 40 --no-pager || true
  exit 1
fi
echo "PORT_OK=1 (${APP_PORT})"
if [[ ! -f "$WEB_DIST/index.html" ]]; then
  echo "ERRO: index.html desapareceu após restart"
  exit 1
fi
# /api/auth/me → 401 sem cookie = API viva (não há /api/health em todos os deploys)
HTTP_CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "http://127.0.0.1:${APP_PORT}/api/auth/me" 2>/dev/null || echo 000)"
echo "HEALTH_API=${HTTP_CODE}"
STATIC_CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 -H "Host: ${DOMAIN_NAME}" "http://127.0.0.1/index.html" 2>/dev/null || echo 000)"
echo "HEALTH_STATIC=${STATIC_CODE}"
if [[ "$STATIC_CODE" != "200" && "$STATIC_CODE" != "301" && "$STATIC_CODE" != "302" ]]; then
  # HTTPS-only vhost: tenta via socket local com SNI
  STATIC_CODE="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 8 -H "Host: ${DOMAIN_NAME}" "https://127.0.0.1/index.html" 2>/dev/null || echo 000)"
  echo "HEALTH_STATIC_HTTPS=${STATIC_CODE}"
fi
if [[ "$STATIC_CODE" != "200" && "$STATIC_CODE" != "301" && "$STATIC_CODE" != "302" ]]; then
  echo "WARN: static health ${STATIC_CODE} (confira nginx root / permissões APP_DIR=755)"
fi
# Feed Electron intacto (update NÃO republica desktop)
if [[ -f "$APP_DIR/desktop/latest.yml" ]]; then
  echo "DESKTOP_FEED_VERSION=$(grep -m1 '^version:' "$APP_DIR/desktop/latest.yml" | awk '{print $2}')"
else
  echo "WARN: desktop/latest.yml ausente — clients sem update feed"
fi
# nginx precisa atravessar APP_DIR
chmod 755 "$APP_DIR" 2>/dev/null || true
chmod -R a+rX "$APP_DIR/apps/web/dist" 2>/dev/null || true


# Confirma serviços legado se existirem (não falha em VPS limpa)
if systemctl list-unit-files steamfarm.service >/dev/null 2>&1; then
  systemctl is-active steamfarm nginx >/dev/null 2>&1 && echo "LEGACY_OK=1" || echo "LEGACY_CHECK=warn"
else
  echo "LEGACY_ABSENT=1"
fi
echo "REUSE_STEAMFARM_DB=${REUSE_STEAMFARM_DB}"
echo "DESKTOP_FEED=${PUBLIC_URL}/desktop/"
