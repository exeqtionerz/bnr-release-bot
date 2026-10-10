#!/usr/bin/env bash
# Instala el bot en un VPS Ubuntu (p.ej. el de TolaMix). Ejecutar como root:
#   curl -fsSL https://... | bash   ó   bash deploy/install.sh
set -euo pipefail
APP_DIR=/opt/bnr-release-bot

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
apt-get install -y ffmpeg git

if [ ! -d "$APP_DIR/.git" ]; then
  echo "Clona primero el repo en $APP_DIR:  git clone https://github.com/exeqtionerz/bnr-release-bot.git $APP_DIR"
  exit 1
fi
cd "$APP_DIR"
npm ci --omit=dev
[ -f .env ] || { cp .env.example .env; echo ">> Rellena $APP_DIR/.env y vuelve a ejecutar este script."; exit 0; }

id -u bnrbot >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin bnrbot
mkdir -p data tmp && chown -R bnrbot:bnrbot data tmp
chmod 600 .env && chown bnrbot:bnrbot .env

cp deploy/bnr-release-bot.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now bnr-release-bot
sleep 2
systemctl --no-pager status bnr-release-bot | head -15
echo ">> Listo. Logs: journalctl -u bnr-release-bot -f"
