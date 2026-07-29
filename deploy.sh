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
pnpm install --frozen-lockfile
pnpm --filter @prereborn/web build
pnpm --filter @prereborn/api build

mkdir -p "$DEPLOY_PATH/logs" "$API_PATH/uploads"

pnpm --filter @prereborn/api db:migrate

pm2 startOrReload ecosystem.config.cjs --update-env
pm2 save

curl --fail --silent --show-error http://127.0.0.1:5102/api/health
curl --fail --silent --show-error --head http://127.0.0.1:5100

echo "Деплой prereborn.ru завершён."
