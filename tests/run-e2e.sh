#!/usr/bin/env bash
# Starts a throwaway stack with its own project and volume, then runs the browser tests against it.
set -uo pipefail

cd "$(dirname "$0")/.."

export COMPOSE_PROJECT_NAME=esm-e2e
export PGDATA_VOLUME=esm-e2e-pgdata
export WEB_PORT=13081
export WEB_BIND=127.0.0.1
export ADMIN_USER=admin
export ADMIN_PASSWORD; ADMIN_PASSWORD=$(openssl rand -hex 16)
export POSTGRES_PASSWORD; POSTGRES_PASSWORD=$(openssl rand -hex 16)
export API_TOKEN; API_TOKEN=$(openssl rand -hex 24)
export SSRF_ALLOW_HOSTS=fixture
export SCHEDULER_TICK_MS=2000
export CHECK_ATTEMPTS=1

COMPOSE=(docker compose --profile demo -f docker-compose.yml -f tests/e2e/compose.e2e.yml)

cleanup() {
  "${COMPOSE[@]}" down --remove-orphans >/dev/null 2>&1
  docker volume rm "$PGDATA_VOLUME" >/dev/null 2>&1
}
trap cleanup EXIT
cleanup

"${COMPOSE[@]}" up -d --build --wait --wait-timeout 300 2>&1 | tail -2

export E2E_BASE_URL="http://127.0.0.1:$WEB_PORT"
export E2E_USER="$ADMIN_USER"
export E2E_PASSWORD="$ADMIN_PASSWORD"
export E2E_FIXTURE_URL="http://127.0.0.1:14100"
export E2E_COMPOSE="${COMPOSE[*]}"

npx playwright test --config tests/e2e/playwright.config.ts "$@"
