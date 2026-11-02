# Stock & Change Monitor

Monitors web pages for stock, price and content changes, with custom fields and history that are saved permanently.

## The problem

A self-hosted changedetection.io instance can lose fields: a field is added, and later it is gone. This repository has
two answers, which can be used separately:

| | What it is | Use it when |
|---|---|---|
| [`changedetection-fix/`](changedetection-fix/README.md) | A patch, hardened Compose file and read-only diagnosis script for the existing tool | You want to keep changedetection.io |
| This application (`apps/`) | A standalone monitor built on PostgreSQL | You want structured stock and price monitoring |

The investigation, including what is and is not confirmed, is in [docs/ROOT-CAUSE.md](docs/ROOT-CAUSE.md).
In short: saving works in a healthy deployment, but an unwritable disk, a second instance or a missing volume all lose
data with no warning, and upgrading does not change that.

## How the standalone monitor prevents the same failure

- **PostgreSQL is the only source of truth.** Nothing permanent lives in the browser, in memory or in a container.
- **A save either happens or fails visibly.** Each save is one transaction, and the user sees any error.
- **Checks cannot undo edits.** The worker only writes result columns, one field at a time, so it never holds a stale
  copy of a configuration to write back. A field added during a running check stays.
- **Several processes are safe.** Row locks order concurrent checks of the same monitor.
- **Schedules live in the database.** Redis only carries work, so losing Redis loses no configuration or schedules,
  only a manual check that was still queued.
- **The volume has a fixed name.** A renamed folder or project cannot start from an empty database.

## Architecture

```text
 Browser ──HTTP + password──▶ web (Next.js)
                                │  server-side, adds the API token
                                ▼
                              api (NestJS REST) ──────────────┐
                                │ queue manual checks         │ configuration
                                ▼                             ▼
                              redis (BullMQ) ◀── due checks ─ postgres (volume: esm-pgdata)
                                │                             ▲
                                ▼                             │ results and history only
                              worker ──────────────────────── ┘
                                │
                                ▼  SSRF-guarded HTTP, parsed with Cheerio
                              monitored websites
```

Only `web` publishes a port. `migrate` runs once at startup and applies pending migrations, without ever resetting data.

```text
apps/api          REST API, plus the worker entry point (src/worker.ts)
apps/web          Dashboard
packages/shared   Validation schemas
prisma            Database schema and migrations
fixture           Deterministic demo shop for tests and demos
tests             Unit, integration, browser and persistence tests
docker            Dockerfile
changedetection-fix, investigation, docs   The changedetection.io fix and its evidence
```

## Requirements

- Docker with Compose v2. That is all you need to run it.
- For development and tests: Node.js 20+ and pnpm 9.

## Run with Docker

```bash
cp .env.example .env
```

Fill in the three empty secrets in `.env` (generate each with `openssl rand -hex 24`), then start it:

```bash
docker compose up -d --build --wait
```

Open http://localhost:3000 and sign in as `ADMIN_USER` with `ADMIN_PASSWORD`.

### Try it with the demo shop

The demo shop lets you change a price or stock status and watch it get detected. Set `SSRF_ALLOW_HOSTS=fixture` in
`.env`, then:

```bash
docker compose --profile demo up -d --build --wait
```

Create a monitor for `http://fixture:4100/product/demo` with the selectors below and click **Check now**. Then change the
shop and click **Check now** again:

```bash
docker compose exec fixture node -e "fetch('http://127.0.0.1:4100/__state/demo',{method:'POST',body:JSON.stringify({price:'CHF 39.90',stock:'Ausverkauft'})})"
```

| Field | Selector | Type |
|---|---|---|
| Price | `.price` | Price |
| Availability | `.stock` | Stock status |
| Quantity | `.qty` | Stock quantity |

Leave `SSRF_ALLOW_HOSTS` empty on a public deployment.

## Configuring a monitor

Each monitor has a URL, a check interval and one or more fields. **Test fields on the page** tries the selectors
before anything is saved.

| Field type | Reads | Change is detected when |
|---|---|---|
| Text | Every matching element, joined | The text differs |
| Price | The first match, parsed as a number (`CHF 1'299.50`, `1.299,50 €`) | The number differs. A format change alone does not count |
| Stock status | The first match, compared with stock words | The text or the resulting status differs |
| Stock quantity | The first match, as a number. 0 means out of stock | The number differs |

Read from **Text** or from an **Attribute**, for example `href` on `link[itemprop=availability]`.

Stock words for German, French, Italian, Spanish and English are built in, and you can add your own per field. If a page
says nothing recognisable the status stays **unknown** rather than guessing. To watch a whole page, use the selector `body`.

- An element that disappears is recorded as a change and marked **Element missing**. Other fields keep working.
- Changing how a field is read restarts its baseline, so your edit is not reported as a page change.

## Environment configuration

| Variable | Default | Purpose |
|---|---|---|
| `POSTGRES_PASSWORD`, `API_TOKEN`, `ADMIN_PASSWORD` | required | Secrets. Startup fails without them |
| `ADMIN_USER` | `admin` | Sign-in name |
| `WEB_BIND`, `WEB_PORT` | `127.0.0.1`, `3000` | Where the dashboard listens |
| `SSRF_ALLOW_HOSTS` | empty | Exact hostnames exempt from the private-address block |
| `CHECK_ATTEMPTS` | `3` | Attempts for temporary failures |
| `CHECK_TIMEOUT_MS` | `20000` | Total time allowed per fetch |
| `WORKER_CONCURRENCY` | `5` | Checks running at once per worker |
| `SCHEDULER_TICK_MS` | `15000` | How often due monitors are looked up |
| `HISTORY_RETENTION_DAYS` | `90` | Older history is deleted. At most 5,000 runs are kept per monitor |
| `PGDATA_VOLUME` | `esm-pgdata` | Database volume name |

## Persistence verification

```bash
pnpm verify:persistence
```

This runs the 15-step procedure against the real Compose stack on a throwaway project: create a monitor and fields, check
the rows in PostgreSQL, run checks, restart each service, kill the worker with SIGKILL and empty Redis, recreate the
containers, then compare fingerprints of all configuration and earlier history. The last recorded run is in
[docs/persistence-verification.txt](docs/persistence-verification.txt).

## Testing

```bash
pnpm install
pnpm test:unit
pnpm test:integration
pnpm exec playwright install chromium
pnpm test:e2e
```

Integration tests use throwaway containers and never read `.env`. They refuse to run against any database other than
`esm_test`. Browser tests start their own stack with a separate volume.

## Local development

```bash
pnpm install
docker run -d --name esm-dev-postgres -p 127.0.0.1:5432:5432 -e POSTGRES_USER=esm -e POSTGRES_PASSWORD=esm -e POSTGRES_DB=esm -v esm-dev-pgdata:/var/lib/postgresql/data postgres:16-alpine
docker run -d --name esm-dev-redis -p 127.0.0.1:6379:6379 redis:7-alpine
export DATABASE_URL=postgresql://esm:esm@127.0.0.1:5432/esm
pnpm db:deploy
pnpm --filter @esm/shared build
pnpm --filter @esm/api build
```

Then run these in three terminals, with `DATABASE_URL` set in the first two:

```bash
pnpm --filter @esm/api start
```

```bash
pnpm --filter @esm/api start:worker
```

```bash
pnpm --filter @esm/web dev
```

## Deployment

On any server with Docker:

1. Copy the repository and create `.env` as above, with `SSRF_ALLOW_HOSTS` empty.
2. Run `docker compose up -d --build --wait`.
3. Put a TLS reverse proxy in front of `127.0.0.1:3000`. Basic authentication must not travel over plain HTTP.

To update, pull the new code and run step 2 again. Pending migrations apply automatically and the data stays.
**Do not run `docker compose down -v` on a deployment, because it deletes the database.**

Back up the database with:

```bash
docker compose exec -T postgres pg_dump -U esm esm > backup.sql
```

## Security

- **SSRF:** only `http` and `https` on ports 80, 443, 8080 and 8443. URLs with credentials are refused. Loopback, private,
  link-local (including cloud metadata), carrier-grade NAT, multicast and reserved addresses are blocked, in IPv4, IPv6 and
  IPv4-mapped forms. Checks run on save, on each redirect and at connect time, so the validated address is the one
  connected to, which stops DNS rebinding.
- **Limits:** request timeout, 5 MB response limit, five redirects and text-like content types only.
- **Access:** password on every page and API route, a token between web and API, and same-origin checks on writes. The
  API, database and Redis are not published. Containers run the app as a non-root user.
- **Websites' rules:** a numeric `Retry-After` on HTTP 429 is respected. Cloudflare block responses are reported as
  errors and never bypassed. Nothing tries to pass a CAPTCHA or log in, but such a page answering with HTTP 200 is not
  recognised as one, so its fields show as **Element missing**. The monitor identifies itself in its user agent.

## Troubleshooting

| Symptom | What to do |
|---|---|
| `set POSTGRES_PASSWORD in .env` at startup | Create `.env` from `.env.example` |
| `This address is not allowed` on save | The URL points at a private address. For the demo shop, set `SSRF_ALLOW_HOSTS=fixture` |
| `Bot protection` errors | The site is blocking automated access. Allow the monitor on that site, for example with a firewall rule |
| Field shows **Element missing** | The selector no longer matches. Try **Test fields on the page** on the edit form |
| Value is empty although the browser shows it | The page builds it with JavaScript, see the limitations below |
| Checks do not run | `docker compose ps` should show `worker` healthy. See `docker compose logs worker` |
| Dashboard shows old data after a schema error | `docker compose logs migrate` shows the migration result |

## Known limitations

- **No JavaScript rendering.** Pages are read as the server sends them. This suits server-rendered shops, but values built
  in the browser cannot be read yet. A Playwright fetch mode would need the same SSRF guard applied to every browser request.
- **No notifications yet.** Changes appear on the dashboard and in history. Webhook and email alerts are not implemented.
- **One shared sign-in.** There are no separate user accounts or roles.
- **No built-in TLS.** A reverse proxy is required on a public server.
- **Fields on text-only stock** depend on recognisable words, so unusual wording needs per-field stock words.
- **Rate limits are per site response.** There is no global per-domain limit beyond `WORKER_CONCURRENCY`.
