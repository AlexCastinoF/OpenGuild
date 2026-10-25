#!/usr/bin/env bash
# Point meet.example.com at WOULZ Meeting React and retire Flask.
set -euo pipefail

REACT_ROOT=/opt/woulzmeeting-react
REACT_ENV="$REACT_ROOT/.env"
NGINX_KVOIP=/etc/nginx/sites-available/woulzmeeting

echo "==> write nginx meet.example.com → React :5070"
cat > "$NGINX_KVOIP" <<'EOF'
server {
    listen 80;
    listen [::]:80;
    server_name meet.example.com;

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/certbot;
        default_type "text/plain";
        allow all;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name meet.example.com;

    ssl_certificate /etc/letsencrypt/live/meet.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/meet.example.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;

    client_max_body_size 200m;
    root /opt/woulzmeeting-react/apps/web/dist;
    index index.html;

    location /api/ {
        proxy_pass http://127.0.0.1:5070;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    location /uploads/ {
        proxy_pass http://127.0.0.1:5070;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /socket.io/ {
        proxy_pass http://127.0.0.1:5070;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
    }

    location /ws/ {
        proxy_pass http://127.0.0.1:5070;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 3600s;
    }

    location /desktop/ {
        proxy_pass http://127.0.0.1:5070;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
EOF

echo "==> update React .env (primary domain meet.example.com)"
if [[ -f "$REACT_ENV" ]]; then
  cp -a "$REACT_ENV" "$REACT_ENV.bak.domain.$(date +%Y%m%d%H%M%S)"
  set_kv() {
    local key="$1" val="$2"
    if grep -q "^${key}=" "$REACT_ENV"; then
      sed -i "s|^${key}=.*|${key}=${val}|" "$REACT_ENV"
    else
      echo "${key}=${val}" >> "$REACT_ENV"
    fi
  }
  set_kv PUBLIC_URL "https://meet.example.com"
  set_kv PUBLIC_BASE_URL "https://meet.example.com"
  set_kv PUBLIC_ORIGIN "https://meet.example.com"
  set_kv APP_ORIGIN "https://meet.example.com"
  set_kv CORS_ORIGIN "https://meet.example.com,https://meet.example.com"
  set_kv COOKIE_SECURE "true"
  grep -E '^(PUBLIC_|APP_|CORS_|COOKIE_)' "$REACT_ENV" || true
fi

echo "==> nginx test + reload"
nginx -t
systemctl reload nginx

echo "==> stop & disable Flask woulzmeeting"
systemctl disable --now woulzmeeting || true
systemctl is-active woulzmeeting || echo "flask: inactive (ok)"

echo "==> restart React"
systemctl restart woulzmeeting-react
sleep 2
systemctl is-active woulzmeeting-react

echo "==> update VPS Control Panel catalog domains"
sudo -u postgres psql -d vps_control -v ON_ERROR_STOP=1 <<'SQL'
UPDATE "ManagedApp"
SET domain = 'meet.example.com',
    "displayName" = 'WOULZ Meeting React',
    "optPath" = '/opt/woulzmeeting-react',
    "desktopReleasesPath" = '/opt/woulzmeeting-react/desktop',
    "dbName" = 'woulzmeeting_react',
    "connectedUsersHint" = 'Redis/LiveKit'
WHERE slug = 'woulzmeeting-react';

UPDATE "ManagedApp"
SET domain = '',
    "displayName" = 'WOULZ Meeting (Flask legacy)',
    "connectedUsersHint" = 'desativado'
WHERE slug = 'woulzmeeting';

SELECT slug, "displayName", domain FROM "ManagedApp" ORDER BY slug;
SQL

echo "==> smoke"
JS=$(ls /opt/woulzmeeting-react/apps/web/dist/assets/*.js | head -1 | xargs -n1 basename)
curl -sS -m 10 -o /dev/null -w 'meet html %{http_code}\n' https://meet.example.com/
curl -sS -m 10 -o /dev/null -w "meet js %{http_code}\n" "https://meet.example.com/assets/${JS}"
curl -sS -m 10 -o /dev/null -w 'meet alt html %{http_code}\n' https://meet.example.com/
curl -sS -m 10 -o /dev/null -w 'meet api %{http_code}\n' https://meet.example.com/api/auth/me
echo "DONE — meet.example.com → React; Flask disabled"
