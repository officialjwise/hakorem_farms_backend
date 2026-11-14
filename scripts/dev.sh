#!/usr/bin/env bash
# pnpm dev: the API on the host with reload, against PostgreSQL and Redis in Docker.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] || { echo 'pnpm dev: no .env yet; run pnpm run setup first' >&2; exit 1; }
docker compose up --detach --wait postgres redis
# The API container from pnpm setup holds the same port; stop it while developing.
docker compose --profile app stop api >/dev/null 2>&1 || true
exec corepack pnpm exec tsx watch --env-file=.env src/main.ts
