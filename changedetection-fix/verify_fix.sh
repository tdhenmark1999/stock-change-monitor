#!/usr/bin/env bash
# Replays each reproduced data-loss scenario against the fixed image and asserts the new behaviour.
# Only touches resources prefixed "cdfix-".
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
IMAGE=changedetection-fixed:0.55.8
A=cdfix-app; B=cdfix-app2; VOL=cdfix-vol; WRONG=cdfix-wrong
PA=15199; PB=15198
PASS=0; FAIL=0

check() { # description, actual, expected-substring
  if [[ "$2" == *"$3"* ]]; then echo "  PASS  $1"; PASS=$((PASS+1));
  else echo "  FAIL  $1 (expected '$3', got '$2')"; FAIL=$((FAIL+1)); fi
}

cleanup() {
  docker rm -f "$A" "$B" >/dev/null 2>&1 || true
  docker volume rm "$VOL" "$WRONG" >/dev/null 2>&1 || true
}
trap cleanup EXIT

wait_up() {
  for _ in $(seq 1 90); do
    curl -fs -m 2 "http://127.0.0.1:$1/" >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "  !! port $1 did not come up"; return 1
}

# Waits for a container that should refuse to start, prints its exit code.
exit_code_of() {
  for _ in $(seq 1 45); do
    [ "$(docker inspect "$1" --format '{{.State.Running}}')" = "false" ] && break
    sleep 1
  done
  docker inspect "$1" --format '{{.State.Running}}/{{.State.ExitCode}}'
}

api_key() {
  docker exec "$1" python3 -c "import json;print(json.load(open('/datastore/changedetection.json'))['settings']['application']['api_access_token'])"
}

new_watch() {
  curl -fs -X POST "http://127.0.0.1:$1/api/v1/watch" -H "x-api-key: $2" -H 'content-type: application/json' \
    -d '{"url":"https://example.com/?fix=1","title":"t","include_filters":["h1"]}' \
    | python3 -c "import json,sys;print(json.load(sys.stdin)['uuid'])"
}

api_filters() {
  curl -s "http://127.0.0.1:$1/api/v1/watch/$3" -H "x-api-key: $2" \
    | python3 -c "import json,sys;print(json.load(sys.stdin).get('include_filters'))"
}

put_field() {
  curl -s -o /dev/null -w '%{http_code}' -X PUT "http://127.0.0.1:$1/api/v1/watch/$3" -H "x-api-key: $2" \
    -H 'content-type: application/json' -d '{"include_filters":["h1",".price"]}'
}

docker build -q -t "$IMAGE" "$HERE" >/dev/null || { echo "build failed"; exit 1; }
echo "image: $IMAGE"

echo; echo "B. no volume: must refuse to start"
cleanup
docker run -d --name "$A" -p "127.0.0.1:$PA:5000" "$IMAGE" >/dev/null
check "exits with code 3" "$(exit_code_of "$A")" "false/3"
check "explains why" "$(docker logs "$A" 2>&1)" "is not a mounted volume"

echo; echo "C. volume at the wrong path: must refuse to start"
cleanup
docker run -d --name "$A" -p "127.0.0.1:$PA:5000" -v "$WRONG:/data" "$IMAGE" >/dev/null
check "exits with code 3" "$(exit_code_of "$A")" "false/3"

echo; echo "A/D. correct volume: every form field survives check, restart and recreate"
cleanup
docker run -d --name "$A" -p "127.0.0.1:$PA:5000" -v "$VOL:/datastore" "$IMAGE" >/dev/null; wait_up "$PA"
KEY=$(api_key "$A"); UUID=$(new_watch "$PA" "$KEY")
sweep() { docker exec -i "$A" python3 - "$1" "$UUID" < "$HERE/../investigation/form_sweep.py"; }
check "form saves without error" "$(sweep save)" "Updated watch"
check "fields after save" "$(sweep check)" "13/13"
curl -s -o /dev/null "http://127.0.0.1:$PA/api/v1/watch/$UUID?recheck=1" -H "x-api-key: $KEY"; sleep 8
check "fields after check run" "$(sweep check)" "13/13"
docker restart "$A" >/dev/null; wait_up "$PA"
check "fields after restart" "$(sweep check)" "13/13"
docker rm -f "$A" >/dev/null
docker run -d --name "$A" -p "127.0.0.1:$PA:5000" -v "$VOL:/datastore" "$IMAGE" >/dev/null; wait_up "$PA"
check "fields after recreate" "$(sweep check)" "13/13"

echo; echo "G. second instance on the same datastore: must refuse to start"
docker run -d --name "$B" -p "127.0.0.1:$PB:5000" -v "$VOL:/datastore" "$IMAGE" >/dev/null
check "second instance exits with code 3" "$(exit_code_of "$B")" "false/3"
check "explains why" "$(docker logs "$B" 2>&1)" "another instance is already using"
check "first instance still serving" "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PA/")" "200"
docker restart "$A" >/dev/null; wait_up "$PA"
check "lock released after restart, app is back" "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PA/")" "200"

echo; echo "F. datastore becomes unwritable while running: save must report failure"
cleanup
docker run -d --name "$A" --cap-drop DAC_OVERRIDE -p "127.0.0.1:$PA:5000" -v "$VOL:/datastore" "$IMAGE" >/dev/null; wait_up "$PA"
KEY=$(api_key "$A"); UUID=$(new_watch "$PA" "$KEY")
docker exec "$A" sh -c "chmod -R a-w /datastore/$UUID /datastore"
check "API returns 500 instead of 200" "$(put_field "$PA" "$KEY" "$UUID")" "500"
check "edit form shows the failure" "$(docker exec -i "$A" python3 - save "$UUID" < "$HERE/../investigation/form_sweep.py")" "could NOT be saved"
HEALTH=$(docker exec "$A" python3 -c "import tempfile; tempfile.NamedTemporaryFile(dir='/datastore').close()" 2>&1 || true)
check "healthcheck probe detects it" "$HEALTH" "Permission denied"
docker exec "$A" sh -c "chmod -R u+w /datastore"
check "same save succeeds once writable again" "$(put_field "$PA" "$KEY" "$UUID")" "200"
docker restart "$A" >/dev/null; wait_up "$PA"
check "and that save survives a restart" "$(api_filters "$PA" "$KEY" "$UUID")" ".price"

echo; echo "M. moving an existing deployment onto the fix, following README.md"
cleanup
docker run -d --name "$A" -p "127.0.0.1:$PA:5000" -v "$VOL:/datastore" ghcr.io/dgtlmoon/changedetection.io:0.55.8 >/dev/null; wait_up "$PA"
KEY=$(api_key "$A"); UUID=$(new_watch "$PA" "$KEY")
check "field saved on the original image" "$(put_field "$PA" "$KEY" "$UUID")" "200"
docker stop "$A" >/dev/null
docker rename "$A" "$A-old"
COMPOSE=(docker compose -p cdfix-compose --project-directory "$HERE" -f "$HERE/docker-compose.yml")
export CHANGEDETECTION_VOLUME="$VOL" CHANGEDETECTION_PORT="$PA" CHANGEDETECTION_CONTAINER="$A"
"${COMPOSE[@]}" up -d --wait --wait-timeout 120 >/dev/null 2>&1
check "container reports healthy" "$(docker inspect "$A" --format '{{.State.Health.Status}}')" "healthy"
check "existing watch and field kept" "$(api_filters "$PA" "$KEY" "$UUID")" ".price"
"${COMPOSE[@]}" down >/dev/null 2>&1
docker rm -f "$A-old" >/dev/null 2>&1

echo; echo "diagnose.sh: must report each bad setup"
cleanup
docker run -d --name "$A" -p "127.0.0.1:$PA:5000" ghcr.io/dgtlmoon/changedetection.io:0.55.8 >/dev/null; wait_up "$PA"
check "no volume" "$(bash "$HERE/diagnose.sh" "$A" 2>&1)" "/datastore is NOT mounted"
cleanup
docker run -d --name "$A" --cap-drop DAC_OVERRIDE -p "127.0.0.1:$PA:5000" -v "$VOL:/datastore" ghcr.io/dgtlmoon/changedetection.io:0.55.8 >/dev/null; wait_up "$PA"
KEY=$(api_key "$A"); UUID=$(new_watch "$PA" "$KEY")
docker exec "$A" sh -c "chmod -R a-w /datastore/$UUID /datastore"
put_field "$PA" "$KEY" "$UUID" >/dev/null
OUT=$(bash "$HERE/diagnose.sh" "$A" 2>&1)
check "unwritable datastore" "$OUT" "cannot write to /datastore"
check "failed saves in the log" "$OUT" "failed save(s) in the current log"
docker exec "$A" sh -c "chmod -R u+w /datastore"
docker run -d --name "$B" -p "127.0.0.1:$PB:5000" -v "$VOL:/datastore" ghcr.io/dgtlmoon/changedetection.io:0.55.8 >/dev/null; wait_up "$PB"
check "two instances on one datastore" "$(bash "$HERE/diagnose.sh" "$A" 2>&1)" "2 running containers share it"

echo; echo "Result: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
