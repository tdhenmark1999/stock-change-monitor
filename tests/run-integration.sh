#!/usr/bin/env bash
# Runs the integration tests against throwaway PostgreSQL and Redis containers held in memory.
# It never reads .env and never touches the application's own database or volumes.
set -euo pipefail

cd "$(dirname "$0")/.."
PROJECT=esm-test
PG=esm-test-postgres
REDIS=esm-test-redis
PG_PORT=55432
REDIS_PORT=56379

cleanup() { docker rm -f "$PG" "$REDIS" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

docker run -d --name "$PG" --label "project=$PROJECT" -p "127.0.0.1:$PG_PORT:5432" --tmpfs /var/lib/postgresql/data \
  -e POSTGRES_USER=esm -e POSTGRES_PASSWORD=esm -e POSTGRES_DB=esm_test postgres:16-alpine >/dev/null
docker run -d --name "$REDIS" --label "project=$PROJECT" -p "127.0.0.1:$REDIS_PORT:6379" redis:7-alpine >/dev/null

until docker exec "$PG" pg_isready -U esm -d esm_test >/dev/null 2>&1; do sleep 1; done

export DATABASE_URL="postgresql://esm:esm@127.0.0.1:$PG_PORT/esm_test"
export REDIS_URL="redis://127.0.0.1:$REDIS_PORT"
npx prisma migrate deploy >/dev/null
npx vitest run --dir tests/integration "$@"
