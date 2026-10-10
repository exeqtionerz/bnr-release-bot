#!/usr/bin/env bash
# Actualiza el bot a la última versión de GitHub.
set -euo pipefail
cd /opt/bnr-release-bot
git pull --ff-only
npm ci --omit=dev
systemctl restart bnr-release-bot
echo "Actualizado."
