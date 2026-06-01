# Running the loop: dashboard + runner + terminal

Halley closes the loop from "production run happened" to "regression test our CI
catches next time." The *promote → edit* half runs anywhere. The *execute* half
— `halley ci` (replay check) and `halley bisect` (find the breaking commit) —
re-runs **your** agent against **your** repo, so it executes **where your code
lives**: a lightweight runner on your machine, or your terminal.

This is the industry-standard runner/agent pattern (the same reason `git
bisect`, GitHub self-hosted runners, and Buildkite agents run where the code is).
The dashboard enqueues and displays; the runner executes and streams results
back. And every dashboard action shows the exact terminal command, so you never
*need* the dashboard (decision **D54**, discipline **D-23**).

---

## The two-worker model (D54)

Halley's background work splits into two kinds of jobs, run by two worker
**roles**. Both are the same `worker/` process, selected by the
`HALLEY_WORKER_ROLE` environment variable.

| Role (`HALLEY_WORKER_ROLE`) | Jobs it runs | Needs | Where it runs |
|---|---|---|---|
| `docker` | `invariant.infer`, `fixture.write` | Postgres / ClickHouse / Redis only | The Docker worker (`docker compose up`) |
| `host` | `ci.run`, `bisect.run` | Your agent repo, its venv, the `halley` CLI, `halley.config.json` | A worker you launch on the host |
| `all` | all four | everything above | A single host worker (simplest dev setup) |

- **Code-only jobs** (`invariant.infer` + `fixture.write`) power *promote a run
  into a fixture* and *edit invariants*. They touch only the databases, so they
  run in the **Docker worker** out of the box — zero host setup.
- **Repo-touching jobs** (`ci.run` + `bisect.run`) re-run your agent, so they
  need your repo/venv/CLI on disk. They run in a **host worker**.

The default documented model is the **role split** above (Docker worker for
code-only, host worker for repo-touching). If you'd rather run one worker for
everything, launch a single host worker with `HALLEY_WORKER_ROLE=all` — it's the
simpler alternative and subscribes to all four queues.

> The Docker worker is already configured with `HALLEY_WORKER_ROLE=docker` in
> `docker-compose.yml`. It will **not** pick up `ci.run` / `bisect.run` — those
> wait until a host worker is running, so the two never steal each other's jobs.

---

## Starting each worker

### Docker worker (code-only jobs)

Comes up with the stack — nothing extra to do:

```bash
docker compose up        # starts ingester, dashboard, databases, and the
                         # Docker worker (HALLEY_WORKER_ROLE=docker)
```

### Host worker (repo-touching jobs)

Launched manually on your machine, pointed at the stack's host-exposed ports and
told where the CLI and replay shim live. From `worker/`:

```bash
cd worker
HALLEY_WORKER_ROLE=host \
HALLEY_CLI_PATH="$PWD/../cli/target/release/halley" \
HALLEY_SDK_PY_PATH="$PWD/../sdk-py" \
POSTGRES_URL="postgres://halley:halley@localhost:5433/halley" \
REDIS_URL="redis://localhost:6380/0" \
CLICKHOUSE_URL="http://localhost:8123" \
npm run dev
```

`npm run dev` runs the worker via `tsx` with file-watching; `npm run start` runs
it once. On startup the host worker logs its role and queues:

```
[halley-worker] role=host listening on queues: "bisect.run", "ci.run"
[heartbeat] started — key=halley:runner:heartbeat ttl=30s refresh=10000ms role=host
```

Build the CLI first so `HALLEY_CLI_PATH` points at a real binary:

```bash
cd cli && cargo build --release       # produces cli/target/release/halley
```

To run a single worker for everything instead of the split, use
`HALLEY_WORKER_ROLE=all` (it also writes the heartbeat, since it covers the host
jobs).

---

## Dev networking split (host vs in-network)

The stack exposes each datastore on a **host** port that differs from its
**in-network** port, so host processes and containers never collide. Same
pattern across all three (see `docker-compose.yml`):

| Service | Host port (host worker, CLI, dashboard-on-host) | In-network port (containers) |
|---|---|---|
| Postgres | `localhost:5433` | `postgres:5432` |
| Redis | `localhost:6380` | `redis:6379` |
| ClickHouse | `localhost:8123` | `clickhouse:8123` |

So a **host** worker uses `REDIS_URL=redis://localhost:6380/0` and
`POSTGRES_URL=…@localhost:5433/…`, while the **Docker** worker (inside the
compose network) uses `redis:6379` and `postgres:5432`. The worker reads all
three from env with the host-port values as its built-in defaults
(`worker/src/connections.ts`), so on the host you can often omit them.

---

## Per-fixture execution context

A host worker must know **which repo** to run and **which config** to use for a
given fixture. Two columns on the `fixtures` row carry that (added in Day 2):

- **`target_repo_path`** — absolute path to the git repo to run/bisect (where
  your agent's code lives, e.g. `~/halley-hero-demo`). This is **not** the same
  as `repo_path`, which is the relative path to the fixture JSON inside the
  fixture-write target.
- **`config_path`** — path to the agent's `halley.config.json` (passed to the
  CLI as the top-level `--config`).

> **Auto-population is not wired yet.** The promote/save path does not set these
> columns, so new fixtures have `target_repo_path = NULL`. A fixture with no
> `target_repo_path` honestly degrades to **needs_runner** (the dashboard shows
> the copy-paste command instead of guessing a path). To run a real dashboard CI
> or bisect today, backfill the columns manually, e.g.:

```sql
UPDATE fixtures
   SET target_repo_path = '/Users/you/your-agent-repo',
       config_path      = 'halley.config.json'
 WHERE repo_path = 'halley/fixtures/your-slug.json';
```

---

## Dashboard vs terminal — every action, both ways

The fixture edit page (`/fixtures/[id]/edit`) shows a **Runner** pill driven by
the host worker's Redis heartbeat (`halley:runner:heartbeat`, ~30 s TTL):

- **Runner: connected** — a host worker is live. "Run CI" and "Run bisect"
  execute on it and stream status (`queued → running → done/failed`), showing
  passed/total invariants for CI and the offending commit for bisect.
- **Runner: not detected** — no host worker. The buttons switch to **Copy
  command** and the exact terminal command is shown (D-23). A job enqueued with
  no runner resolves to **needs_runner** with the command in its log — never a
  fake spinner.

The terminal path is always available, runner or not. Run these from your agent
repo (the directory with `halley.config.json`):

```bash
# Replay-check one fixture at $0 (pure mode — no live API calls):
halley ci --only <slug>

# Find the first commit that broke a fixture:
halley bisect <slug> --repo <target_repo_path>
```

Both accept a top-level `--config <path>` before the subcommand if your
`halley.config.json` isn't in the current directory:

```bash
halley --config path/to/halley.config.json ci --only <slug>
```

---

## Recording fixtures (`halley record`)

`halley record` runs your agent through the capture shim to produce a
bit-fidelity cassette. It runs **on the host** (it makes a real provider call,
so it needs `OPENAI_API_KEY`) — not inside a sandbox or CI:

```bash
cd your-agent-repo
OPENAI_API_KEY=sk-... halley record
# commit the resulting halley/fixtures/<slug>.json + bodies/ into your repo
```

Replay (`halley ci`) is then $0 forever — it serves the recorded response and
never calls the provider.

---

## Quick reference

| I want to… | Connected runner | Terminal |
|---|---|---|
| Promote a run → fixture | Dashboard ("Turn this run into a test"); Docker worker handles it | — |
| Edit invariants | Dashboard invariant editor | — |
| Replay-check a fixture | Dashboard "Run CI" | `halley ci --only <slug>` |
| Find the breaking commit | Dashboard "Run bisect" | `halley bisect <slug> --repo <path>` |
| Record a new cassette | — (host, needs API key) | `halley record` |

See also: [`docs/fixture-format.md`](fixture-format.md) (the on-disk fixture v1
contract) and [`docs/DECISIONS.md`](DECISIONS.md) D54 (runner architecture).
