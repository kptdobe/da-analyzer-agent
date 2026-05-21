# Daily log triage routine

This file documents the **automated daily log triage routine** running
on [claude.ai/code/routines](https://claude.ai/code/routines). It is
the source of truth for:

- The exact prompt configured in the routine form.
- The routine's operational protocol (dedup, triage decision tree,
  run-log format, self-optimization loop).
- The routine's cloud configuration (env vars, allowed domains,
  triggers).

The shared toolbox (repo map, query mechanics, DataPrime gotchas,
recurring patterns) lives in [`CLAUDE.md`](./CLAUDE.md) and is used
by both this routine and interactive sessions. Read both files in
sequence at the start of a routine run.

When the routine learns something:

- **Toolbox knowledge** (new DataPrime gotcha, new recurring pattern,
  new repo onboarded) → commit to `CLAUDE.md`.
- **Routine protocol** (new triage rule, new dedup heuristic, run-log
  format change) → commit to this file.

Default to `CLAUDE.md` when ambiguous — interactive users benefit too.

---

## Sections

1. Live prompt
2. Routine configuration
3. Dedup protocol
4. Triage decision tree (PR vs. issue)
5. PR workflow
6. Issue workflow
7. Daily run-log format
8. Self-optimization protocol

---

## 1. Live prompt

Exact prompt configured in the routine form. Keep in sync with the
live routine; mirror any web-form edits back here.

```
Daily DA log triage. Cron: 0 7 * * * UTC. Concurrency: skip_if_active.
Catch-up: skip_missed.

SOURCE OF TRUTH:
  - ./da-analyzer-agent/CLAUDE.md   (shared toolbox: repo map, query
                                     mechanics, DataPrime gotchas,
                                     known patterns)
  - ./da-analyzer-agent/ROUTINE.md  (this routine's protocol: dedup,
                                     triage, run-log, self-optimization)
  (Full identity: github.com/kptdobe/da-analyzer-agent — the routine
  workspace repo, distinct from any adobe/* fork. All commits, run-logs,
  and CLAUDE.md/ROUTINE.md updates go to kptdobe/da-analyzer-agent on
  main.)

First action of every run: read both files in full. This prompt is
intentionally minimal — do not duplicate logic here.

WORKSPACE LAYOUT (all paths relative to session root):
  ./da-analyzer-agent/   — kptdobe/da-analyzer-agent: knowledge base +
                            run-log target. Unrestricted push enabled.
                            Commit CLAUDE.md / ROUTINE.md updates and
                            routine/YYYY-MM-DD.md directly to main here.
  ./da-admin/            — adobe/da-admin   (backend, PRs on claude/ branches)
  ./da-collab/           — adobe/da-collab  (backend, PRs on claude/ branches)
  ./da-content/          — adobe/da-content (backend, PRs on claude/ branches)
  ./da-live/             — adobe/da-live    (UI, issues preferred)
  ./da-nx/               — adobe/da-nx      (UI, issues preferred)

When invoking gh, always use the fully-qualified -R <org>/<repo> form. Do
not rely on cwd-inferred remotes; multiple repos cloned side-by-side make
inference unreliable.

STEPS (details in ROUTINE.md):
  1. Read ./da-analyzer-agent/CLAUDE.md and ./da-analyzer-agent/ROUTINE.md.
  2. Pre-flight dedup: across all 5 adobe/* target repos, list open +
     last-7-days-merged PRs and open issues authored by you. Build the
     dedup map keyed by error signature. BEFORE any investigation.
     (ROUTINE.md §3.)
  3. Run the daily log fetch (CLAUDE.md §2 patterns, §3 gotchas).
  4. Match findings against recurring-patterns table (CLAUDE.md §5).
     Skip baseline noise; flag drift.
  5. For each new actionable finding, apply the triage decision tree
     (ROUTINE.md §4):
       a. Fixable bug: locate source → failing test → fix → green test →
          PR in the matching adobe/* repo with verbatim log extract.
       b. Architecture / pattern-level: open an issue in the matching
          adobe/* repo with log extract, hypothesis, decision needed.
       c. Ambiguous: default to issue.
  6. Write the daily run-log to ./da-analyzer-agent/routine/YYYY-MM-DD.md
     and commit to kptdobe/da-analyzer-agent main. Format in ROUTINE.md §7.
  7. Self-optimize (ROUTINE.md §8). Toolbox updates → CLAUDE.md.
     Protocol updates → ROUTINE.md. Note the update in the run-log under
     "Memory updates".

CONSTRAINTS:
  - Worker trace stream only ($d.ScriptName). Access logs out of scope.
  - Bash gate: helper scripts and raw curl with ${VAR} are rejected. Use
    `node -e '<script>'` reading process.env for any auth'd HTTP calls.
  - Empty self-optimization is fine and signal-positive — skip if nothing
    surprising happened.

OUTPUT: short, clear daily run-log committed to
./da-analyzer-agent/routine/YYYY-MM-DD.md on kptdobe/da-analyzer-agent main.
Aggregate table + recurring-pattern recognition + per-finding (keyword,
dedup result, PR-or-issue link with reason for the choice, log extract) +
memory updates. Nothing else.
```

---

## 2. Routine configuration

- **Name**: `da-daily-log-triage`
- **Model**: Opus
- **Repositories**:
  - `kptdobe/da-analyzer-agent` — _Allow unrestricted branch pushes: ON_
  - `adobe/da-admin` — OFF
  - `adobe/da-collab` — OFF
  - `adobe/da-content` — OFF
  - `adobe/da-live` — OFF
  - `adobe/da-nx` — OFF
- **Environment**: custom.
  - Allowed domains: default + the Coralogix endpoint (narrow as far as
    possible — e.g. `eu2.coralogix.com` or the specific da-logs host —
    rather than `*.coralogix.com`).
  - Env vars: `CORALOGIX_API_KEY`.
- **Setup script**: `cd da-analyzer-agent/mcp-servers/coralogix && npm ci`
  (cached after first run).
- **Connectors**: GitHub.
- **Triggers**:
  - Schedule: `0 7 * * *` UTC.
  - API trigger: enabled (for on-demand incident runs).

---

## 3. Dedup protocol

Before any investigation, build the dedup map.

```bash
gh pr    list -R adobe/da-admin   --state all --search "<keyword>" --author "@me"
gh pr    list -R adobe/da-collab  --state all --search "<keyword>" --author "@me"
gh pr    list -R adobe/da-content --state all --search "<keyword>" --author "@me"
gh pr    list -R adobe/da-live    --state all --search "<keyword>" --author "@me"
gh pr    list -R adobe/da-nx      --state all --search "<keyword>" --author "@me"
gh issue list -R adobe/da-admin   --state all --search "<keyword>" --author "@me"
gh issue list -R adobe/da-collab  --state all --search "<keyword>" --author "@me"
gh issue list -R adobe/da-content --state all --search "<keyword>" --author "@me"
gh issue list -R adobe/da-live    --state all --search "<keyword>" --author "@me"
gh issue list -R adobe/da-nx      --state all --search "<keyword>" --author "@me"
```

If a matching PR is open or merged in the last 7 days, do not file a
duplicate.

**For merged PRs**: re-run the canonical query for last 1h / last 6h.
Rate should drop to ~0 once the deploy propagates. If it has, mark
verified in the run-log. If it hasn't, comment on the merged PR with
the still-firing log extract and move on — do not open a new PR.

---

## 4. Triage decision tree (PR vs. issue)

**Open a PR when ALL of these are true:**
- Single clear root cause identified in source.
- Fix is localized (one file, or a small set of co-changed files).
- You can write a failing test that reproduces the log error.
- The fix does not change a public contract, API shape, on-disk format,
  or cross-worker protocol.
- The fix does not require a config / secrets / deploy-coordination
  change.

**Open an issue (not a PR) when ANY of these are true:**
- Root cause is a design / architecture decision (e.g. "should we retry
  vs. fail fast", "this pattern should move to a shared util", "the
  contract between da-admin and da-collab is ambiguous here").
- Fix would touch a public contract or cross-worker protocol.
- Multiple repos would need coordinated changes.
- The behavior is unexpected but not provably wrong — you can't write a
  failing test without first deciding intended behavior.
- Symptom is real but the source location is genuinely ambiguous between
  two or more files / workers / repos.
- Frontend-origin (`adobe/da-live`, `adobe/da-nx`) findings — default to
  issue unless the fix is a one-line null-guard or similar trivial
  change. UI auto-PRs carry higher blast radius.

**Ambiguous case**: default to issue. Humans can promote to PR;
demotion is costlier.

---

## 5. PR workflow

1. Identify source file in the matching repo (`CLAUDE.md` §1 map).
2. Write failing test that reproduces the log error. **Test must fail.**
3. Implement the fix.
4. Re-run test green.
5. Open PR on a `claude/`-prefixed branch:
   - **Title**: short summary of the bug
   - **Body**: verbatim failing-log extract + which query surfaced it +
     what the test asserts + any risk notes.

---

## 6. Issue workflow

Open an issue in the matching repo:

- **Title**: short summary of the unexpected behavior / pattern
- **Body**:
  - Verbatim log extract (or aggregate count if pattern-level).
  - Hypothesis: what you think is happening.
  - What decision is needed before a fix can be written.
  - Affected files / workers (best guess).
  - Frequency: count over last 24h, plus trend if observable.

Do not assign. Do not add labels (Adobe label conventions vary per repo).

---

## 7. Daily run-log format

Commit to `./da-analyzer-agent/routine/YYYY-MM-DD.md` on
`kptdobe/da-analyzer-agent` `main`. Keep it scannable — this is the
first thing read on incident review.

````markdown
# DA log triage — YYYY-MM-DD

## Aggregate
| worker      | outcome   | status | top exception           | count |
|-------------|-----------|--------|-------------------------|-------|
| da-admin    | exception | 500    | TypeError: …            |   42  |
| ...

## Recurring patterns (baseline match)
- pattern X — matched baseline (~N/day)
- pattern Y — DRIFT: was ~N/day, now M/day → [link to issue if filed]

## New findings
### 1. <keyword / short signature>
  - Classification: PR | issue | duplicate
  - Dedup: <link to existing PR/issue, or "none">
  - Action: <link to opened PR/issue, or "none — see dedup">
  - Reason for classification: <one line>
  - Log extract:
    ```
    <verbatim>
    ```

### 2. ...

## Memory updates
- Updated CLAUDE.md §<n>: <one line summary>
- Updated ROUTINE.md §<n>: <one line summary>
- (or "none — empty self-optimization")

## Run health
- Runtime: <duration>
- Queries that errored or timed out: <list, or "none">
````

---

## 8. Self-optimization protocol

After posting the daily run-log and finishing the triage loop, review
your own run:

- What did you have to look up or re-derive that should be predefined?
- What new DataPrime gotcha did you hit? → `CLAUDE.md` §3.
- What new recurring pattern did you observe? → `CLAUDE.md` §5
  (add baseline rate so future runs treat it as noise — or escalate it).
- Did a known pattern's rate shift materially vs. baseline? → update
  the `CLAUDE.md` §5 row.
- Did a worker get added? → `CLAUDE.md` §1 map + §6 constraints.
- Did the failing-test → fix → PR loop hit a new repo convention worth
  recording? → here, §5.
- Was a triage decision close to the boundary? → consider refining
  §4 here.

**Toolbox knowledge → `CLAUDE.md`. Routine protocol → this file.**
Default to `CLAUDE.md` when ambiguous; interactive users benefit too.

If any updates were made, commit to `main` of
`kptdobe/da-analyzer-agent` and note in the run-log under "Memory
updates" so future runs know the brief evolved.

**Empty self-optimization is fine and signal-positive** — skip this
step if your run hit nothing surprising.
