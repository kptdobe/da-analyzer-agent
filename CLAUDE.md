# DA Analyzer Agent

Claude Code workspace for analyzing DA (Document Authoring) logs, investigating errors, understanding user behavior, and creating fixes across the DA codebase.

## Repos

Local clones are symlinked under `repos/`:

| Repo | Purpose |
|------|---------|
| `repos/da-live` | Frontend — EDS-based, Lit web components (browse, edit, sheet, media blocks) |
| `repos/da-admin` | Cloudflare Worker — document storage, versioning, audit, R2/KV, config |
| `repos/da-collab` | Cloudflare Worker — collaborative editing (Yjs, WebSocket, DocRoom sessions) |
| `repos/da-content` | Cloudflare Worker — content serving / CDN layer |
| `repos/da-nx` | Shared utilities, NX CDN components, DA SDK |
| `repos/da-tools` | DA tooling and parsers |
| `repos/da-auth` | Authentication service |
| `repos/da-universal` | Universal Editor integration |

## Coralogix log environments

- **`da-logs`** — DA production logs (Cloudflare). Two coexisting schemas — always pick the right one:
  - **ACCESS logs**: HTTP request/response metadata. Key filter field: `$d.WorkerScriptName`
  - **WORKER TRACE logs**: worker internals, console output, exceptions. Key filter field: `$d.ScriptName`
- **`helix`** — Helix platform logs

The `query_coralogix` MCP tool contains the full DataPrime syntax reference. Key rules to remember:
- `count()` only valid inside `agg` — never as a standalone pipe step
- Per-field regex: `=~` only — never `~~` (that's document-level only) and never `!~`
- Array fields (`$d.Logs[]`, `$d.Exceptions[]`) cannot be unnested or have their Message filtered in DataPrime — `select` them and analyze client-side
- Negation workaround: filter what you WANT, not what you exclude

## DA workers (Cloudflare script names)

| Script name | Repo | Notes |
|-------------|------|-------|
| `da-admin` | da-admin | Document CRUD, versioning, audit |
| `da-collab` | da-collab | WebSocket collab, DocRoom lifecycle |
| `da-content` | da-content | Content serving |
| `da-website` | da-live | DA marketing/website |
| `da-ue` | da-universal | Universal Editor |
| `da-docket` | — | Docket service |

## Investigation playbook

### 500 errors / worker exceptions
1. Query WORKER TRACE logs: `filter $d.ScriptName == '<worker>' | filter $d.Event.Response.Status == 500`
2. Retrieve raw `$d.Logs` and `$d.Exceptions` arrays with `select`
3. Grep the worker's source in `repos/<repo>/src/` for the log message text
4. Check recent changes: `git -C repos/<repo> log --oneline -20`

### User behavior / traffic analysis
- Use ACCESS logs (`$d.WorkerScriptName`, `$d.ClientRequestPath`, `$d.ClientIP`)
- Group by path + status to find error hotspots
- Unique users: group by `$d.ClientIP` (or look for user identifiers in request headers)

### Document authoring session analysis
- da-collab WORKER TRACE logs contain the full DocRoom lifecycle
- Log prefixes: `[docroom]`, `[session]`, `Failed to update document`
- Correlate `$d.Event.Request.URL` (contains org/repo/path) with da-admin storage calls

### Performance analysis
- ACCESS logs: `$d.WorkerCPUTime`, `$d.WorkerWallTimeUs` (microseconds)
- WORKER TRACE logs: `$d.WallTimeMs`
- Group by URL pattern and aggregate with `avg()` or `max()` inside `agg`

## PR conventions

| Repo | Branch naming | Notes |
|------|--------------|-------|
| `da-live` | **Max 8 lowercase alphanumeric, no hyphens/underscores** — e.g. `fixauth`, `logpatch` | IMS constraint |
| All others | Standard kebab-case | e.g. `fix/audit-retry` |

Always:
- Run `npm run lint` before committing
- Write unit tests — test the failure first, then fix, then verify
- Use `gh pr create` to open PRs
