# Why fields disappear in changedetection.io

## Summary

changedetection.io keeps all data in memory and writes each watch to a JSON file under `/datastore`. In a healthy
deployment this works: every tested field survived saving, checking, restarting and upgrading. Fields are lost when
the deployment around it is wrong, and the application does not warn about it. Upgrading does not help, because
0.55.8 and the latest tested release, 0.60.10, behave the same way.

## What is confirmed and what is not

Everything here was reproduced locally, in throwaway containers. No live deployment was examined.

- **Confirmed:** each failure below reproduces on 0.55.8 and 0.60.10 with the scripts in `investigation/`.
- **Not confirmed:** which of them applies to a given deployment. `changedetection-fix/diagnose.sh` is meant to answer
  that in about a minute when run on the server.

## Reproduced failures

| # | Setup | Result |
|---|---|---|
| A | Named volume at `/datastore`, one instance | Everything survives restart and recreate (the control case) |
| B | No volume | Survives `restart`, **all data lost on recreate** |
| C | Volume mounted at the wrong path | Survives `restart`, **all data lost on recreate** |
| D | Real edit form, 13 fields, correct volume | 13 of 13 survive save, check, restart and upgrade (no bug here). The real upgrade is the 0.55.8 run; the 0.60.10 run recreates the same version |
| E | 20 saves racing with check runs, one instance | 0 of 20 lost (no race in a single instance) |
| F | Datastore not writable | API answers `200` and the field shows as saved, **then it is gone after a restart** |
| G | Two instances on one datastore | A check on the second instance (triggered by the script) overwrites the file, **field gone after a restart** |

### Why these match "it disappears again later"

- **B and C** explain data vanishing after an update, because `docker compose pull && up` recreates the container
  while a simple restart does not. The image declares no volume (`Config.Volumes` is `null`), so nothing warns about it.
- **F** happens because `Watch.commit()` is fire-and-forget in the source: a failed write is only logged, and the
  value stays in memory. The interface looks right until the next restart.
- **G** happens because each process rewrites the whole `watch.json` from its own memory. The source itself says
  "Multi-process safety: Not supported", but nothing enforces it.

B and C remove every watch. F and G remove only the recent edits, which is closest to the symptom of a
field disappearing while the monitor stays. They are the first things to check on a server.

### Other possibilities, not tested

- Restoring an old backup, or a person or script overwriting the datastore.
- A host-level bind mount that is itself not persistent, such as a tmpfs or a network share that drops out.
- A power loss soon after a save. Writes are not forced to disk by default (`FORCE_FSYNC_DATA_IS_CRITICAL=False`).

### Earlier upstream reports

Similar symptoms were reported and closed in older versions, for example
[#3846](https://github.com/dgtlmoon/changedetection.io/issues/3846) (interval lost on restart, 0.52.9) and
[#3621](https://github.com/dgtlmoon/changedetection.io/issues/3621) (0.50.41 wiped watches). Test D shows the
interval case does not reproduce on 0.55.8.

## Two ways to solve it

1. **`changedetection-fix/`** keeps the current tool: a small patch and a hardened Compose file that turn these silent
   failures into refusals and visible errors. All 24 checks pass in `verify_fix.sh`, including moving an existing volume onto the fix.
2. **The standalone monitor** in `apps/` removes this class of failure by design: PostgreSQL is the only source of
   truth, saves are transactions that fail visibly, any number of processes can share it, and the worker can only
   write result columns, never configuration.

Recorded output is in `investigation/results/`.
