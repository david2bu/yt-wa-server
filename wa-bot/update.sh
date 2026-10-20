#!/usr/bin/env bash
# Runs every few minutes on the server (systemd timer installed by install.sh):
# if main on GitHub has new commits, pull them and rebuild the bot. Otherwise does nothing.
set -euo pipefail
SRC=/opt/wa-bot
APP="$SRC/wa-bot"
BRANCH="${BRANCH:-main}"

cd "$SRC"
git fetch -q origin "$BRANCH"
[ "$(git rev-parse HEAD)" = "$(git rev-parse "origin/$BRANCH")" ] && exit 0

echo "update: $(git rev-parse --short HEAD) -> $(git rev-parse --short "origin/$BRANCH")"
git reset -q --hard "origin/$BRANCH"
cd "$APP"
if docker ps --format '{{.Names}}' | grep -qx wa-bot-caddy; then
  docker compose --profile caddy up -d --build --remove-orphans
else
  docker compose up -d --build --remove-orphans
fi
docker image prune -f >/dev/null
