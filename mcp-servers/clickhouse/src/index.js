import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const ENDPOINT = 'https://queries.clickhouse.cloud/service/6f3c51d6-c282-421a-a46d-54fc08d4ce99/run?format=JSONEachRow';
const TABLE = 'helix_logs_production.da';

function credentials() {
  const key = process.env.CLICKHOUSE_API_KEY;
  const secret = process.env.CLICKHOUSE_API_SECRET;
  if (!key || !secret) throw new Error('CLICKHOUSE_API_KEY and CLICKHOUSE_API_SECRET must be set.');
  return Buffer.from(`${key}:${secret}`).toString('base64');
}

function parseResponse(text) {
  if (!text?.trim()) return [];
  const rows = [];
  for (const line of text.split('\n').filter(Boolean)) {
    try { rows.push(JSON.parse(line)); } catch { /* skip malformed lines */ }
  }
  return rows;
}

/**
 * Replace {startTime} and {endTime} placeholders with quoted ClickHouse datetime strings.
 * Format: 'YYYY-MM-DD HH:MM:SS.mmm' (DateTime64-compatible).
 */
function applyTimeParams(sql, startTime, endTime) {
  if (!startTime) return sql;
  const fmt = (iso) => `'${new Date(iso).toISOString().replace('T', ' ').slice(0, 23)}'`;
  const end = endTime ? fmt(endTime) : fmt(new Date().toISOString());
  return sql.replace(/\{startTime\}/g, fmt(startTime)).replace(/\{endTime\}/g, end);
}

async function queryClickHouse(sql) {
  const resp = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${credentials()}`,
    },
    body: JSON.stringify({ sql }),
  });
  const body = await resp.text();
  if (!resp.ok) throw new Error(`ClickHouse query failed [${resp.status}]: ${body}`);
  return parseResponse(body);
}

const server = new McpServer({ name: 'clickhouse', version: '1.0.0' });

server.registerTool(
  'query_clickhouse',
  {
    title: 'Query DA logs in ClickHouse',
    description:
      'Execute a SQL query against the DA access logs stored in ClickHouse and return the results as JSON.\n\n'

      + '## When to use this tool vs Coralogix (`mcp__coralogix__query_coralogix`)\n\n'
      + 'DA logs are migrating from Coralogix to ClickHouse. Use the right tool for the right data:\n\n'
      + '| Question | Use |\n'
      + '|----------|-----|\n'
      + '| Traffic volumes, request counts, HTTP status codes, error rates, top paths | **This tool (ClickHouse)** — complete access log, reliable SQL aggregation, native time bucketing |\n'
      + '| Worker exceptions, hung requests, uncaught errors, console.error/warn content | **Coralogix** — worker trace stream ($d.ScriptName) not yet in ClickHouse |\n'
      + '| Access log cross-check / historical data | Either; ClickHouse is more reliable for aggregation |\n\n'
      + '### What ClickHouse does NOT have yet\n'
      + '- Worker trace logs: thrown exceptions, console.log/warn/error output, `$d.Outcome` (ok/exception/canceled/exceeded)\n'
      + '- Per-request wall-clock time from the worker perspective (`$d.WallTimeMs`)\n'
      + '- The `cdn.time_elapsed_msec` column IS available here (CDN-observed latency), but it differs from worker internal timing\n\n'
      + '### Known data pattern: da-ue 5xx are bot noise\n'
      + '`da-ue` accounts for ~250 5xx/day but virtually all hit scanner/bot paths '
      + '(`/join_room`, `/api/heartbeat`, `/api/user/ismustmobile`, Chinese API paths, etc.). '
      + 'Filter these out before reporting da-ue as unhealthy.\n\n'

      + '## Table\n\n'
      + `\`${TABLE}\` — Cloudflare CDN access logs for DA (Document Authoring). `
      + 'One row per HTTP request. Equivalent to the Coralogix access-log schema ($d.WorkerScriptName).\n\n'

      + '## Key columns\n\n'
      + 'IMPORTANT: All column names containing a dot MUST be quoted with backticks in SQL.\n\n'
      + '| Column | Type | Description |\n'
      + '|--------|------|-------------|\n'
      + '| `timestamp` | DateTime64(3) | Request timestamp (UTC). Use for time filtering. |\n'
      + '| `` `cdn.script_name` `` | LowCardinality(String) | Worker that handled the request: da-admin, da-collab, da-content, da-website, da-ue, da-docket, or empty for pure CDN |\n'
      + '| `` `response.status` `` | UInt16 | HTTP status code returned to the client |\n'
      + '| `` `request.url` `` | String | Request path (e.g. /source/org/repo/file.html) |\n'
      + '| `` `request.host` `` | String | Host header (e.g. admin.da.live) |\n'
      + '| `` `request.method` `` | LowCardinality(String) | HTTP method (GET, POST, PUT, DELETE, OPTIONS, …) |\n'
      + '| `` `cdn.url` `` | String | Full request URL including scheme and host |\n'
      + '| `` `cdn.cache_status` `` | LowCardinality(String) | CDN cache result (hit, miss, expired, bypass, unknown, …) |\n'
      + '| `` `cdn.datacenter` `` | LowCardinality(String) | Cloudflare PoP code (e.g. SJC, LHR, BLR) |\n'
      + '| `` `cdn.time_elapsed_msec` `` | Float64 | Request wall-clock time in milliseconds |\n'
      + '| `` `cdn.is_edge` `` | Bool | True if the request was served from the edge |\n'
      + '| `` `client.ip` `` | String | Client IP address |\n'
      + '| `` `client.country_name` `` | LowCardinality(String) | ISO country code of the client (e.g. "us", "in") |\n'
      + '| `` `client.city_name` `` | LowCardinality(String) | Client city |\n'
      + '| `` `helix.owner` `` | String | GitHub org / owner (e.g. "adobecom") |\n'
      + '| `` `helix.repo` `` | String | GitHub repo name |\n'
      + '| `` `helix.route` `` | LowCardinality(String) | Helix route (e.g. "source", "assets") |\n'
      + '| `` `request.headers.user_agent` `` | String | User-Agent header |\n'
      + '| `` `response.headers.x_error` `` | String | x-error response header (set by workers on errors) |\n'
      + '| `weight` | UInt16 | Sampling weight (usually 1) |\n\n'

      + '## Time filtering\n\n'
      + 'Always add a `timestamp` predicate to avoid full-table scans.\n\n'
      + '```sql\n'
      + '-- Relative window:\n'
      + `WHERE timestamp >= now() - INTERVAL 1 HOUR\n`
      + `WHERE timestamp >= now() - INTERVAL 24 HOUR\n`
      + '-- Absolute window (use {startTime} / {endTime} placeholders when startTime/endTime params are provided):\n'
      + `WHERE timestamp >= {startTime} AND timestamp < {endTime}\n`
      + '```\n\n'

      + '## DA worker names\n\n'
      + '`da-admin` · `da-collab` · `da-content` · `da-website` · `da-ue` · `da-docket`\n\n'

      + '## Example queries\n\n'
      + '```sql\n'
      + '-- Request count by worker and status (last 24h)\n'
      + 'SELECT `cdn.script_name`, `response.status`, COUNT(*) AS cnt\n'
      + `FROM ${TABLE}\n`
      + 'WHERE timestamp >= now() - INTERVAL 24 HOUR\n'
      + 'GROUP BY `cdn.script_name`, `response.status`\n'
      + 'ORDER BY cnt DESC\n'
      + 'LIMIT 20\n\n'
      + '-- 5xx errors for da-admin (last 1h)\n'
      + 'SELECT timestamp, `request.url`, `response.status`, `response.headers.x_error`\n'
      + `FROM ${TABLE}\n`
      + "WHERE timestamp >= now() - INTERVAL 1 HOUR\n"
      + "  AND `cdn.script_name` = 'da-admin'\n"
      + '  AND `response.status` >= 500\n'
      + 'ORDER BY timestamp DESC\n'
      + 'LIMIT 50\n\n'
      + '-- Error rate by worker (absolute window via placeholders)\n'
      + 'SELECT `cdn.script_name`,\n'
      + '       countIf(`response.status` >= 500) AS errors,\n'
      + '       COUNT(*) AS total,\n'
      + '       round(100 * errors / total, 2) AS error_pct\n'
      + `FROM ${TABLE}\n`
      + 'WHERE timestamp >= {startTime} AND timestamp < {endTime}\n'
      + 'GROUP BY `cdn.script_name`\n'
      + 'ORDER BY error_pct DESC\n\n'
      + '-- Top request paths returning 401 from da-admin\n'
      + 'SELECT `request.url`, COUNT(*) AS cnt\n'
      + `FROM ${TABLE}\n`
      + "WHERE timestamp >= now() - INTERVAL 24 HOUR\n"
      + "  AND `cdn.script_name` = 'da-admin'\n"
      + "  AND `response.status` = 401\n"
      + 'GROUP BY `request.url`\n'
      + 'ORDER BY cnt DESC\n'
      + 'LIMIT 20\n'
      + '```\n\n'

      + '## SQL syntax notes\n\n'
      + '- Standard ClickHouse SQL — `COUNT()`, `countIf()`, `uniq()`, `avg()`, `max()`, `min()`, `quantile()`, `toStartOfHour()`, `toStartOfDay()` all work.\n'
      + '- Time bucketing: `toStartOfHour(timestamp)`, `toStartOfDay(timestamp)`, `toStartOfMinute(timestamp)` for time-series.\n'
      + '- String matching: `LIKE \'%pattern%\'`, `startsWith(col, \'prefix\')`, `match(col, \'regex\')`.\n'
      + '- Always use `LIMIT N` to avoid huge result sets.\n'
      + '- Use `FORMAT JSONEachRow` is already applied by the MCP — do NOT add it to your SQL.\n',

    inputSchema: {
      sql: z.string().describe(
        'ClickHouse SQL query. Use backtick-quoted dotted column names (e.g. `\\`cdn.script_name\\``). '
        + 'Always include a timestamp predicate. '
        + 'Use {startTime} and {endTime} placeholders if startTime/endTime params are provided.',
      ),
      startTime: z.string().optional().describe(
        'ISO 8601 start of the time window, e.g. "2026-06-14T00:00:00Z". '
        + 'Replaces {startTime} placeholders in the SQL query with a quoted ClickHouse datetime string.',
      ),
      endTime: z.string().optional().describe(
        'ISO 8601 end of the time window, e.g. "2026-06-15T00:00:00Z". '
        + 'Replaces {endTime} placeholders in the SQL query. Defaults to now() if startTime is provided but endTime is omitted.',
      ),
    },
  },
  async ({ sql, startTime, endTime }) => {
    const resolvedSql = applyTimeParams(sql, startTime, endTime);
    const rows = await queryClickHouse(resolvedSql);
    return {
      content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
