import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const ENDPOINTS = {
  'da-logs': 'https://ng-api-http.coralogix.com/api/v1/dataprime/query',
  helix: 'https://ng-api-http.coralogix.com/api/v1/dataprime/query',
};

const API_KEYS = {
  'da-logs': process.env.CORALOGIX_DA_KEY,
  helix: process.env.CORALOGIX_HELIX_KEY,
};

/**
 * Parse newline-delimited JSON response from Coralogix DataPrime API.
 * Each line is a JSON object: { result: { results: [{ userData: '...' }] } }
 */
function parseCoralogixResponse(text) {
  if (!text || !text.trim()) return [];
  return text
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      const parsed = JSON.parse(line);
      // Handle both result rows and metadata/error lines
      const results = parsed?.result?.results ?? [];
      return results.map(({ userData }) => JSON.parse(userData));
    });
}

async function queryCoralogix(env, query) {
  const apiKey = API_KEYS[env];
  if (!apiKey) {
    throw new Error(`No API key configured for environment "${env}". Set CORALOGIX_${env.toUpperCase().replace('-', '_')}_KEY.`);
  }

  const endpoint = ENDPOINTS[env];
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ query }),
  });

  const body = await resp.text();
  if (!resp.ok) throw new Error(`Coralogix query failed [${resp.status}]: ${body}`);

  return parseCoralogixResponse(body);
}

const server = new McpServer({
  name: 'coralogix',
  version: '1.0.0',
});

server.registerTool(
  'query_coralogix',
  {
    title: 'Query Coralogix',
    description:
      'Execute a DataPrime query against a Coralogix environment and return the results as JSON. '
      + 'Use this to search, filter, aggregate, and analyze log data. '
      + '\n\n## Environments\n\n'
      + '### "da-logs" — DA (Document Authoring) logs at da-logs.coralogix.com\n\n'
      + 'IMPORTANT: This environment contains TWO completely different log schemas. '
      + 'They coexist in the same "source logs" stream but have different fields. '
      + 'Always pick the right schema for the task:\n\n'

      + '#### Schema 1: Cloudflare ACCESS logs (HTTP request/response metadata)\n'
      + 'Use for: traffic volumes, client IPs, CDN cache hits, request counts by path.\n'
      + 'Filter field: $d.WorkerScriptName (the worker that handled the request)\n'
      + 'Key fields:\n'
      + '  - $d.WorkerScriptName: worker name, empty string if no worker ran. DA workers are prefixed "da-" (da-admin, da-collab, da-content, da-website, da-ue, da-docket)\n'
      + '  - $d.EdgeResponseStatus: HTTP status code seen by the client\n'
      + '  - $d.ClientRequestHost, $d.ClientRequestPath, $d.ClientRequestURI: request URL parts\n'
      + '  - $d.ClientRequestMethod: HTTP method\n'
      + '  - $d.ClientIP, $d.ClientCountry, $d.ClientCity: client location\n'
      + '  - $d.ZoneName: Cloudflare zone (e.g. "da.live")\n'
      + '  - $d.RayID: unique Cloudflare request ID\n'
      + '  - $d.WorkerStatus, $d.WorkerCPUTime, $d.WorkerWallTimeUs: worker performance\n'
      + '  - $d.RequestHeaders, $d.ResponseHeaders: header maps\n'
      + 'Example filters:\n'
      + '  filter $d.WorkerScriptName == \'da-admin\'   // all requests handled by da-admin\n'
      + '  filter $d.WorkerScriptName =~ /^da-/         // any DA worker (use =~, not ~~)\n'
      + '  filter $d.WorkerScriptName == \'\'             // pure CDN, no worker\n\n'

      + '#### Schema 2: Cloudflare WORKER TRACE logs (worker execution internals)\n'
      + 'Use for: worker errors, console.log/warn/error output, exceptions, 500 debugging, internal execution details.\n'
      + 'CRITICAL: This is the correct schema when the user asks about "worker logs", "errors in the worker", "500 errors", "what is the worker logging", or "worker exceptions".\n'
      + 'Filter field: $d.ScriptName (NOT $d.WorkerScriptName — different field, different schema)\n'
      + 'Key fields:\n'
      + '  - $d.ScriptName: worker script name (e.g. "da-admin")\n'
      + '  - $d.Event.Request.URL: full request URL\n'
      + '  - $d.Event.Response.Status: HTTP status code the worker returned\n'
      + '  - $d.Outcome: worker execution result ("ok", "canceled", "exceeded", "exception")\n'
      + '  - $d.WallTimeMs: wall-clock execution time in milliseconds\n'
      + '  - $d.Logs[]: array of console.log/warn/error calls — each has Level ("log","warn","error") and Message (array of strings)\n'
      + '  - $d.Exceptions[]: array of uncaught exceptions — each has Name and Message\n'
      + 'Example filters:\n'
      + '  filter $d.ScriptName == \'da-admin\'                      // da-admin worker traces\n'
      + '  filter $d.Event.Response.Status == 500                   // 500 responses\n'
      + '  filter $d.Outcome == \'exception\'                         // uncaught exceptions\n'
      + '  filter $d.Logs[0].Level == \'error\'                       // at least one error log\n\n'

      + '#### Quick decision rule\n'
      + '  "How many requests / which IPs / CDN cache?"  → ACCESS logs  ($d.WorkerScriptName)\n'
      + '  "What errors / logs / exceptions in the worker?" → WORKER TRACE logs ($d.ScriptName)\n\n'

      + '### "helix" — Helix logs environment at helix.coralogix.com\n\n'

      + '## DataPrime syntax — what works, what breaks, and why\n\n'

      + '### Aggregation / counting\n'
      + '✅ CORRECT — count must be inside "agg":\n'
      + '  source logs last 24h | filter ... | groupby $d.field agg count() as cnt | orderby cnt desc\n'
      + '  source logs last 24h | filter ... | groupby $d.f1, $d.f2 agg count() as cnt\n'
      + '❌ BREAKS — standalone count() step:\n'
      + '  source logs last 24h | filter ... | count()        → error: expected keyword "into"\n'
      + '❌ BREAKS — count after a pipe following groupby:\n'
      + '  source logs last 24h | groupby $d.f | count() as cnt  → same "into" error\n'
      + 'Rule: count() is only valid as an argument to "agg", never as a standalone pipe step.\n\n'

      + '### Filtering after aggregation\n'
      + '✅ You can filter on computed aggregation fields after groupby:\n'
      + '  groupby $d.field agg count() as cnt | filter cnt > 5 | orderby cnt desc\n\n'

      + '### String / regex operators\n'
      + '✅ Equality:          filter $d.field == \'value\'\n'
      + '✅ Inequality:        filter $d.field != \'value\'\n'
      + '✅ Regex match:       filter $d.field =~ /pattern/\n'
      + '❌ BREAKS — ~~ (contains) on any sub-field:\n'
      + '  filter $d.ScriptName ~~ /da-/   → error: ~~ only works on $d\n'
      + '  The ~~ operator only operates on the whole $d document, never on a named field.\n'
      + '  Use =~ for all per-field pattern matching: filter $d.field =~ /pattern/\n'
      + '❌ BREAKS — negated regex with !~:\n'
      + '  filter $d.field !~ /pattern/   → error: expected one of keywords [&&,||,==,!=,...] at "!"\n'
      + '❌ BREAKS — not() function:\n'
      + '  filter not ($d.field =~ /pattern/)   → error: unknown function "not"\n'
      + 'Workaround for "exclude pattern": restructure to filter what you WANT, not what you exclude.\n'
      + 'If you need exclusion after a groupby, use a positive filter on the grouped result:\n'
      + '  groupby $d.Event.Request.URL agg count() as cnt | filter $d.Event.Request.URL =~ /wanted_prefix/ | orderby cnt desc\n\n'

      + '### Numeric comparisons\n'
      + '✅ filter $d.Event.Response.Status == 500\n'
      + '✅ filter $d.Event.Response.Status >= 500\n'
      + '✅ filter $d.EdgeResponseStatus != 200\n\n'

      + '### Null / existence checks\n'
      + '✅ filter $d.field != null    — field exists and is not null\n'
      + '✅ filter $d.field == null    — field is absent or null\n\n'

      + '### Array fields (Logs[], Exceptions[])\n'
      + 'Worker trace logs have array fields. These rules apply:\n'
      + '✅ Index into an array and access a scalar sub-field in a filter:\n'
      + '  filter $d.Logs[0].Level == \'error\'    — true if the FIRST log entry is level "error"\n'
      + '❌ BREAKS — accessing .Message on an array element (it is itself an array):\n'
      + '  filter $d.Logs[0].Message              → error: unknown field ".Message"\n'
      + '  filter $d.Exceptions[0].Message        → same error\n'
      + '  Message is a string[] (all console.log args joined). DataPrime cannot filter into it.\n'
      + '❌ BREAKS — nested array element access:\n'
      + '  filter $d.Logs[0].Message[0]           → compilation error\n'
      + '❌ BREAKS — array length / size functions:\n'
      + '  array_length($d.Exceptions)             → error: unsupported function\n'
      + '❌ BREAKS — unnest / flatten arrays:\n'
      + '  unnest $d.Exceptions as exc             → error: "unnest" is not a valid DataPrime keyword\n'
      + '  unnest $d.Logs as log                   → same error\n'
      + '  There is no way to explode/flatten array fields in DataPrime.\n'
      + 'Best practice for array content: use "select" to retrieve the raw arrays and inspect client-side:\n'
      + '  select $d.Event.Request.URL, $d.Logs, $d.Exceptions | limit 50\n'
      + 'The Message field on a log entry is an array of strings (all console.log arguments).\n'
      + 'The Exceptions[].Message is a plain string (the exception message).\n'
      + 'To find specific log content, retrieve the raw arrays and filter in your analysis — not in the query.\n\n'

      + '### select / projection\n'
      + '✅ select $d.field1, $d.field2           — return only these fields\n'
      + '✅ select $d.Event.Request.URL, $d.Logs  — nested fields work\n\n'

      + '### Time windows\n'
      + '✅ source logs last 1h\n'
      + '✅ source logs last 24h\n'
      + '✅ source logs last 7d\n\n'

      + '### limit\n'
      + '✅ Always add | limit N at the end of exploratory queries to avoid huge result sets.\n'
      + '   Default without limit can return thousands of rows.\n\n',

    inputSchema: {
      env: z.enum(['da-logs', 'helix']).describe(
        'Coralogix environment to query. "da-logs" contains both Cloudflare access logs ($d.WorkerScriptName) and Cloudflare Worker trace logs ($d.ScriptName) — pick the right schema. "helix" is the Helix environment.',
      ),
      query: z.string().describe(
        'DataPrime query string. Examples:\n'
        + '  // ACCESS logs — traffic by worker (use $d.WorkerScriptName)\n'
        + "  source logs last 1h | filter $d.WorkerScriptName == 'da-admin' | groupby $d.EdgeResponseStatus agg count() as cnt | orderby cnt desc\n"
        + '  // WORKER TRACE logs — 500 errors with console output (use $d.ScriptName)\n'
        + "  source logs last 24h | filter $d.ScriptName == 'da-admin' | filter $d.Event.Response.Status == 500 | select $d.Event.Request.URL, $d.Logs, $d.Exceptions | limit 50\n"
        + '  // WORKER TRACE logs — worker exceptions\n'
        + "  source logs last 24h | filter $d.ScriptName == 'da-admin' | filter $d.Outcome == 'exception' | select $d.Event.Request.URL, $d.Exceptions | limit 20\n"
        + '  // WORKER TRACE logs — count by response status\n'
        + "  source logs last 24h | filter $d.ScriptName == 'da-admin' | groupby $d.Event.Response.Status agg count() as cnt | orderby cnt desc\n"
        + '  // ACCESS logs — top paths with 5xx\n'
        + '  source logs last 7d | filter $d.EdgeResponseStatus >= 500 | groupby $d.ClientRequestPath agg count() as cnt | orderby cnt desc | limit 50',
      ),
    },
  },
  async ({ env, query }) => {
    const results = await queryCoralogix(env, query);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(results, null, 2),
        },
      ],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
