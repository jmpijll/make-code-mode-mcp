---
name: make-expert-agent
description: >-
  Operating manual for the Make.com automation expert persona. Use when
  the persona is loaded and you're driving the make-code-mode-mcp server.
---

# Make.com expert — skill manual

This is the condensed operating manual that pairs with the [persona](AGENTS.md). It assumes you've already read the persona; this document covers *how* to drive the MCP server, with copy-paste recipes.

## The contract

1. Always `search` first when you need to know an operationId.
2. Always wrap `execute` code in an async IIFE.
3. Never mutate without explicit confirmation.
4. Surface scope errors verbatim — they tell the user how to fix the failure.

## Recipes (paste-ready)

### Recipe 1 — Who am I?

```js
(async () => {
  const r = await make.callOperation('getUsersMe', {});
  return {
    id: r.authUser.id,
    name: r.authUser.name,
    email: r.authUser.email,
    locale: r.authUser.locale,
    timezone: r.authUser.timezone,
  };
})();
```

### Recipe 2 — Inventory the workspace (orgs → teams → scenario counts)

```js
(async () => {
  const { organizations } = await make.callOperation('getOrganizations', {});
  const out = [];
  for (const org of organizations) {
    const entry = { id: org.id, name: org.name, zone: org.zone, teams: [] };
    try {
      const { teams } = await make.callOperation('getTeams', { organizationId: org.id });
      for (const team of teams) {
        try {
          const r = await make.callOperation('listScenarios', { teamId: team.id, pg: { limit: 200 } });
          entry.teams.push({
            id: team.id,
            name: team.name,
            scenarios: r.scenarios.length,
            active: r.scenarios.filter((s) => s.isActive).length,
          });
        } catch (e) {
          entry.teams.push({ id: team.id, name: team.name, error: String(e) });
        }
      }
    } catch (e) {
      entry.teamsError = String(e);
    }
    out.push(entry);
  }
  return out;
})();
```

### Recipe 3 — Find scenarios using a specific app

```js
(async () => {
  const teamId = 123456;  // ← user supplies (placeholder)
  const target = 'google-sheets';  // ← user supplies
  const { scenarios } = await make.callOperation('listScenarios', { teamId, pg: { limit: 500 } });
  const hits = [];
  for (const s of scenarios) {
    try {
      const blueprint = await make.callOperation('getScenarioBlueprint', { scenarioId: s.id });
      const json = JSON.stringify(blueprint);
      if (json.includes(target)) hits.push({ id: s.id, name: s.name, isActive: s.isActive });
    } catch (e) {
      hits.push({ id: s.id, name: s.name, error: String(e) });
    }
  }
  return hits;
})();
```

### Recipe 4 — Audit data-store usage in a team

```js
(async () => {
  const teamId = 123456; // ← placeholder
  const { dataStores } = await make.callOperation('getDataStores', { teamId, pg: { limit: 100 } });
  return dataStores.map((d) => ({
    id: d.id,
    name: d.name,
    records: d.records,
    sizeBytes: d.size,
    maxSizeBytes: d.maxSize,
    usagePercent: d.maxSize ? Math.round((d.size / d.maxSize) * 100) : null,
  }));
})();
```

### Recipe 5 — Confirm before mutating

```js
// Step 1 — read current state. Show this to the user and wait for "yes".
(async () => {
  const s = await make.callOperation('getScenario', { scenarioId: 9999 });
  return {
    id: s.scenario.id,
    name: s.scenario.name,
    isActive: s.scenario.isActive,
    teamId: s.scenario.teamId,
  };
})();

// Step 2 — only run AFTER the user confirms in chat.
(async () => {
  return await make.callOperation('updateScenario', {
    scenarioId: 9999,
    body: { isActive: false },
  });
})();
```

### Recipe 6 — Surface the scope error

```js
(async () => {
  try {
    return await make.callOperation('listAdminOwners', {});
  } catch (e) {
    // e.message is something like:
    //   [make.http] HTTP 403 on /admin/owners: VPN access only [IM121]
    //     (operation requires scope `admin:read` — check your Make.com API token has it)
    // Distinguish gates by the upstream marker. Tell the user which one hit.
    const msg = String(e);
    const isVpnGate = msg.includes('[IM121]');
    return {
      needsScope: 'admin:read',
      reason: isVpnGate
        ? 'Admin endpoint is IP-allowlisted to Make.com\'s VPN — even with the admin:read scope, requests from outside their network return 403 [IM121].'
        : 'Token is missing admin:read or your plan does not include admin endpoints. Mint a token with admin:read at https://eu1.make.com/profile/api or upgrade the plan.',
      upstream: msg,
    };
  }
})();
```

## Search idioms

```js
// What operationIds touch a path?
findOperationsByPath('/scenarios');

// What's the full parameter detail?
getOperation('listScenarios');

// Free-text search across operationId + summary
searchOperations('data store', 10);

// All POST operations under /hooks
findOperationsByPath('/hooks').filter(o => o.method === 'POST');
```

## When you genuinely don't know

Three options, in order:

1. `findOperationsByPath('<keyword>')` — fastest if you know any part of the URL.
2. `searchOperations('<natural phrase>', 25)` — ranks by operationId + summary.
3. Tell the user the API doesn't expose what they're asking about and suggest the Make.com web UI.

## Reporting style

- Quote real IDs and names.
- Tables for inventories (Markdown).
- One paragraph for single facts.
- Always include the zone (`make.spec.sourceUrl`) when results seem unexpected.
- Never invent counts; if a 403 ate part of the snapshot, say so.

## Forbidden moves

- Calling `delete*` / `purge*` / `disable*` operations without explicit, named confirmation.
- Echoing a Make.com API key, even partially.
- Calling operations not present in `search` results.
- Using top-level `await` or `return` in sandbox code.
- Pretending the API doesn't expose something without checking `searchOperations` and `findOperationsByPath` first.
