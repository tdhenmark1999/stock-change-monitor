#!/usr/bin/env bash
# The 15-step persistence verification, run against the real Docker Compose stack.
# Uses its own project and volume, so it never touches a real deployment's data, and it
# never runs "down -v". Exits non-zero unless every check passes.
set -uo pipefail

cd "$(dirname "$0")/.."

export COMPOSE_PROJECT_NAME=esm-verify
export PGDATA_VOLUME=esm-verify-pgdata
export WEB_PORT=13080
export WEB_BIND=127.0.0.1
export ADMIN_USER=admin
export ADMIN_PASSWORD; ADMIN_PASSWORD=$(openssl rand -hex 16)
export POSTGRES_PASSWORD; POSTGRES_PASSWORD=$(openssl rand -hex 16)
export API_TOKEN; API_TOKEN=$(openssl rand -hex 24)
export SSRF_ALLOW_HOSTS=fixture
export SCHEDULER_TICK_MS=2000
export CHECK_ATTEMPTS=1

DC=(docker compose --profile demo)
WEB="http://127.0.0.1:$WEB_PORT"
AUTH=(-u "$ADMIN_USER:$ADMIN_PASSWORD")
PASS=0; FAIL=0

check() { # description, actual, expected
  if [ "$2" = "$3" ]; then echo "  PASS  $1 ($2)"; PASS=$((PASS+1));
  else echo "  FAIL  $1: expected '$3', got '$2'"; FAIL=$((FAIL+1)); fi
}
step() { echo; echo "STEP $1: $2"; }

api() { curl -s "${AUTH[@]}" -H 'content-type: application/json' "$@"; }
json() { python3 -c "import json,sys;d=json.load(sys.stdin);print($1)"; }
sql() { "${DC[@]}" exec -T postgres psql -U esm -d esm -At -c "$1"; }
fixture_set() {
  "${DC[@]}" exec -T fixture node -e "fetch('http://127.0.0.1:4100/__state/verify',{method:'POST',body:process.argv[1]}).then(r=>process.exit(r.ok?0:1))" "$1"
}
wait_web() {
  for _ in $(seq 1 120); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" "$WEB/api/monitors")" = "200" ] && return 0
    sleep 1
  done
  echo "  !! web/api did not become ready"; return 1
}
runs() { sql "SELECT count(*) FROM \"CheckRun\" WHERE \"monitorId\"='$ID'"; }
wait_runs_above() { # count, seconds
  for _ in $(seq 1 "$2"); do
    [ "$(runs)" -gt "$1" ] && return 0
    sleep 1
  done
  return 1
}
# Everything a user configures, in a stable order, so before and after can be compared exactly.
config_snapshot() {
  sql "SELECT m.id,m.name,m.url,m.\"intervalMinutes\",m.enabled,f.id,f.name,f.selector,f.\"extractType\",f.attribute,f.role,f.\"inStockTerms\",f.\"outOfStockTerms\",f.position
       FROM \"Monitor\" m JOIN \"MonitorField\" f ON f.\"monitorId\"=m.id ORDER BY m.id,f.position" | shasum -a 256 | cut -d' ' -f1
}
history_snapshot() { # hash of the first $1 runs, which must never change
  sql "SELECT r.id,r.\"startedAt\",r.status,r.changed,r.\"stockStatus\",x.\"fieldName\",x.\"previousValue\",x.\"currentValue\",x.changed
       FROM (SELECT * FROM \"CheckRun\" ORDER BY \"startedAt\" LIMIT $1) r JOIN \"FieldResult\" x ON x.\"checkRunId\"=r.id ORDER BY r.\"startedAt\",x.\"fieldName\"" | shasum -a 256 | cut -d' ' -f1
}
field_names() { api "$WEB/api/monitors/$ID" | json "','.join(f['name'] for f in d['fields'])"; }

# Removes only this script's own stack and volume, left over from a previous run.
"${DC[@]}" down --remove-orphans >/dev/null 2>&1
docker volume rm "$PGDATA_VOLUME" >/dev/null 2>&1

echo "Persistence verification, started $(date -u '+%Y-%m-%d %H:%M:%S UTC')"

step 1 "Start the application with Docker Compose"
"${DC[@]}" up -d --build --wait --wait-timeout 300 2>&1 | tail -3 | sed 's/^/  /'
wait_web
check "web answers through authentication" "$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" "$WEB/")" "200"
check "web refuses requests without a password" "$(curl -s -o /dev/null -w '%{http_code}' "$WEB/")" "401"

step 2 "Create a monitor"
ID=$(api -X POST "$WEB/api/monitors" -d '{
  "name":"Laugenpumpe Bosch","url":"http://fixture:4100/product/verify","intervalMinutes":1,
  "fields":[{"name":"Price","selector":".price","role":"PRICE"}]
}' | json "d['id']")
check "monitor has an id" "$([ -n "$ID" ] && echo yes)" "yes"

step 3 "Add multiple custom monitoring fields"
for body in \
  '{"name":"Availability","selector":".stock","role":"STOCK","outOfStockTerms":["auf Anfrage"]}' \
  '{"name":"Quantity","selector":".qty","role":"QUANTITY"}' \
  '{"name":"Schema availability","selector":".availability","role":"STOCK","extractType":"ATTRIBUTE","attribute":"href"}' \
  '{"name":"Title","selector":".title"}'; do
  check "field added" "$(api -o /dev/null -w '%{http_code}' -X POST "$WEB/api/monitors/$ID/fields" -d "$body")" "201"
done
EXPECTED_FIELDS="Price,Availability,Quantity,Schema availability,Title"

step 4 "Save the configuration"
check "monitor update saved" "$(api -o /dev/null -w '%{http_code}' -X PATCH "$WEB/api/monitors/$ID" -d '{"name":"Laugenpumpe Bosch 00144978"}')" "200"
check "API returns every field" "$(field_names)" "$EXPECTED_FIELDS"

step 5 "Verify the saved records in PostgreSQL"
sql "SELECT name,selector,\"extractType\",attribute,role FROM \"MonitorField\" WHERE \"monitorId\"='$ID' ORDER BY position" | sed 's/^/  db: /'
check "monitor row" "$(sql "SELECT name FROM \"Monitor\" WHERE id='$ID'")" "Laugenpumpe Bosch 00144978"
check "field rows" "$(sql "SELECT count(*) FROM \"MonitorField\" WHERE \"monitorId\"='$ID'")" "5"
check "custom stock term stored" "$(sql "SELECT \"outOfStockTerms\"[1] FROM \"MonitorField\" WHERE name='Availability'")" "auf Anfrage"

step 6 "Execute a monitoring check"
BEFORE=$(runs)
check "manual check accepted" "$(api -o /dev/null -w '%{http_code}' -X POST "$WEB/api/monitors/$ID/check")" "202"
wait_runs_above "$BEFORE" 30
check "check recorded" "$([ "$(runs)" -gt "$BEFORE" ] && echo yes)" "yes"
check "stock read as in stock" "$(api "$WEB/api/monitors/$ID" | json "d['lastStockStatus']")" "IN_STOCK"

step 7 "Verify monitoring history"
fixture_set '{"price":"CHF 39.90"}'
BEFORE=$(runs)
api -o /dev/null -X POST "$WEB/api/monitors/$ID/check"
wait_runs_above "$BEFORE" 30
LATEST="$WEB/api/history?monitorId=$ID&limit=1"
check "change detected" "$(api "$LATEST" | json "d['items'][0]['changed']")" "True"
check "price previous value" "$(api "$LATEST" | json "[r for r in d['items'][0]['results'] if r['fieldName']=='Price'][0]['previousValue']")" "CHF 49.90"
check "price current value" "$(api "$LATEST" | json "[r for r in d['items'][0]['results'] if r['fieldName']=='Price'][0]['currentValue']")" "CHF 39.90"
check "history stored in PostgreSQL" "$(sql "SELECT count(*) FROM \"FieldResult\" r JOIN \"CheckRun\" c ON c.id=r.\"checkRunId\" WHERE c.\"monitorId\"='$ID' AND r.changed")" "1"

CONFIG_HASH=$(config_snapshot)
BASE_RUNS=$(runs)
HISTORY_HASH=$(history_snapshot "$BASE_RUNS")
echo "  configuration fingerprint: $CONFIG_HASH"
echo "  history fingerprint ($BASE_RUNS runs): $HISTORY_HASH"

step 8 "Restart the frontend and backend"
"${DC[@]}" restart web api 2>&1 | tail -1 | sed 's/^/  /'
wait_web

step 9 "Reload the dashboard"
check "dashboard page renders" "$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" "$WEB/")" "200"
check "dashboard page shows the data" "$(curl -s "${AUTH[@]}" "$WEB/" | grep -c 'Laugenpumpe Bosch 00144978' | awk '{print ($1>0)?"yes":"no"}')" "yes"

step 10 "Confirm all custom fields still exist"
check "fields through the API" "$(field_names)" "$EXPECTED_FIELDS"
check "configuration identical in PostgreSQL" "$(config_snapshot)" "$CONFIG_HASH"

step 11 "Restart the background worker"
"${DC[@]}" restart worker 2>&1 | tail -1 | sed 's/^/  /'
check "worker stopped cleanly on SIGTERM" "$("${DC[@]}" logs worker 2>&1 | grep -c 'worker stopped cleanly' | awk '{print ($1>0)?"yes":"no"}')" "yes"

step 12 "Verify monitoring continues"
fixture_set '{"stock":"Nicht verfügbar"}'
BEFORE=$(runs)
# No manual trigger here: this waits for the schedule itself, which is due within the 1-minute interval.
wait_runs_above "$BEFORE" 90
check "scheduled check ran after the restart" "$([ "$(runs)" -gt "$BEFORE" ] && echo yes)" "yes"
check "it detected the stock change" "$(api "$WEB/api/monitors/$ID" | json "d['lastStockStatus']")" "OUT_OF_STOCK"
echo "  crash test: killing the worker with SIGKILL, then emptying Redis"
"${DC[@]}" kill -s SIGKILL worker 2>&1 | tail -1 | sed 's/^/  /'
"${DC[@]}" exec -T redis redis-cli FLUSHALL | sed 's/^/  redis: /'
"${DC[@]}" start worker 2>&1 | tail -1 | sed 's/^/  /'
BEFORE=$(runs)
wait_runs_above "$BEFORE" 90
check "schedule recovered from PostgreSQL alone" "$([ "$(runs)" -gt "$BEFORE" ] && echo yes)" "yes"

# Later steps compare against this point. Results move on, but configuration and earlier history must not.
FROZEN_RUNS=$BASE_RUNS

step 13 "Recreate application containers, preserving database volumes"
API_BEFORE=$("${DC[@]}" ps -q api); WORKER_BEFORE=$("${DC[@]}" ps -q worker); WEB_BEFORE=$("${DC[@]}" ps -q web)
"${DC[@]}" up -d --force-recreate --no-deps api worker web 2>&1 | tail -1 | sed 's/^/  /'
wait_web
check "api container is new" "$([ "$("${DC[@]}" ps -q api)" != "$API_BEFORE" ] && echo yes)" "yes"
check "worker container is new" "$([ "$("${DC[@]}" ps -q worker)" != "$WORKER_BEFORE" ] && echo yes)" "yes"
check "web container is new" "$([ "$("${DC[@]}" ps -q web)" != "$WEB_BEFORE" ] && echo yes)" "yes"

step 14 "Verify saved monitors, custom fields and history remain intact"
check "monitor still exists" "$(api "$WEB/api/monitors/$ID" | json "d['name']")" "Laugenpumpe Bosch 00144978"
check "custom fields intact" "$(field_names)" "$EXPECTED_FIELDS"
check "configuration identical in PostgreSQL" "$(config_snapshot)" "$CONFIG_HASH"
check "earlier history identical" "$(history_snapshot "$FROZEN_RUNS")" "$HISTORY_HASH"

echo; echo "  Extra: PostgreSQL itself recreated, then the whole stack stopped and started (no -v)"
"${DC[@]}" up -d --force-recreate --no-deps postgres 2>&1 | tail -1 | sed 's/^/  /'
"${DC[@]}" down --remove-orphans 2>&1 | tail -1 | sed 's/^/  /'
check "volume kept after down" "$(docker volume ls -q --filter "name=^$PGDATA_VOLUME\$")" "$PGDATA_VOLUME"
"${DC[@]}" up -d --wait --wait-timeout 180 2>&1 | tail -1 | sed 's/^/  /'
wait_web
check "custom fields intact" "$(field_names)" "$EXPECTED_FIELDS"
check "configuration identical in PostgreSQL" "$(config_snapshot)" "$CONFIG_HASH"
check "earlier history identical" "$(history_snapshot "$FROZEN_RUNS")" "$HISTORY_HASH"
check "migrations did not re-apply or reset" "$(sql "SELECT count(*) FROM _prisma_migrations")" "1"
BEFORE=$(runs)
wait_runs_above "$BEFORE" 90
check "monitoring continues after full stop and start" "$([ "$(runs)" -gt "$BEFORE" ] && echo yes)" "yes"

step 15 "Record actual test results"
echo "  total runs recorded: $(runs)"
echo "  $PASS passed, $FAIL failed"
echo "Finished $(date -u '+%Y-%m-%d %H:%M:%S UTC')"

# Verification is over, so this removes the throwaway stack and only its own named volume.
"${DC[@]}" down --remove-orphans >/dev/null 2>&1
docker volume rm "$PGDATA_VOLUME" >/dev/null 2>&1

if [ "$FAIL" -eq 0 ]; then echo "RESULT: PASSED"; else echo "RESULT: FAILED"; exit 1; fi
