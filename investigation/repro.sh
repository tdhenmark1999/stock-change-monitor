#!/usr/bin/env bash
# Reproduces changedetection.io persistence behaviour against one version
# (default 0.55.8). Only touches resources prefixed "cdrepro-".
#
# Usage: investigation/repro.sh [image-tag]
set -uo pipefail

TAG="${1:-0.55.8}"
IMAGE="ghcr.io/dgtlmoon/changedetection.io:${TAG}"
PORT=15099
C=cdrepro-app
BASE="http://127.0.0.1:${PORT}"

cleanup() {
  docker rm -f "$C" cdrepro-app2 >/dev/null 2>&1 || true
  docker volume rm cdrepro-vol cdrepro-wrong >/dev/null 2>&1 || true
}
trap cleanup EXIT

wait_up() {
  for _ in $(seq 1 90); do
    curl -fs -m 2 "$BASE/" >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "  !! app did not come up"; docker logs --tail 20 "$C"; return 1
}

api_key() {
  docker exec "$C" python3 -c "import json;print(json.load(open('/datastore/changedetection.json'))['settings']['application']['api_access_token'])"
}

create_watch() {
  local key="$1"
  curl -fs -X POST "$BASE/api/v1/watch" -H "x-api-key: $key" -H 'content-type: application/json' -d '{
    "url": "https://example.com/?repro=1",
    "title": "repro-watch",
    "include_filters": ["h1", ".price"],
    "time_between_check_use_default": false,
    "time_between_check": {"hours": 6}
  }' | python3 -c "import json,sys;print(json.load(sys.stdin)['uuid'])"
}

# Prints "title | include_filters | interval", or MISSING when the watch is gone.
read_watch() {
  local key="$1" uuid="$2"
  local out
  out=$(curl -s "$BASE/api/v1/watch/$uuid" -H "x-api-key: $key")
  echo "$out" | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
    print(d['title'],'|',d['include_filters'],'|',d['time_between_check'].get('hours'))
except Exception:
    print('MISSING')"
}

scenario() {
  local name="$1"; shift
  echo; echo "=== $name"
  cleanup
  docker run -d --name "$C" -p "127.0.0.1:${PORT}:5000" "$@" "$IMAGE" >/dev/null
  wait_up || return 1
  local key uuid
  key=$(api_key); uuid=$(create_watch "$key")
  echo "  created       : $(read_watch "$key" "$uuid")"

  docker restart "$C" >/dev/null; wait_up
  echo "  after restart : $(read_watch "$key" "$uuid")"

  docker rm -f "$C" >/dev/null
  docker run -d --name "$C" -p "127.0.0.1:${PORT}:5000" "$@" "$IMAGE" >/dev/null
  wait_up
  # A fresh datastore also generates a fresh key, so re-read it.
  key=$(api_key)
  echo "  after recreate: $(read_watch "$key" "$uuid")"
}

docker pull -q "$IMAGE" >/dev/null
echo "image: $IMAGE"
echo "declared volumes: $(docker inspect "$IMAGE" --format '{{json .Config.Volumes}}')"

scenario "A. named volume mounted at /datastore (correct)" -v cdrepro-vol:/datastore
scenario "B. no volume at all"
scenario "C. volume mounted at the wrong path (/data)" -v cdrepro-wrong:/data
