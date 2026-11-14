#!/usr/bin/env bash
# pnpm run setup (pnpm setup is a pnpm built-in): a fresh clone to a running, seeded API in one command (docs/ONBOARDING.md section 4, NFR-017).
# Safe to run again: every step checks before it acts. It never overwrites .env and never prints a secret.
set -euo pipefail

cd "$(dirname "$0")/.."

REQUIRED_NODE_MAJOR=22
MIN_DOCKER_MEMORY_BYTES=$((1536 * 1024 * 1024))      # below this the stack cannot start
RECOMMENDED_DOCKER_MEMORY_BYTES=$((6 * 1024 * 1024 * 1024))
MIN_FREE_DISK_KB=$((3 * 1024 * 1024))
HEALTH_URL_PATH=/v1/health

step() { printf '\n==> %s\n' "$1"; }
fail() { printf '\nsetup failed: %s\n' "$1" >&2; printf 'Fix: %s\n' "$2" >&2; exit 1; }
warn() { printf 'warning: %s\n' "$1" >&2; }

port_in_use() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

# A port is fine if it is free, or if it is already published by this project's own container.
check_port() {
  local port="$1" service="$2"
  if port_in_use "$port"; then
    if docker compose ps --status running --services 2>/dev/null | grep -qx "$service"; then
      return 0
    fi
    fail "port $port, needed for $service, is already in use by another program" \
      "stop that program, or set a different port for $service in .env (and in the URLs that use it)"
  fi
}

step '1/9 Checking this machine'
command -v node >/dev/null || fail 'Node.js is not installed' "install Node $REQUIRED_NODE_MAJOR LTS (docs/ONBOARDING.md section 2)"
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$node_major" = "$REQUIRED_NODE_MAJOR" ] || fail "Node $(node --version) is installed; this project needs Node $REQUIRED_NODE_MAJOR" "install Node $REQUIRED_NODE_MAJOR LTS, for example with fnm or nvm"
command -v corepack >/dev/null || fail 'Corepack is missing' 'reinstall Node 22 from nodejs.org; Corepack ships with it'
command -v git >/dev/null || fail 'Git is not installed' 'install Git 2.40 or later'
command -v docker >/dev/null || fail 'Docker is not installed' 'install Docker Desktop (macOS, Windows) or Docker Engine with the Compose plugin (Linux)'
docker info >/dev/null 2>&1 || fail 'the Docker daemon is not running' 'start Docker Desktop, or run: sudo systemctl start docker'
docker compose version >/dev/null 2>&1 || fail 'Docker Compose v2 is missing' 'install the Compose plugin; the command is "docker compose", not "docker-compose"'
docker_memory="$(docker info --format '{{.MemTotal}}')"
if [ "$docker_memory" -lt "$MIN_DOCKER_MEMORY_BYTES" ]; then
  fail "Docker has $((docker_memory / 1024 / 1024)) MB of memory; the stack needs at least 1536 MB" 'raise the memory limit in Docker Desktop, Settings, Resources'
elif [ "$docker_memory" -lt "$RECOMMENDED_DOCKER_MEMORY_BYTES" ]; then
  warn "Docker has $((docker_memory / 1024 / 1024)) MB of memory; 6 GB is recommended once more modules run"
fi
free_kb="$(df -Pk . | awk 'NR == 2 { print $4 }')"
[ "$free_kb" -ge "$MIN_FREE_DISK_KB" ] || fail "only $((free_kb / 1024)) MB of disk is free here" 'free at least 3 GB'
printf 'Node %s, %s, Docker %s with %s MB\n' "$(node --version)" "$(docker compose version --short)" "$(docker info --format '{{.ServerVersion}}')" "$((docker_memory / 1024 / 1024))"

step '2/9 Enabling Corepack and the pinned pnpm'
corepack enable pnpm >/dev/null 2>&1 || warn 'corepack enable needs write access to the Node install; using "corepack pnpm" instead'
PNPM=(corepack pnpm)
"${PNPM[@]}" --version

step '3/9 Installing packages from the lockfile'
"${PNPM[@]}" install --frozen-lockfile

step '4/9 Creating .env with generated development secrets'
"${PNPM[@]}" exec tsx scripts/setup/create-env.ts
set -a
# shellcheck disable=SC1091
. ./.env
set +a
check_port "${POSTGRES_HOST_PORT:-55432}" postgres
check_port "${REDIS_HOST_PORT:-56379}" redis
check_port "${API_HOST_PORT:-3000}" api

step '5/9 Starting PostgreSQL 17 and Redis 7'
docker compose up --detach --wait postgres redis

step '6/9 Creating the database roles and running the migrations'
"${PNPM[@]}" -s db:bootstrap
"${PNPM[@]}" -s db:migrate

step '7/9 Seeding the farm'
"${PNPM[@]}" -s db:seed

step '8/9 Building and starting the API'
docker compose --profile app up --detach --wait --build api
health_url="http://127.0.0.1:${API_HOST_PORT:-3000}${HEALTH_URL_PATH}"
curl --silent --show-error --fail --retry 20 --retry-connrefused --retry-delay 1 "$health_url" >/dev/null \
  || fail "the API did not answer $health_url" 'run: docker compose --profile app logs api'
printf 'GET %s -> %s\n' "$HEALTH_URL_PATH" "$(curl --silent "$health_url")"

step '9/9 Ready'
cat <<EOF
The API is running at http://127.0.0.1:${API_HOST_PORT:-3000}/v1 (health: $health_url).
No staff logins exist yet: authentication and the seeded users arrive in session B3.

Next:
  pnpm dev                 API with reload on the host (stops the API container first)
  pnpm test:unit           kernel and domain rules, no containers
  pnpm test:integration    against real PostgreSQL and Redis in Testcontainers
  pnpm lint && pnpm typecheck

Start again from nothing: docker compose --profile app down --volumes, delete node_modules, run pnpm run setup.
EOF
