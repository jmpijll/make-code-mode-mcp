# AGENTS.md — Guidance for AI agents working on this repo

This repository implements a code-mode MCP server for the **Make.com Web API v2**. **Read this whole file before making changes** — it captures the architectural invariants and the lessons we paid for during the initial build.

> ## Audience disambiguation
>
> Three different "agent docs" live in this repo. Make sure you're reading the right one:
>
> | If you are… | Read |
> |---|---|
> | Editing the server's source code | **This file** + `CONTRIBUTING.md` |
> | An MCP client driving the *running* server | `SKILL.md` (operating manual) + `docs/usage.md` |
> | Wiring this MCP into your own agent and want a "Make.com expert" persona | [`examples/make-expert-agent/`](examples/make-expert-agent/) |
>
> This file (the root `AGENTS.md`) is **for contributors editing the server itself**. It is not a system prompt and not a recipe book.

---

## 1. 60-second orientation

```text
make-mcp/
├── src/
│   ├── spec/        OpenAPI loading, $ref resolution, search index
│   ├── client/      HTTP client (Authorization: Token, scope-aware errors)
│   ├── tenant/      TenantContext type + builders (env / HTTP headers)
│   ├── sandbox/     QuickJS executors (search + execute) and resource limits
│   ├── server/      MCP tool registration + stdio / Streamable HTTP transports
│   ├── config.ts    Zod-validated env loading
│   └── index.ts     Node entrypoint
├── cf-worker/       Cloudflare Worker entry (DynamicWorkerExecutor, scaffold)
├── scripts/         Operational scripts (spec refresh, live test, discovery)
├── docs/            Architecture, deployment, multi-tenant, security, usage
└── src/__tests__/   Vitest suites (81 cases)
```

The whole product is just **two MCP tools** — `search` and `execute` — backed by a sandboxed JS surface (`make.*`) that fans out to the Make.com Web API v2.

---

## 2. Architecture invariants — do not break these

1. **Two MCP tools, always.** `search` and `execute`. Adding tools defeats the Code Mode pattern.
2. **One sandbox surface — `make.*`.** Splitting into public/admin/internal namespaces defeats the "flat surface, self-documenting 403s" invariant. Admin endpoints stay in `search` results and return scope-decorated `[make.http] HTTP 403` when called without the right token.
3. **One spec per server, one zone per server.** `MAKE_BASE_URL` / `X-Make-Base-Url` selects the regional zone. No `make.zone(...)` factory inside the sandbox; multi-zone deployments register one MCP server entry per zone.
4. **Credentials never enter the sandbox.** They live on the host and are looked up from `TenantContext` when the host-side `__makeCall` / `__makeRaw` runs. The sandbox sees an opaque `make.*` prelude, never an `apiKey`.
5. **Per-request multi-tenant scoping.** In the HTTP transport, `TenantContext` is rebuilt from `X-Make-*` headers on every request and is short-lived (`AsyncLocalStorage`). Single-user fallback uses env vars.
6. **Sandbox is QuickJS WASM (Node) or a Cloudflare Worker isolate (`cf-worker/`).** No `eval`, no `vm`, no `Function`.
7. **The bundled fallback spec is not the source of truth.** `src/spec/make-fallback.json` exists for offline-mode and bootstrap-resilience only. Live deployments fetch `${MAKE_BASE_URL}/openapi.json` at startup.
8. **Scope hints come from `operation.security`.** When the loader processes the spec, the resolved scope requirements (e.g. `[["scenarios:read"]]`) are stored on each `IndexedOperation` and surfaced through `MakeHttpError.requiredScopes`. Do not derive scopes from path heuristics; if you change the loader, preserve this field.

---

## 3. Daily dev loop

```bash
npm install                # one-time (uses --legacy-peer-deps; see .npmrc)
npm run typecheck          # tsc --noEmit
npm test                   # vitest run (81 cases)
npm run lint               # eslint
npm run format:check       # prettier
npm run build              # tsc → dist/ (also copies make-fallback.json)
```

Before opening any PR, all five must be green.

For end-to-end smoke against the live Make.com API (read-only):

```bash
export MAKE_API_KEY=$(op read 'op://AI Agents/Make.com API Key Full Access/password')
npm run live-test                     # /users/me + /organizations + /teams
npm run discover                      # broader read-only sweep, writes JSON to out/
```

`scripts/live-test.ts` is the smallest viable end-to-end exercise of the sandbox; `scripts/discover.ts` fans out across orgs → teams → scenarios and dumps a JSON snapshot.

---

## 4. Where things live (when you're hunting)

| Concern | File |
|---|---|
| OpenAPI fetch + cache + fallback | `src/spec/loader.ts` |
| Bundled fallback snapshot | `src/spec/make-fallback.json` |
| Search index shape (`search` tool's payload) | `src/spec/index-builder.ts` |
| Tenant resolution from env / headers | `src/tenant/context.ts` |
| HTTP client (auth header, 429 retry, scope-aware errors) | `src/client/http.ts` |
| Single-factory client | `src/client/factory.ts` |
| Sandbox resource limits | `src/sandbox/limits.ts` |
| `search` tool sandbox (sync) | `src/sandbox/search-executor.ts` |
| `execute` tool sandbox (async) | `src/sandbox/execute-executor.ts` |
| Sandbox prelude (the JS injected on every run) | `src/sandbox/dispatch.ts` |
| Tool registration & response framing | `src/server/server.ts` |
| stdio + Streamable HTTP transports | `src/server/transport.ts` |
| Per-request header storage | `src/server/request-context.ts` |
| Cloudflare Workers entrypoint | `cf-worker/index.ts` |
| Live read-only smoke | `scripts/live-test.ts` |
| Full discovery sweep | `scripts/discover.ts` |
| Refresh bundled snapshot | `scripts/update-spec.ts` |

---

## 5. Multi-tenant header contract

| Header | Purpose |
|---|---|
| `X-Make-Api-Key` | Make.com Web API v2 token (minted at `https://<zone>.make.com/profile/api`) |
| `X-Make-Base-Url` | Zone base URL (defaults to `https://eu1.make.com/api/v2` if not set) |

Equivalent env vars for stdio / single-user mode: `MAKE_API_KEY`, `MAKE_BASE_URL`.

Missing credentials produce a `MissingCredentialsError` **inside the sandbox**, surfaced to the model with an actionable message — never a 5xx.

The six recognised zones are tracked in `KNOWN_MAKE_ZONES` in `src/config.ts`. Unknown base URLs emit a single startup warning and otherwise work — Make.com may add zones we haven't seen yet.

---

## 6. Gotchas we already paid for — read before re-debugging

### 6.1 Authorization scheme is `Token`, not `Bearer`

Make.com authenticates with `Authorization: Token <api-key>`. Don't "fix" this to `Bearer` — Make's gateway will return a generic 401 with no scope hint and you'll spend half an hour wondering why the spec says one thing and the wire another.

### 6.2 Path prefix is empty

The Make.com OpenAPI spec lists its servers as `https://<zone>.make.com/api/v2`. We bake `/api/v2` into `MAKE_BASE_URL`, so the HTTP client's `pathPrefix` is the empty string. Don't add a prefix anywhere downstream or you'll end up with `/api/v2/api/v2/...`.

### 6.3 Operation IDs in the spec are inconsistent

Some Make endpoints have stable `operationId`s (`getUsersMe`, `listScenarios`); some have synthesized ones (`createUsersMeApiTokens`). The dispatcher (`src/sandbox/dispatch.ts`) re-synthesizes any missing `operationId` from `<method><path>` and `sanitizeIdentifier`. If `search` returns an operationId you didn't expect to see, the synthesizer probably created it — that's intentional.

### 6.4 Scope-aware 403 messages come from operation context

`MakeHttpError.requiredScopes` is populated in two places:
1. The HTTP client extracts scopes from the operation passed in on the `MakeRequestParams.operation` field (when present).
2. The `formatHttpError` helper composes the final message.

The sandbox prelude passes the operation into `__makeCall` so typed calls get the scope hint. Raw `make.request(...)` calls don't have an operation context, so their 403s are unannotated — that's by design (a raw request might hit any path). Don't try to scope-guess for raw requests.

### 6.5 The bundled fallback spec is large (~1.4 MB) and growing

`src/spec/make-fallback.json` is the EU1 snapshot. Keep it under version control because dev environments need to bootstrap without network access. **But:** don't import it from anywhere except `loader.ts`. The processing pass (dereferencing + index building) is expensive enough that you don't want to do it at module-load time.

### 6.6 Plan tier vs. scope vs. IP gate — three different upstream blocks

When Make.com returns a non-2xx, surface the body verbatim and let the agent decide. Three distinct upstream gates produce different status/error-code pairs:

- **Free-plan tier limit** — `403` with no IP-gate marker. Most `/admin/*`, `/hq/*`, `/debug/*`, `/mailhub/*` paths and many write ops.
- **Higher-tier plan required** — `402 Payment Required` (e.g. `/audit-logs/*` needs Teams/Enterprise even with the right scope).
- **VPN / IP allowlist** — `403 VPN access only [IM121]` (admin endpoints from outside Make's office network, regardless of plan).

Document the observed status/code in `out/verification/` — don't try to work around it. The scope decoration we add (`(operation requires scope \`x:read\` — …)`) is metadata, not a guess; if the token has the scope and the call still 4xxs, the block is plan or IP, not auth.

### 6.7 Top-level `await` and top-level `return` are not allowed in the sandbox

QuickJS treats the executed code as module-body, not function-body. The SKILL recipe is to use an async IIFE: `(async () => { /* … */ return result; })()`. The executor unwraps the IIFE's promise. If you change the sandbox's eval flag from `'global'`, run the sandbox tests immediately — they will fail loudly.

### 6.8 Bump `CACHE_SCHEMA_VERSION` whenever you change `processSpec` / `buildOperationIndex`

The on-disk cache in `src/spec/cache/*.json` stores the *output* of `buildOperationIndex` — including `requiredScopes`, `primaryTag`, parameter shape, and synthesized `operationId`s. Anyone with a warm cache sees the old shape until the cache is invalidated. `CACHE_SCHEMA_VERSION` in `src/spec/loader.ts` is the version stamp; a mismatch causes the loader to ignore the cache and refetch upstream.

---

## 7. Code style

- TypeScript, strict, ESM. Node 20+.
- **Avoid narrative comments.** Comments explain the *why* of non-obvious decisions only — never restate what the code does.
- Prefer plain functions over classes when there's no state.
- Errors in the host that need to reach the sandbox go through `formatHttpError` / the executor's error path — preserve the `[make.<error-class>]` prefix, the model relies on it.

---

## 8. Tests live next to the system

- `src/__tests__/tenant.test.ts` — env / header builders + missing-cred paths.
- `src/__tests__/spec-loader.test.ts` — fetch-success path, fallback path, cache-hit, hash-mismatch invalidation.
- `src/__tests__/spec-index.test.ts` — operation lookup + tag normalisation against a small fixture spec.
- `src/__tests__/http-client.test.ts` — argument substitution + factory wiring.
- `src/__tests__/http-client-live.test.ts` — header shape (`Authorization: Token …`), 429 retry, scope-aware 403 formatting against a real in-process HTTP server.
- `src/__tests__/dispatch.test.ts` — `buildMakePrelude` emits expected accessors; smart-arg routing matches `param.in`.
- `src/__tests__/sandbox.test.ts` — `SearchExecutor` and `ExecuteExecutor` end-to-end with a mocked HTTP fetch.
- `src/__tests__/integration/scenarios.test.ts` — full MCP-client → server → mock-Make round-trip on both `InMemoryTransport` and Streamable HTTP transports, including the scope-aware 403 round-trip on `/admin/owners`.

When fixing a bug, write a Vitest case before the fix. The integration suite is the right place for "does this work all the way through the wire protocol" questions; the unit tests are the right place for the "does this function compute the right thing" questions.

### 8.1 Verification scope (state your work honestly)

Before claiming "this works with X", check the table in [`README.md` → Verification status](README.md#verification-status). The directly-verified surfaces are:

- 85/85 unit + integration tests (in-process MCP transport + real HTTP transport) against a mock Make.com Web API, including the `pg[limit]` bracket-notation query encoding.
- A real read-only sweep of a **Core-tier** Make.com account: 3-call `live-test` (`/users/me` + `/organizations` + `/teams`, ~220 ms) and a 12-call `discover` sweep (adds `/users/me/current-authorization`, `/admin/owners`, `/sdk/apps`, `/audit-logs/organization/{id}`, per-team `/scenarios`, `/connections`, `/data-stores`, `/hooks`, `/audit-logs/team/{id}`). Transcripts (PII redacted) at `out/verification/make-live-smoke.txt` and `out/verification/make-discover-core.txt`.
- The official MCP Inspector CLI end-to-end (`tools/list`, credentialled `search`, credentialled `execute` on `getUsersMe`, credentialled `/admin/owners` probe, and a credentialled `pg[limit]` bracket-encoding probe).
- One end-to-end LLM-mediated invocation: DeepSeek v4 Flash via `opencode-go` driving `make_search` (`spec.operations.length` → `467`) and `make_execute` (`getUsersMe` → real user record).
- The Cloudflare Workers `wrangler dev` parity smoke (boot, `/health`, `/mcp` 401 no-creds, `/mcp` 502 stub-base, 404 unknown).

Things we have **not** yet verified:

- Mutating operations against a real tenant (gated on a non-production Make.com account). Note: API calls themselves don't consume Make.com "operations" — only scenario *executions* do — but writes still mutate tenant state.
- Audit logs (`/audit-logs/*`) — the scope is granted on the Core token, but the endpoint returns `402 Payment Required` (needs Teams / Enterprise plan).
- Admin endpoints from a VPN-allowlisted environment — `/admin/owners` returns `403 VPN access only [IM121]` from outside Make's office network even with `admin:read`.
- Other zones beyond `eu1.make.com`.
- Other agent / IDE clients (Cursor, Claude Desktop, Claude Code, Continue, Cline, Aider, Zed, MCP Inspector UI).
- Long-running soak / stability under sustained load.
- A hosted multi-tenant deployment behind a reverse proxy.
- The Cloudflare Workers transport adapter (501 scaffold; routing, auth-header validation, spec loader, 404/401/502 paths *are* verified).

If you add new client coverage, update the table in the README in the same PR. Do not silently widen the "verified" surface.

---

## 9. Commit and PR conventions

- Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`).
- One logical change per commit. Keep `src/spec/cache/*` and `out/` out of commits.
- Don't bump deps in unrelated commits.

---

## 10. Roadmap (intentional, not yet implemented)

- **Mutation verification.** A self-reverting `PATCH` (or `POST`/`DELETE` round-trip) against a non-production scenario or data-store entry.
- **Multi-zone verification.** Currently only EU1 is driven; the other five zones in `KNOWN_MAKE_ZONES` should be smoke-tested.
- **Broader client validation.** Confirmed working configs for Cursor, Claude Desktop, Continue, Cline, Aider, Zed, the MCP Inspector UI, and HTTP/SSE transports.
- **Cloudflare Workers full transport.** `wrangler dev` parity smoke verified routing, auth-header validation, spec-loader, and 404/401/502 paths all work. The `worker_loaders` `LOADER` binding is now wired in (`wrangler@4` ships in `devDependencies`, `worker_loaders = [{ binding = "LOADER" }]` parses cleanly), but the 501 transport-adapter scaffold that bridges the SDK's node:http transport to Workers' Web Fetch API still needs to be written. See `cf-worker/README.md` for the open work.
- **Per-tenant rate limiting** keyed on hashed credentials (today the limiter is per-IP).
- **NPM publish** — reserved for `1.0.0`. The package is `"private": true` until then.

If you pick one up, write a short design note in `docs/` first.
