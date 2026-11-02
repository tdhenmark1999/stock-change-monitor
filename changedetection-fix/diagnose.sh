#!/usr/bin/env bash
# Read-only diagnosis of a running changedetection.io deployment. Changes nothing.
# Shows which of the reproduced data-loss causes applies to this server.
#
# Usage: ./diagnose.sh [container-name]
set -uo pipefail

ok()   { echo "  [ok]   $*"; }
bad()  { echo "  [FAIL] $*"; FOUND=$((FOUND+1)); }
warn() { echo "  [warn] $*"; }
FOUND=0

echo "1. Running instances"
ALL=$(docker ps --format '{{.Names}} {{.Image}}' | grep -i changedetection | grep -v -i -E 'browser|playwright|selenium|sockpuppet' | awk '{print $1}')
CONTAINER="${1:-$(printf '%s\n' "$ALL" | head -1)}"
if [ -z "$CONTAINER" ]; then
  echo "  No changedetection container found. Pass the name: ./diagnose.sh <container>"; exit 1
fi
echo "  inspecting: $CONTAINER ($(docker inspect "$CONTAINER" --format '{{.Config.Image}}'))"
[ "$(printf '%s\n' "$ALL" | grep -c .)" -gt 1 ] && warn "more than one instance is running: $(echo $ALL)"

echo; echo "2. Is /datastore on a volume?  (no volume = data deleted when the container is recreated)"
MOUNT=$(docker inspect "$CONTAINER" --format '{{range .Mounts}}{{if eq .Destination "/datastore"}}{{.Type}} {{if .Name}}{{.Name}}{{else}}{{.Source}}{{end}}{{end}}{{end}}')
if [ -n "$MOUNT" ]; then
  ok "/datastore is mounted: $MOUNT"
else
  bad "/datastore is NOT mounted. Other mounts: $(docker inspect "$CONTAINER" --format '{{range .Mounts}}{{.Destination}} {{end}}')"
  docker inspect "$CONTAINER" --format '  command: {{json .Config.Cmd}}'
fi

echo; echo "3. Other containers using the same datastore?  (they overwrite each other's saved fields)"
if [ -n "$MOUNT" ]; then
  SOURCE=${MOUNT#* }
  SHARED=$(docker ps -a --filter "volume=$SOURCE" --format '{{.Names}} ({{.Status}})' 2>/dev/null)
  COUNT=$(printf '%s\n' "$SHARED" | grep -c .)
  RUNNING=$(docker ps --filter "volume=$SOURCE" --format '{{.Names}}' 2>/dev/null | grep -c .)
  [ "$RUNNING" -gt 1 ] && bad "$RUNNING running containers share it: $SHARED" || ok "$COUNT container(s) use it, $RUNNING running"
fi
if [ -f /proc/1/cmdline ]; then
  HOSTPROC=$(pgrep -fa 'changedetection.py' 2>/dev/null | grep -c . || true)
  [ "${HOSTPROC:-0}" -gt 1 ] && warn "$HOSTPROC changedetection.py processes on this host (including any outside Docker)"
fi

echo; echo "4. Is the datastore writable right now?  (if not, saves look fine until the next restart)"
if docker exec "$CONTAINER" python3 -c "import tempfile,os
with tempfile.NamedTemporaryFile(dir='/datastore') as f:
    f.write(b'x'); f.flush(); os.fsync(f.fileno())" 2>/dev/null; then
  ok "write probe succeeded"
else
  bad "cannot write to /datastore"
fi
docker exec "$CONTAINER" df -h /datastore | tail -1 | awk '{print "  disk: "$4" free, "$5" used"}'
docker exec "$CONTAINER" df -i /datastore 2>/dev/null | tail -1 | awk '{print "  inodes: "$5" used"}'

echo; echo "5. Failed saves in the logs  (each one is an edit that was never written to disk)"
FAILS=$(docker logs "$CONTAINER" 2>&1 | grep -c -E 'Failed to commit|No space left|Permission denied|Read-only file system')
if [ "$FAILS" -gt 0 ]; then
  bad "$FAILS failed save(s) in the current log:"
  docker logs "$CONTAINER" 2>&1 | grep -E 'Failed to commit|No space left|Permission denied|Read-only file system' | tail -3 | cut -c1-160 | sed 's/^/    /'
else
  ok "no failed saves in the current log"
fi

echo; echo "6. Recreation history  (a recent 'Created' date with old monitors missing points at step 2)"
docker inspect "$CONTAINER" --format '  created: {{.Created}}  restarts: {{.RestartCount}}  policy: {{.HostConfig.RestartPolicy.Name}}'
docker exec "$CONTAINER" sh -c 'echo "  watch folders on disk: $(find /datastore -mindepth 2 -maxdepth 2 -name watch.json | wc -l)"'
echo "  all changedetection-related volumes on this host (several can mean data sits in an old one):"
docker volume ls --format '{{.Name}}' | grep -i -E 'change|datastore' | sed 's/^/    /'

echo
if [ "$FOUND" -gt 0 ]; then echo "RESULT: $FOUND problem(s) found, see [FAIL] above."; else echo "RESULT: no problem found right now. Run this again straight after a field disappears."; fi
