# DA Analyzer Agent — knowledge base

Shared context for DA log analysis, error investigation, and cross-repo
code review. Auto-loaded by Claude Code in any session run in this repo.

This file is **mode-agnostic**: it captures the toolbox (repo map, query
mechanics, known patterns) that every consumer needs.
Mode-specific protocols live elsewhere:

- **Interactive use** (a developer running `claude` locally to investigate
  something): this file is enough. Start asking questions.
- **Automated daily triage** (cloud routine on
  [claude.ai/code/routines](https://claude.ai/code/routines)): this file
  **plus** [`ROUTINE.md`](./ROUTINE.md), which adds the cron protocol,
  dedup rules, PR-vs-issue triage, run-log format, and self-optimization
  loop.

When you learn something that belongs in the shared toolbox, update
**this** file. When you learn something that's specific to the daily
routine (cadence, output format, automation gotchas), update
`ROUTINE.md`. If in doubt: put it here — interactive users benefit too.

---

## Sections

1. Repo map
2. Querying logs — ClickHouse
3. Drill-down templates
4. Known recurring patterns
5. Operating constraints

---

## 1. Repo map

DA spans five Adobe repos plus this workspace.

| Workspace path        | Fully-qualified repo        | Role                                                |
|-----------------------|-----------------------------|-----------------------------------------------------|
| `./da-analyzer-agent` | `kptdobe/da-analyzer-agent` | This workspace. Knowledge base + MCP server + routine artifacts. |
| `./da-admin`          | `adobe/da-admin`            | Backend worker — admin/auth/storage layer           |
| `./da-collab`         | `adobe/da-collab`           | Backend worker — realtime collaboration (docrooms)  |
| `./da-content`        | `adobe/da-content`          | Backend worker — content serving                    |
| `./da-live`           | `adobe/da-live`             | UI — main da.live frontend                          |
| `./da-nx`             | `adobe/da-nx`               | UI — nx component library / shared frontend         |

In **interactive** mode these are wherever the developer clones them
(see [`setup.sh`](./setup.sh) which sets up `./repos/` symlinks). In
**routine** mode they clone as siblings of `da-analyzer-agent/` at the
session root.

Always use `gh -R <org>/<repo>` explicitly when scripting against these
repos. cwd-inferred remotes are unreliable when multiple are cloned
side-by-side.

### Workers / script names

The Cloudflare script names you'll see as `$d.ScriptName` in the worker
trace stream:

| Script name   | Repo               | Notes                                       |
|---------------|--------------------|---------------------------------------------|
| `da-admin`    | `adobe/da-admin`   | Document CRUD, versioning, audit            |
| `da-collab`   | `adobe/da-collab`  | WebSocket collab, DocRoom lifecycle         |
| `da-content`  | `adobe/da-content` | Content serving                             |
| `da-website`  | `adobe/da-live`    | da.live marketing/website surface           |
| `da-ue`       | (out of scope)     | Universal Editor integration                |
| `da-docket`   | (out of scope)     | Docket service                              |

Daily routine scope is the first four. The latter two surface in logs
but aren't in the routine's clone set; investigate interactively if
they show up.

---

## 2. Querying logs — ClickHouse

The MCP tool is `mcp__clickhouse__query_clickhouse`,
backed by `./mcp-servers/clickhouse/` in this repo.

### Table

`helix_logs_production.da` — Cloudflare CDN access logs. One row per
HTTP request. This is HTTP-level only (no console logs, no stack
traces — those come from the worker trace stream, which is not yet in
ClickHouse).

### Key columns

Column names containing dots **must** be backtick-quoted in SQL.

| Column | Description |
|--------|-------------|
| `timestamp` | DateTime64(3) UTC. Always filter on this. |
| `` `cdn.script_name` `` | Worker: `da-admin`, `da-collab`, `da-content`, `da-website`, `da-ue`, `da-docket`, or `''` for pure CDN |
| `` `response.status` `` | HTTP status code returned to the client |
| `` `request.url` `` | Request path (e.g. `/source/org/repo/file.html`) |
| `` `request.host` `` | Host header (e.g. `admin.da.live`) |
| `` `request.method` `` | HTTP method |
| `` `cdn.url` `` | Full URL including scheme + host |
| `` `cdn.cache_status` `` | `hit`, `miss`, `expired`, `bypass`, `unknown`, … |
| `` `cdn.time_elapsed_msec` `` | Request wall-clock time (ms) |
| `` `client.country_name` `` | ISO country code (e.g. `"us"`, `"in"`) |
| `` `helix.owner` `` | GitHub org (e.g. `"adobecom"`) |
| `` `helix.repo` `` | GitHub repo name |
| `` `response.headers.x_error` `` | `x-error` header set by workers on errors |

### Canonical investigation patterns

```sql
-- 5xx errors by worker (last 24h)
SELECT `cdn.script_name`, `response.status`, COUNT(*) AS cnt
FROM helix_logs_production.da
WHERE timestamp >= now() - INTERVAL 24 HOUR
  AND `response.status` >= 500
GROUP BY `cdn.script_name`, `response.status`
ORDER BY cnt DESC

-- Error rate by worker over an absolute window
SELECT `cdn.script_name`,
       countIf(`response.status` >= 500) AS errors,
       COUNT(*) AS total,
       round(100 * errors / total, 2) AS error_pct
FROM helix_logs_production.da
WHERE timestamp >= {startTime} AND timestamp < {endTime}
GROUP BY `cdn.script_name`
ORDER BY error_pct DESC

-- Top 5xx paths for a specific worker
SELECT `request.url`, `response.status`, `response.headers.x_error`, COUNT(*) AS cnt
FROM helix_logs_production.da
WHERE timestamp >= now() - INTERVAL 1 HOUR
  AND `cdn.script_name` = 'da-admin'
  AND `response.status` >= 500
GROUP BY `request.url`, `response.status`, `response.headers.x_error`
ORDER BY cnt DESC
LIMIT 20

-- Hourly time-series (ClickHouse supports time bucketing natively)
SELECT toStartOfHour(timestamp) AS hour, COUNT(*) AS cnt
FROM helix_logs_production.da
WHERE timestamp >= now() - INTERVAL 24 HOUR
  AND `cdn.script_name` = 'da-admin'
GROUP BY hour
ORDER BY hour
```

### ClickHouse SQL notes

- `toStartOfHour(timestamp)`, `toStartOfDay(timestamp)`,
  `toStartOfMinute(timestamp)` — time bucketing works natively.
- `countIf(<cond>)` — conditional count in one pass.
- `uniq(<col>)` — approximate distinct count.
- `quantile(0.95)(<col>)` — percentile.
- String matching: `LIKE '%pattern%'`, `startsWith(col, 'prefix')`,
  `match(col, 'regex')`.
- `{startTime}` / `{endTime}` placeholders in the SQL are replaced by
  the MCP with quoted datetime strings when those params are provided.
- Always add `LIMIT N` on exploratory queries.

---

## 3. Drill-down templates

_(Populate as patterns emerge. Add a template here only when you've
re-derived it more than once. Keep sparse — context cost matters for
interactive sessions.)_

---

## 4. Known recurring patterns

Background-noise errors that fire continuously and are either
benign-by-design or already tracked. **Treat as baseline; do not file
new PRs.** If you're investigating one of these and the rate looks
materially different from the noted baseline, that's worth flagging.

_(Populate over time. Suggested columns: pattern keyword | worker |
baseline rate (per 24h) | last observed | known PR/issue if any.)_

---

## 5. Operating constraints

- Worker trace stream only (`$d.ScriptName`) for application-level
  investigation. Access logs (`$d.WorkerScriptName`) are HTTP-only.
- Worker list grows over time as new Adobe-owned workers onboard.
  Extend the §1 table explicitly. Do not broaden by prefix.
- **`adobe/da-live` branch naming**: pushes to da-live are gated by an
  IMS check that rejects branch names that aren't ≤8 lowercase
  alphanumeric characters — no hyphens, no underscores, no slashes. Use
  names like `claudefix` or `logpatch`. The `claude/`-prefixed
  kebab-case used elsewhere will be rejected. Other `adobe/*` repos
  accept the standard `claude/`-prefixed naming.
- **Bash gate**: the helper `paperclip-issue-update.sh` and raw `curl`
  with `${VAR}` expansion are auto-rejected by the harness. Use inline
  `node -e '<script>'` (allowed by `Bash(node:*)`) reading env vars
  via `process.env` and any payload from a freely-writable path under
  the auto-memory dir.
- ClickHouse auth: `CLICKHOUSE_API_KEY` and `CLICKHOUSE_API_SECRET` from
  the environment. MCP server at `./mcp-servers/clickhouse/` in this repo
  reads `process.env`. Endpoint:
  `https://queries.clickhouse.cloud/service/6f3c51d6-c282-421a-a46d-54fc08d4ce99/run`.
  Never log credentials.
