---
name: make-code-mode-mcp
description: >-
  Drive Make.com Web API v2 through the Code-Mode MCP server's two tools
  (search and execute). Use when the user asks about Make.com scenarios,
  connections, data stores, hooks, teams, organizations, custom apps,
  SDK apps, audit logs, or any inspection or change against Make.com.
---

# Make.com Code-Mode MCP — operating manual

The server exposes only **two tools** and a sandboxed JavaScript runtime. You drive the entire Make.com Web API v2 surface (~467 operations) by *writing JavaScript that the sandbox executes*, not by calling per-endpoint tools. This guide tells you how to do that effectively.

## 1. The two tools

| Tool | Purpose | Sandbox kind |
|---|---|---|
| `search` | Search the OpenAPI catalogue for operationIds, paths, summaries, parameters, required scopes. | Sync. Returns whatever your script's last expression evaluates to (typically an array of operation summaries). |
| `execute` | Run JavaScript that calls Make.com through the sandbox. Returns whatever your script's last expression evaluates to. | Async QuickJS (host calls return Promises that you `await`). |

You always start with `search` to find the operationIds you need, then `execute` to call them. **Never invent operationIds** — always confirm with `search` first; the spec changes per zone and per Make.com release.

### Sandbox JavaScript dialect — quick rules

- **Top-level `return` is not allowed.** The script body is evaluated as a module body, not a function body. Write the result as the last expression statement, or as an async IIFE.
- **Top-level `await` is not allowed.** Host calls (`make.callOperation`, `make.request`, `make.<tag>.<op>`) return Promises. Wrap in an async IIFE so the executor can await the result for you: `(async () => { const r = await make.callOperation(...); return r; })()`.
- **The last expression's value is what `execute` returns to the caller.** Object/array literals, ternary expressions, function calls — anything that evaluates is fine. `console.log` does not affect the return value but its output is captured into the logs list.

## 2. One sandbox surface — `make.*`

Inside `execute`, the global `make` namespace covers the entire Web API v2.

```text
make.spec                                  // { title, version, sourceUrl, operationCount }
make.callOperation(operationId, args)      // typed call by operationId
make.request({ method, path, query, body, headers, pathParams })
make.<tag>.<operationId>(args)             // tag-grouped accessor sugar
                                           // e.g.  make.scenarios.listScenarios(...)
                                           //       make.usersMe.getUsersMe(...)
                                           //       make.organizations.getOrganizations(...)
```

There is no `make.cloud(...)` factory or zone-switching method — the zone is fixed at server startup via `MAKE_BASE_URL` / `X-Make-Base-Url`. To address multiple Make.com zones from one MCP client, register one MCP server entry per zone.

## 3. Each operation supports three call shapes

```js
// 1. Typed-ish operationId call (preferred — readable, future-proof)
const me = await make.callOperation('getUsersMe', {});

// 2. Tag-grouped accessor (Proxy sugar for the same operation)
const me2 = await make.usersMe.getUsersMe({});

// 3. Raw escape hatch — use when the spec doesn't cover what you need,
//    or when you want to invoke a path the synthesizer didn't name.
const raw = await make.request({
  method: 'GET',
  path: '/users/me',
  query: { includeInvitedOrg: false },
});
```

The first form is the default. Reach for `make.request(...)` when the spec genuinely doesn't cover the call — that's also a signal to `search` for a real operation.

### 3.1 Smart argument routing

For typed calls (`callOperation` or tag-grouped), top-level keys are auto-routed against the operation's `parameters`:

```js
// Auto-routing: organizationId is a query param, all other keys form the body
await make.callOperation('createTeam', {
  organizationId: 123,         // → ?organizationId=123 (because spec marks it `in: query`)
  name: 'Engineering',         // → body
  description: 'Eng team',     // → body
});
```

To override, pass explicit buckets:

```js
await make.callOperation('updateScenario', {
  pathParams: { scenarioId: 456 },
  query: { confirmed: true },
  body: { name: 'new-name', isActive: true },
  headers: { 'X-Some-Extra': 'value' },
});
```

## 4. The `search → execute` loop

Standard recipe — follow it every time:

```text
1. Call search("<keywords>") with the user's question keywords, or
   search("getOperation('<id>')") to read the full parameter detail.
2. Read the operationIds, methods, paths and requiredScopes in the result.
3. Construct ONE execute() script that:
     a. wraps in async IIFE,
     b. fetches what you need with make.callOperation / make.request,
     c. shapes the result (pick fields, aggregate counts, build a table),
     d. returns a small final object — not raw payloads.
4. Format the final object for the user.
```

**Do not** call `execute` once per operation in a loop of separate tool calls. One script, many host calls. The sandbox call budget per `execute` is generous (default 25; lifted to 200 in operational scripts), so batch within a single script.

## 5. The `search` tool's globals

Inside `search`, you get:

```text
spec                            // { title, version, sourceUrl, serverPrefix, operations[] }
                                //   operations are compact: { operationId, method, path, tag,
                                //   summary, parameters, hasRequestBody, deprecated,
                                //   requiredScopes? }
searchOperations(query, limit?) // text-ranked search across operationId + summary
getOperation(operationId)       // full operation detail, by id or by "METHOD /path"
findOperationsByPath(substring) // case-insensitive path substring match
console.log(...)                // captured into the warnings list
```

Typical search calls:

```js
// Find anything about scenarios
searchOperations('scenarios', 10);

// All GET operations under /data-stores
findOperationsByPath('/data-stores').filter(o => o.method === 'GET');

// Full parameter detail
getOperation('listScenarios');
```

## 6. Error taxonomy

Errors raised inside the sandbox are pre-formatted with a stable prefix:

| Prefix | Meaning | What to do |
|---|---|---|
| `[make.http] HTTP <status> on <path>: <excerpt>` | Make.com returned a non-2xx response. For 401/403 on typed calls, the message is decorated with `(operation requires scope ``<scope>`` — check your Make.com API token has it)`. | Read the message. Common causes: missing scope (the message names it), wrong zone, free-tier limit, invalid `teamId`/`organizationId`. |
| `[make.transport] …` | Network-layer failure (DNS, TLS, connection reset). | Re-run the same script. If repeating, suspect `MAKE_BASE_URL` is wrong. |
| `[make.missing-credentials] …` | The required tenant key is not configured. | Stop and ask the user to set `MAKE_API_KEY` / `X-Make-Api-Key`. |
| `[make.budget] …` | Your script exceeded the per-execute call budget (default 25). | Reduce calls or split into two `execute` invocations. |
| `[make.unknown-operation] …` | The operationId doesn't exist in the loaded spec. | Run `search` to find the right one. Don't invent operationIds. |
| `[make.error] …` | Anything else. | Read the message. |

**Always wrap risky calls in `try/catch`** when traversing many orgs or teams, so one failure doesn't lose the rest of the snapshot:

```js
try {
  org.teams = await make.callOperation('getTeams', { organizationId: org.id });
} catch (e) {
  org.teamsError = String(e);
}
```

## 7. Picking up the user's intent — a decision tree

```text
User asks for a *summary* / *audit* / *inventory*
→ One execute() that fans out across getOrganizations → getTeams →
  listScenarios → listConnections. Aggregate, return a table-shaped object.
  Reference: scripts/discover.ts in the repo.

User asks for a *single fact* ("which scenarios are off?")
→ search('scenarios'), then a tiny execute() with one callOperation +
  one .filter().

User asks for a *change* ("activate scenario 123", "rotate webhook URL")
→ search the right PUT/PATCH/POST/DELETE operationId, run a *read-only*
  execute() first to print the current state and the new payload you
  intend to send, ask the user to confirm, THEN run the mutating execute().

User asks for something blocked by upstream Make.com (three distinct gates)
→ Read the status + error code Make returned:
   - 403 (no IP marker)           → token scope or free-plan tier limit
   - 403 "VPN access only [IM121]" → admin endpoint, IP-allowlisted
   - 402 "Payment Required"        → plan-tier gate (e.g. /audit-logs)
  Say which gate it is, name the scope/tier, suggest the next step
  (upgrade plan, use VPN-allowlisted host, mint a wider-scope token).
  Do NOT claim the endpoint doesn't exist.

User asks for something the API doesn't expose
→ Say so. Cite the limitation. Suggest the Make.com web UI. Don't fabricate.
```

## 8. Performance and budget

| Operation kind | Approximate cost |
|---|---|
| One `callOperation` / `request` round-trip to a Make.com zone | 80–400 ms (TLS + edge hop) |
| Default per-`execute` call budget | 25 host calls |
| Default per-`execute` wall-clock timeout | 30 s |
| Make.com rate limit (Core plan) | 60 req/min |

Rough sizing:

- "Tell me about my Make workspace" against a single-org / 1-team / 5-scenarios setup → ~10 calls, ~5 s.
- Same against a 5-org / 25-team / 200-scenario deployment → split into two or three `execute` calls (orgs first, then teams in a second invocation, then per-scenario detail in batches).

## 9. Multi-tenant calling

If the host is configured for multi-tenant HTTP transport, your client provides credentials via headers on each MCP request:

```text
X-Make-Api-Key     (required)
X-Make-Base-Url    (optional override; default https://eu1.make.com/api/v2)
```

Single-tenant deployments use the equivalent env vars (`MAKE_API_KEY`, `MAKE_BASE_URL`).

In Cursor IDE / Cursor CLI specifically, headers are static per server entry in `mcp.json` (no per-request header injection). To address several tenants from a single Cursor session, register one MCP server entry per tenant.

## 10. Common recipes

### 10.1 Read the current user

```js
(async () => {
  const me = await make.callOperation('getUsersMe', {});
  return { id: me.authUser.id, name: me.authUser.name, email: me.authUser.email };
})();
```

### 10.2 List orgs and the team count in each

```js
(async () => {
  const { organizations } = await make.callOperation('getOrganizations', {});
  const out = [];
  for (const org of organizations) {
    try {
      const { teams } = await make.callOperation('getTeams', { organizationId: org.id });
      out.push({ id: org.id, name: org.name, teamCount: teams.length });
    } catch (e) {
      out.push({ id: org.id, name: org.name, error: String(e) });
    }
  }
  return out;
})();
```

### 10.3 List scenarios in a team

```js
(async () => {
  const r = await make.callOperation('listScenarios', {
    teamId: 123456, // ← replace with your team id (find it via getTeams)
    pg: { limit: 50, sortBy: 'name' },
  });
  return r.scenarios.map((s) => ({ id: s.id, name: s.name, isActive: s.isActive }));
})();
```

### 10.4 Find which apps a scenario uses

```js
(async () => {
  const blueprint = await make.callOperation('getScenarioBlueprint', { scenarioId: 9999 });
  const apps = new Set();
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.module && typeof node.module === 'string') apps.add(node.module.split(':')[0]);
    for (const v of Object.values(node)) walk(v);
  }
  walk(blueprint);
  return [...apps];
})();
```

### 10.5 Confirm before mutating

```js
// Step 1 — READ the current state in one execute() and present to the user.
(async () => {
  const s = await make.callOperation('getScenario', { scenarioId: 9999 });
  return { name: s.scenario.name, isActive: s.scenario.isActive };
})();

// Step 2 — only after the user approves, run a SECOND execute() with PATCH.
(async () => {
  return await make.callOperation('updateScenario', {
    scenarioId: 9999,
    body: { isActive: false },
  });
})();
```

### 10.6 Surface the right error to the user

```js
(async () => {
  try {
    return await make.callOperation('listAdminOwners', {});
  } catch (e) {
    // e.message will be something like:
    //   [make.http] HTTP 403 on /admin/owners: VPN access only [IM121]
    //     (operation requires scope `admin:read` — check your Make.com API token has it)
    return { needsScope: 'admin:read', upstreamError: String(e) };
  }
})();
```

## 11. Caveats and known unknowns

- **Three distinct upstream gates** (per [Make's pricing page](https://www.make.com/en/pricing) and observed in verification):
  - **Plan tier 1** — free plan has "Limited" API access; most `/admin/*`, `/hq/*`, `/debug/*`, `/mailhub/*` paths and many write ops 403.
  - **Plan tier 2** — some endpoints need Teams/Enterprise even with the right scope and return `402 Payment Required` on Core (verified: `/audit-logs/*`).
  - **IP allowlist** — admin endpoints are additionally gated to Make's office VPN and return `403 VPN access only [IM121]` regardless of plan.
  Read the status/code Make returned before assuming it's a scope problem.
- **One zone per server.** The MCP server is bound to whichever zone `MAKE_BASE_URL` points at (default `eu1`). To talk to multiple zones from a single MCP client, register multiple server entries.
- **OperationIds with no spec entry don't exist.** If `make.callOperation('foo')` says `[make.unknown-operation]`, the operation isn't in the loaded spec for this zone. Use `search` to find what's actually available; don't manually URL-construct.
- **Raw requests skip scope hints.** `make.request({ method, path })` doesn't know which operation you're invoking, so its 403s are unannotated. Prefer typed `callOperation` when the spec covers the operation.
- **Spec is live-fetched at startup, with on-disk hash-keyed cache.** When the live fetch fails (network issue, zone outage), the server falls back to the bundled `make-fallback.json`. A startup warning is emitted in that case. Bundled fallback is an EU1 snapshot — operations exclusive to other zones may be missing.
- **Pre-1.0 client coverage is narrow.** The MCP wire protocol has been verified end-to-end through:
  - DeepSeek v4 Flash driving the server through `opencode --pure run` (cloud surface).
  - The official **MCP Inspector CLI** (`@modelcontextprotocol/inspector@0.20.0`) covering `tools/list`, credentialled `search`, credentialled `execute` on `getUsersMe`, and credentialled scope-403 probe on `/admin/owners`.

  See [README → Verification status](README.md#verification-status) for the matrix. It has *not* yet been validated against the Cursor IDE chat panel, Claude Desktop, Claude Code, Continue, Cline, Codeium, Aider, Zed, or the MCP Inspector **UI** (browser) mode. If you find a client where the server misbehaves, open an issue with the protocol log; the server itself is wire-correct, so most surprises will be in client wiring or env-var passing.

## 12. Where to look for more

- [`README.md`](README.md) — project overview and deployment.
- [`AGENTS.md`](AGENTS.md) — for *contributors* editing the server itself.
- [`docs/usage.md`](docs/usage.md) — how to install and run the server.
- [`docs/multi-tenant.md`](docs/multi-tenant.md) — header protocol and deployment.
- [`docs/security.md`](docs/security.md) — threat model and credential handling.
- [`scripts/discover.ts`](scripts/discover.ts) — a real, end-to-end example of the search → execute loop driving the full `make.*` surface across orgs / teams / scenarios.
