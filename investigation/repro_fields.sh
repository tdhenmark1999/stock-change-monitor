#!/usr/bin/env bash
# Field-level loss scenarios on changedetection.io, all with a correct /datastore volume.
# Only touches resources prefixed "cdrepro-".
#
# Usage: investigation/repro_fields.sh [image-tag] [upgrade-tag]
set -uo pipefail

TAG="${1:-0.55.8}"
UPGRADE_TAG="${2:-0.60.10}"
IMAGE="ghcr.io/dgtlmoon/changedetection.io:${TAG}"
HERE="$(cd "$(dirname "$0")" && pwd)"
A=cdrepro-app; B=cdrepro-app2; VOL=cdrepro-vol
PA=15099; PB=15098

cleanup() {
  docker rm -f "$A" "$B" >/dev/null 2>&1 || true
  docker volume rm "$VOL" >/dev/null 2>&1 || true
}
trap cleanup EXIT

wait_up() {
  for _ in $(seq 1 90); do
    curl -fs -m 2 "http://127.0.0.1:$1/" >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "  !! app on port $1 did not come up"; return 1
}

api_key() {
  docker exec "$1" python3 -c "import json;print(json.load(open('/datastore/changedetection.json'))['settings']['application']['api_access_token'])"
}

new_watch() {
  curl -fs -X POST "http://127.0.0.1:$1/api/v1/watch" -H "x-api-key: $2" -H 'content-type: application/json' \
    -d '{"url":"https://example.com/?repro=1","title":"t","include_filters":["h1"]}' \
    | python3 -c "import json,sys;print(json.load(sys.stdin)['uuid'])"
}

api_filters() {
  curl -s "http://127.0.0.1:$1/api/v1/watch/$3" -H "x-api-key: $2" \
    | python3 -c "import json,sys;print(json.load(sys.stdin).get('include_filters'))"
}

disk_filters() {
  docker exec "$1" python3 -c "import json;print(json.load(open('/datastore/$2/watch.json')).get('include_filters'))"
}

add_field() {
  curl -s -o /dev/null -w '%{http_code}' -X PUT "http://127.0.0.1:$1/api/v1/watch/$3" -H "x-api-key: $2" \
    -H 'content-type: application/json' -d '{"include_filters":["h1",".price"]}'
}

recheck() {
  curl -s -o /dev/null "http://127.0.0.1:$1/api/v1/watch/$3?recheck=1" -H "x-api-key: $2"
}

sweep() {
  docker exec -i "$1" python3 - "$2" "$3" < "$HERE/form_sweep.py"
}

docker pull -q "$IMAGE" >/dev/null
echo "image: $IMAGE"

echo; echo "=== D. real edit form, correct volume: save, check run, restart, upgrade"
cleanup
docker run -d --name "$A" -p "127.0.0.1:$PA:5000" -v "$VOL:/datastore" "$IMAGE" >/dev/null; wait_up "$PA"
KEY=$(api_key "$A"); UUID=$(new_watch "$PA" "$KEY" )
sweep "$A" save "$UUID"
echo " after save:";    sweep "$A" check "$UUID"
recheck "$PA" "$KEY" "$UUID"; sleep 8
echo " after check run:"; sweep "$A" check "$UUID"
docker restart "$A" >/dev/null; wait_up "$PA"
echo " after restart:"; sweep "$A" check "$UUID"
docker rm -f "$A" >/dev/null
docker pull -q "ghcr.io/dgtlmoon/changedetection.io:$UPGRADE_TAG" >/dev/null
docker run -d --name "$A" -p "127.0.0.1:$PA:5000" -v "$VOL:/datastore" "ghcr.io/dgtlmoon/changedetection.io:$UPGRADE_TAG" >/dev/null; wait_up "$PA"
echo " after upgrade to $UPGRADE_TAG:"; sweep "$A" check "$UUID"

echo; echo "=== E. save concurrently with check runs (one instance, 20 rounds)"
cleanup
docker run -d --name "$A" -p "127.0.0.1:$PA:5000" -v "$VOL:/datastore" "$IMAGE" >/dev/null; wait_up "$PA"
KEY=$(api_key "$A"); UUID=$(new_watch "$PA" "$KEY")
LOST=0
for i in $(seq 1 20); do
  recheck "$PA" "$KEY" "$UUID"
  curl -s -o /dev/null -X PUT "http://127.0.0.1:$PA/api/v1/watch/$UUID" -H "x-api-key: $KEY" \
    -H 'content-type: application/json' -d "{\"include_filters\":[\"h1\",\".round$i\"]}"
  sleep 1.5
  ON_DISK=$(disk_filters "$A" "$UUID")
  [[ "$ON_DISK" == *".round$i"* ]] || { LOST=$((LOST+1)); echo "  round $i lost: $ON_DISK"; }
done
echo "  rounds where the saved field was lost: $LOST/20"

echo; echo "=== F. datastore unwritable (permissions / full-disk class of failure)"
cleanup
docker run -d --name "$A" --cap-drop DAC_OVERRIDE -p "127.0.0.1:$PA:5000" -v "$VOL:/datastore" "$IMAGE" >/dev/null; wait_up "$PA"
KEY=$(api_key "$A"); UUID=$(new_watch "$PA" "$KEY")
echo "  before       : api=$(api_filters "$PA" "$KEY" "$UUID")"
docker exec "$A" sh -c "chmod -R a-w /datastore/$UUID /datastore"
echo "  PUT new field: http $(add_field "$PA" "$KEY" "$UUID")"
echo "  after save   : api=$(api_filters "$PA" "$KEY" "$UUID")  disk=$(disk_filters "$A" "$UUID")"
docker logs "$A" 2>&1 | grep -i -E 'failed to commit|permission denied|errno' | tail -2 | cut -c1-200 | sed 's/^/  log: /'
docker exec "$A" sh -c "chmod -R u+w /datastore"
docker restart "$A" >/dev/null; wait_up "$PA"
echo "  after restart: api=$(api_filters "$PA" "$KEY" "$UUID")"

echo; echo "=== G. two instances sharing one datastore"
cleanup
docker run -d --name "$A" -p "127.0.0.1:$PA:5000" -v "$VOL:/datastore" "$IMAGE" >/dev/null; wait_up "$PA"
KEY=$(api_key "$A"); UUID=$(new_watch "$PA" "$KEY")
docker run -d --name "$B" -p "127.0.0.1:$PB:5000" -v "$VOL:/datastore" "$IMAGE" >/dev/null; wait_up "$PB"
echo "  B loaded     : api=$(api_filters "$PB" "$KEY" "$UUID")"
echo "  PUT on A     : http $(add_field "$PA" "$KEY" "$UUID")"
echo "  after save   : A=$(api_filters "$PA" "$KEY" "$UUID") disk=$(disk_filters "$A" "$UUID")"
recheck "$PB" "$KEY" "$UUID"; sleep 8
echo "  after B check: A=$(api_filters "$PA" "$KEY" "$UUID") disk=$(disk_filters "$A" "$UUID")"
docker rm -f "$B" >/dev/null
docker restart "$A" >/dev/null; wait_up "$PA"
echo "  A restarted  : A=$(api_filters "$PA" "$KEY" "$UUID")"
