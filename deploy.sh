#!/usr/bin/env bash

set -Eeuo pipefail

DEPLOY_PATH="/var/www/www-root/data/www/prereborn.ru"
API_PATH="$DEPLOY_PATH/apps/api"

cd "$DEPLOY_PATH"

if ss -lnt | grep -Eq ':(5100|5102)[[:space:]]'; then
  echo "Порты 5100/5102 уже заняты. Проверьте процессы перед первым запуском."
  pm2 describe prereborn-web >/dev/null 2>&1 || exit 1
  pm2 describe prereborn-api >/dev/null 2>&1 || exit 1
fi

test -f "$DEPLOY_PATH/.env" || {
  echo "Не найден $DEPLOY_PATH/.env"
  exit 1
}

set -a
# shellcheck disable=SC1091
source "$DEPLOY_PATH/.env"
set +a

if [[ "${SKIP_GIT_PULL:-0}" != "1" ]]; then
  git pull --ff-only origin main
fi
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @prereborn/web build
corepack pnpm --filter @prereborn/api build

mkdir -p "$DEPLOY_PATH/logs" "$API_PATH/uploads"

corepack pnpm --filter @prereborn/api db:migrate

pm2 startOrReload ecosystem.config.cjs --update-env
# PM2 can preserve an existing fork's environment when startOrReload is
# driven by an ecosystem file. Refresh the API explicitly from the exported
# root .env so newly added integration credentials reach the process.
pm2 restart prereborn-api --update-env
pm2 save

HEALTH_RESPONSE="$(curl --fail --silent --show-error \
  --retry 10 --retry-delay 2 --retry-connrefused \
  http://127.0.0.1:5102/api/health)"
printf '%s\n' "$HEALTH_RESPONSE"
grep -q '"donationAlertsConfigured":true' <<<"$HEALTH_RESPONSE" || {
  echo "DonationAlerts credentials did not reach prereborn-api"
  exit 1
}
curl --fail --silent --show-error --head \
  --retry 10 --retry-delay 2 --retry-connrefused \
  http://127.0.0.1:5100

echo "Деплой prereborn.ru завершён."
