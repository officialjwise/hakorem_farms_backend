#!/usr/bin/env bash
# pnpm dev: the API and the worker on the host with reload, against PostgreSQL, Redis and the object store in Docker.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] || { echo 'pnpm dev: no .env yet; run pnpm run setup first' >&2; exit 1; }
docker compose up --detach --wait postgres redis objectstore
# The containers from pnpm setup hold the same ports and the same work; stop them while developing.
docker compose --profile app stop api worker >/dev/null 2>&1 || true
corepack pnpm exec tsx watch --env-file=.env src/worker.ts &
worker=$!
trap 'kill "$worker" 2>/dev/null || true' EXIT INT TERM
corepack pnpm exec tsx watch --env-file=.env src/main.ts
