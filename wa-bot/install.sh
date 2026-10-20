#!/usr/bin/env bash
# One-command install / update of the WhatsApp bot on a Linux server (Ubuntu/Debian, e.g. a DigitalOcean droplet).
#
#   curl -fsSL https://raw.githubusercontent.com/david2bu/yt-wa-server/main/wa-bot/install.sh | sudo bash -s bot.example.com
#
# - installs Docker if missing
# - downloads (or updates) the bot into /opt/wa-bot
# - if ports 80/443 are free: runs Caddy for automatic HTTPS
# - if nginx already serves another site here: adds the bot as an extra nginx site + Let's Encrypt certificate
# - installs a timer that pulls new versions from GitHub automatically
# Safe to run again.
set -euo pipefail

DOMAIN="${1:-${DOMAIN:-}}"
REPO="https://github.com/david2bu/yt-wa-server.git"
BRANCH="${BRANCH:-main}"
SRC=/opt/wa-bot
APP="$SRC/wa-bot"

say() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
warn() { printf '\n\033[1;33m!!  %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mXX  %s\033[0m\n' "$*"; exit 1; }

[ "$(id -u)" -eq 0 ] || die "צריך להריץ עם sudo"
[ -n "$DOMAIN" ] || die "חסרה כתובת. דוגמה: ... | sudo bash -s bot.judit.live"

say "בודק את Docker"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh </dev/null
fi
docker compose version >/dev/null 2>&1 || apt-get install -y docker-compose-plugin </dev/null
command -v git >/dev/null 2>&1 || apt-get install -y git </dev/null

# small droplets run out of memory while building; add swap once
if [ "$(free -m | awk '/Mem:/ {print $2}')" -lt 1500 ] && ! swapon --show | grep -q .; then
  say "מוסיף זיכרון swap (שרת קטן)"
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

say "מוריד את הבוט ל-$SRC"
if [ -d "$SRC/.git" ]; then
  git -C "$SRC" fetch -q origin "$BRANCH"
  git -C "$SRC" checkout -q "$BRANCH"
  git -C "$SRC" reset -q --hard "origin/$BRANCH"
else
  git clone -q -b "$BRANCH" "$REPO" "$SRC"
fi

cd "$APP"
touch .env
if grep -q '^DOMAIN=' .env; then sed -i "s|^DOMAIN=.*|DOMAIN=$DOMAIN|" .env; else echo "DOMAIN=$DOMAIN" >> .env; fi

# Does the domain point here?
MYIP="$(curl -fsS4 https://api.ipify.org || true)"
DNSIP="$(getent ahostsv4 "$DOMAIN" | awk 'NR==1 {print $1}' || true)"
if [ -n "$MYIP" ] && [ "$DNSIP" != "$MYIP" ]; then
  warn "הכתובת $DOMAIN עדיין לא מפנה לשרת הזה ($MYIP)."
  warn "צריך להוסיף רשומת A: $DOMAIN -> $MYIP (ב-DigitalOcean: Networking -> Domains). אחרי שזה מתעדכן, להריץ שוב את הפקודה."
fi

port_busy() { ss -ltnH "( sport = :$1 )" | grep -q . ; }
caddy_running() { docker ps --format '{{.Names}}' | grep -qx wa-bot-caddy; }

if caddy_running || { ! port_busy 80 && ! port_busy 443; }; then
  say "מפעיל את הבוט + HTTPS אוטומטי (Caddy)"
  docker compose --profile caddy up -d --build --remove-orphans
  MODE=caddy
elif command -v nginx >/dev/null 2>&1 && systemctl is-active --quiet nginx; then
  say "nginx כבר רץ כאן (האתר הקיים). מוסיף את הבוט כאתר נוסף ב-nginx"
  docker compose up -d --build --remove-orphans
  CONF=/etc/nginx/conf.d/wa-bot.conf
  if [ ! -f "$CONF" ] || ! grep -q "server_name $DOMAIN;" "$CONF"; then
    cat > "$CONF" <<NGINX
server {
    listen 80;
    server_name $DOMAIN;
    client_max_body_size 200m;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 1800s;
        proxy_request_buffering off;
    }
}
NGINX
  fi
  nginx -t && systemctl reload nginx
  if [ "$DNSIP" = "$MYIP" ]; then
    command -v certbot >/dev/null 2>&1 || apt-get install -y certbot python3-certbot-nginx </dev/null
    certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect </dev/null || warn "התעודה לא הונפקה עדיין. להריץ שוב מאוחר יותר."
  fi
  MODE=nginx
else
  docker compose up -d --build --remove-orphans
  warn "פורט 80/443 תפוס על ידי תוכנה אחרת (לא nginx). הבוט רץ על http://127.0.0.1:3000 אבל צריך לחבר אותו לדומיין ידנית."
  ss -ltnp "( sport = :80 or sport = :443 )" || true
  MODE=manual
fi

say "מגדיר עדכון אוטומטי (כל שינוי ב-GitHub עולה לשרת לבד תוך כמה דקות)"
cat > /etc/systemd/system/wa-bot-update.service <<UNIT
[Unit]
Description=Update the WhatsApp bot from GitHub
After=network-online.target docker.service

[Service]
Type=oneshot
Environment=BRANCH=$BRANCH
ExecStart=$APP/update.sh
UNIT
cat > /etc/systemd/system/wa-bot-update.timer <<'UNIT'
[Unit]
Description=Check GitHub for bot updates every 3 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=3min

[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now wa-bot-update.timer >/dev/null

say "ממתין שהבוט יעלה"
for _ in $(seq 1 30); do
  if curl -fsS -o /dev/null http://127.0.0.1:3000/api/setup; then break; fi
  sleep 2
done
if curl -fsS -o /dev/null http://127.0.0.1:3000/api/setup; then
  say "✅ הבוט רץ!"
  [ "$MODE" != manual ] && echo "   היכנסו ל: https://$DOMAIN"
  echo "   בכניסה הראשונה בוחרים סיסמה, ואז בלשונית 'חיבור' סורקים את ה-QR."
  echo "   לוגים:  cd $APP && docker compose logs -f wa-bot"
  echo "   עדכונים מ-GitHub עולים לבד (יומן: journalctl -u wa-bot-update)"
else
  warn "הבוט לא עלה. הלוגים:"
  docker compose logs --tail 50 wa-bot
  exit 1
fi
