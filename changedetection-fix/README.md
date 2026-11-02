# changedetection.io persistence fix

A small patch and a hardened Compose file for changedetection.io 0.55.8. They address the data-loss failures below.
Evidence and limits are in [docs/ROOT-CAUSE.md](../docs/ROOT-CAUSE.md).

| Failure | Before | With this fix |
|---|---|---|
| `/datastore` is not a volume, or is mounted at the wrong path | Runs normally, then all data is deleted when the container is recreated | Refuses to start and says why |
| Datastore not writable (tested with permissions, not with a full disk) | Save reports success, then the field is gone after a restart | Save reports the failure, and the health check's write probe fails |
| Second instance on the same datastore | Instances overwrite each other's saved fields | Second instance refuses to start |
| Renamed folder or different Compose project | New empty volume, so the data looks lost | Volume has a fixed name |
| Power loss straight after a save | Recent saves may not have reached the disk | Writes are forced to disk (not tested with a real power loss) |

## 1. Find out which failure you have

Run this on the server. It only reads and changes nothing:

```bash
./diagnose.sh
```

Run it again straight after a field disappears, because a full disk or a second instance can be temporary.

## 2. Back up the current data

Replace `<container>` with your container name:

```bash
docker run --rm --volumes-from <container> -v "$PWD":/backup alpine tar czf /backup/datastore-backup.tar.gz /datastore
```

If step 1 reports that `/datastore` is not mounted, your data exists only inside that container. Copy it out
**before** stopping or recreating the container:

```bash
docker cp <container>:/datastore ./datastore-backup
```

## 3. Switch to the fixed deployment

Find the volume that holds your data:

```bash
docker inspect <container> --format '{{range .Mounts}}{{.Destination}} -> {{.Name}}{{"\n"}}{{end}}'
```

Then start the fixed image on that same volume. **Use your existing volume name here.** A new name starts empty.

```bash
docker stop <container>
docker rename <container> <container>-old
export CHANGEDETECTION_VOLUME=<your-existing-volume-name>
docker compose up -d --build
```

The old container stays stopped, so you can go back to it. Remove it once you are happy with the result.

If your data was not on a volume, restore the copy from step 2 into the new one:

```bash
docker compose up -d --build
docker cp ./datastore-backup/. changedetection:/datastore/
docker restart changedetection
```

Settings: `CHANGEDETECTION_VOLUME`, `CHANGEDETECTION_PORT`, `CHANGEDETECTION_BIND` and `CHANGEDETECTION_CONTAINER`.

Keep exactly one instance per datastore. Do not use `--scale`, and do not run two stacks on one volume.

## Verify it

Replays each scenario against the fixed image using throwaway containers:

```bash
./verify_fix.sh
```

## Upgrading later

The patch is written against 0.55.8 and is applied when the image is built. To move to a newer version, change
the `FROM` tag in the `Dockerfile` and rebuild. If the patch no longer applies, the build fails rather than
silently shipping without it. Version 0.60.10 was tested and has the same underlying behaviour, so upgrading
without this patch does not solve the problem.
