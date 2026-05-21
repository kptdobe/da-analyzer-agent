# DA Analyzer Agent — knowledge base

Shared context for DA log analysis, error investigation, and cross-repo
code review. Auto-loaded by Claude Code in any session run in this repo.

This file is **mode-agnostic**: it captures the toolbox (repo map, query
mechanics, DataPrime gotchas, known patterns) that every consumer needs.
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
2. Querying logs (Coralogix DataPrime)
3. DataPrime gotchas
4. Drill-down templates
5. Known recurring patterns
6. Operating constraints

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

## 2. Querying logs (Coralogix DataPrime)

Logs flow into the Coralogix `da-logs` environment. Access is via the
in-repo Coralogix MCP server (`./mcp-servers/coralogix/`), exposed as
the `mcp__coralogix__query_coralogix` tool.

A second environment, `helix`, exists for the broader Helix platform.
Out of scope for this workspace, but worth knowing about for
interactive sessions chasing upstream issues.

Two log streams exist:

- **Worker trace stream** — keyed by `$d.ScriptName`. Has thrown
  exceptions, console logs, request/response shape. This is the primary
  source for error investigation.
- **Access log stream** — keyed by `$d.WorkerScriptName`. HTTP-level
  only, no application context. Useful for traffic/load questions, less
  useful for bug hunting.

### Canonical investigation patterns

**Worker × outcome × HTTP status × exception** (catches thrown
exceptions). `explode` drops rows with no exceptions, so this captures
`Outcome == 'exception'` cleanly. Run once per worker — see §3 on the
`$d.ScriptName` groupby limitation.

**HTTP-only 5xx** (`Outcome == 'ok'`, no thrown exception). Needed
because `explode` drops empty arrays — these surface as "5xx returned
but no exception thrown."

**Console-error / warn surface** (per-worker). Catches bugs that
return 200 to the client but log an internal error/warn — the
canonical query misses these because `Outcome == 'ok'` and
`Status < 500`. `groupby` after `explode $d.Logs` only works on the
post-explode `l.*` fields. An `l.Level == 'warn'` variant is often
useful alongside `'error'`.

These three queries are the workhorses. The routine runs them daily for
all three backend workers (see `ROUTINE.md`); for interactive use,
pick the one that matches what you're chasing.

---

## 3. DataPrime gotchas

Painful re-derivations. Read these before writing a query.

- No `=~`, no `tostring()` / `to_string()`. For prefix match use
  `$d.field.startsWith('prefix')`.
- `unnest` is not a keyword. Use `explode <array> into <alias>` (drops
  rows with empty arrays — see §2 HTTP-only 5xx pattern).
- `convert` syntax: `convert <field>:<type>` (no `to`). `:string` on
  `array<object>` returns null on this dataset.
- `percentile()` not available; use min/max/avg or histogram groupings.
- **`groupby $d.ScriptName` is unreliable.** `groupby` may report
  `keypath does not exist` for `$d.X.Y` after `create`/`explode`. The
  pre-projection-with-`choose` workaround does not work on this dataset
  either — `groupby` on the choose-aliased name (e.g.
  `choose $d.ScriptName as script | ... | groupby script`) still errors
  `keypath does not exist: script`. **Working fallback**: run the
  canonical query once per worker (filter `$d.ScriptName == 'da-admin'`
  etc.) and `groupby` only on the post-explode fields (`exc.Name`,
  `exc.Message`). Sum/aggregate per-worker results manually.
- After `explode <array> into l`, both `$d.*` keypaths AND choose-aliased
  names referencing fields outside the exploded array fail with
  `keypath does not exist`. `create <alias> from $d.X.Y` aliases ALSO
  fail post-explode — same limitation as `choose`. **Cleanest
  console-log drilldown** (URL/method/status alongside log message):
  skip `explode` entirely, select `$d.Event.Request.URL`,
  `$d.Event.Response.Status`, `$d.Logs` and inspect rows individually
  (the Logs array is small per record). Only `explode $d.Logs into l`
  when you just need `l.Level` / `l.Message` aggregates.
- Nested `explode` invalidates the prior `explode`'s alias. After
  `| explode $d.Logs into l | explode l.Message into m`, the symbol `l`
  no longer resolves (e.g. `l.Level` errors `keypath does not exist`).
  To filter by `l.Level`, do it before the second explode.
- Substring match on a single string field post-explode works:
  `| explode l.Message into m | filter m.contains('alt on type image')`
  is reliable. Use this when you have a long error string and need to
  isolate one bug without typing it verbatim.
- **Pairing URL with post-explode log content is currently not
  possible.** No `array.any(...)` / `array.some(...)` predicates exist;
  `convert :string` on `array<object>` returns null; `~` / `contains`
  against an `array<object>` fails. If you need to attribute a
  `console.error` to a specific URL/docname, the only reliable path is
  to surface the identifying field into the log call itself in the
  worker source (e.g. add `docName` to `console.error('[docroom] Failed
  to update document', err, docName)` and the next day's logs will
  carry it).
- Predicates: `l.Level contains 'error'` is malformed. Use equality
  (`l.Level == 'error'`) or `||` for multiple levels. `count` is a
  top-level operator, not a function — use `| count` (returns
  `[{ "_count": N }]`).
- After `explode $d.Logs into l`, `l.Message` is an array of strings,
  not a string. `groupby l.Message agg count()` collapses to a single
  null-keyed row (because grouping on an array yields null). To
  aggregate console-log messages, **double-explode**:
  `| explode l.Message into m | groupby m`. Each log row typically
  produces 2 `m` rows (e.g. `["writeAuditEntry failed",
  "PreconditionFailed: …"]`), so a per-event count = `max(cnt)` across
  distinct `m` values that always co-occur.
- `stringify()` is not a DataPrime function. There is no built-in way
  to filter "rows where any element of an array field matches X"
  before exploding. Workaround: explode first, then filter post-explode.
- **Time bucketing**: `timebucket(...)` is not a DataPrime function.
  `formatTimestamp(format='...', timezone='...')` rejects the
  `timezone` keyword and treats a positional format-literal as a
  static string. Hourly burst-concentration analysis is not currently
  achievable. **Workaround for "is the burst still in flight"**:
  re-run `... | count` for the same query 2–3 times across a few
  minutes — if the count climbs (e.g. 5011 → 5199 → 5300 within 10
  minutes) the burst is active, not historical.
- **Grand groupby across all `$d.Outcome` values silently drops
  low-frequency console-error messages** (observed 2026-05-20). The
  pipeline `| explode $d.Logs into l | filter l.Level == 'error' |
  explode l.Message into m | groupby m agg count() as cnt` returns
  only the top-N distinct messages — secondary patterns with
  single-digit counts are missing even at `limit 50`. One run returned
  0 for `Failed to version (in object with version)` in the grand
  groupby, then 6 when scoped to `| filter $d.Outcome == 'canceled'`
  before the `explode`. **Workaround**: when chasing a specific
  low-frequency `console.error`, scope by `$d.Outcome` (`ok`,
  `exception`, `canceled`) one at a time before the `explode`, and
  sum manually. Same shape as the per-worker `$d.ScriptName` fallback.
  Apply preemptively when verifying that a rare known pattern is
  still present (e.g. `Worker exceeded memory limit`).

---

## 4. Drill-down templates

_(Populate as patterns emerge. Add a template here only when you've
re-derived it more than once. Keep sparse — context cost matters for
interactive sessions.)_

---

## 5. Known recurring patterns

Background-noise errors that fire continuously and are either
benign-by-design or already tracked. **Treat as baseline; do not file
new PRs.** If you're investigating one of these and the rate looks
materially different from the noted baseline, that's worth flagging.

_(Populate over time. Suggested columns: pattern keyword | worker |
baseline rate (per 24h) | last observed | known PR/issue if any.)_

---

## 6. Operating constraints

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
- Coralogix auth: `CORALOGIX_API_KEY` from the environment. The MCP
  server in `./mcp-servers/coralogix/` reads `process.env`. Never log
  it.
