#!/usr/bin/env bash
# Instala RustDesk Server OSS (hbbs + hbbr) em /opt/rustdesk — fora do LiveKit.
set -euo pipefail

ROOT=/opt/rustdesk
mkdir -p "$ROOT/data"
cd "$ROOT"

cat > docker-compose.yml <<'EOF'
services:
  hbbr:
    container_name: hbbr
    image: rustdesk/rustdesk-server:latest
    command: hbbr
    volumes:
      - ./data:/root
    network_mode: "host"
    restart: unless-stopped

  hbbs:
    container_name: hbbs
    image: rustdesk/rustdesk-server:latest
    command: hbbs -r vps.example.com
    volumes:
      - ./data:/root
    network_mode: "host"
    depends_on:
      - hbbr
    restart: unless-stopped
EOF

if command -v ufw >/dev/null 2>&1; then
  ufw allow 21115/tcp || true
  ufw allow 21116/tcp || true
  ufw allow 21116/udp || true
  ufw allow 21117/tcp || true
  ufw allow 21118/tcp || true
  ufw allow 21119/tcp || true
fi

docker compose pull
docker compose up -d

# Aguarda chave pública
for i in $(seq 1 30); do
  if [[ -f "$ROOT/data/id_ed25519.pub" ]]; then
    break
  fi
  sleep 1
done

echo "=== rustdesk status ==="
docker compose ps
echo "=== public key ==="
cat "$ROOT/data/id_ed25519.pub" 2>/dev/null || echo "KEY_MISSING"
echo "=== done ==="
echo "Defina na API:"
echo "  RUSTDESK_ID_SERVER=vps.example.com"
echo "  RUSTDESK_KEY=<conteudo de id_ed25519.pub>"
