# Changelog

All notable changes to this project will be documented in this file.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0-beta.1] — initial public beta

Initial scaffold of the Make.com code-mode MCP server. See [`README.md`](README.md)
for a status overview and [`AGENTS.md`](AGENTS.md) for the architectural invariants.

### Added

- Two MCP tools (`search` + `execute`) over a single `make.*` sandbox surface.
- QuickJS WASM sandbox for both tools — credentials never enter sandbox code.
- OpenAPI loader with `${MAKE_BASE_URL}/openapi.json` live fetch and a
  bundled fallback at `src/spec/make-fallback.json`.
- Smart-arg routing for typed operation calls — keys matching path/query
  parameters in the spec are auto-routed; remaining keys form the JSON body.
- Single-user mode via env (`MAKE_API_KEY`, `MAKE_BASE_URL`) and multi-user
  mode via per-request HTTP headers (`X-Make-Api-Key`, `X-Make-Base-Url`).
- Scope-aware error messages: 401/403 responses extract the
  `operation.security[].token[]` scope list so the model can tell the user
  which scope is missing on their token.
- Cloudflare Workers entry point (`cf-worker/`) — scaffold, not yet a
  first-class deployment target.
- Vitest test suites covering tenant context, HTTP client, OpenAPI loader,
  search index, sandbox dispatch, executors, and end-to-end MCP integration
  through both the in-memory and Streamable HTTP transports.
- Make.com bracketed query-string encoding — `pg: { limit: 25 }` is encoded
  as `pg[limit]=25` automatically, matching Make's documented API
  convention. Four new vitest cases pin the shape.
- Reusable verification redactor (`scripts/redact-transcripts.ts`) — env-
  driven scrubber for emails, gravatar hashes, user/org/team IDs, real
  names, org names, and home-directory paths. Applied to all transcripts
  in `out/verification/`.
- Broader read-only discovery sweep (`npm run discover`) — 12-call
  sandbox traversal covering `/users/me/current-authorization`, an
  `/admin/owners` probe, `/sdk/apps`, `/audit-logs/*`, per-team
  `/scenarios`, `/connections`, `/data-stores`, and `/hooks`.
- OpenAI Codex (CLI + desktop app) end-to-end verification —
  `codex-cli 0.131.0-alpha.9` and the macOS Codex desktop app (same
  build) both share `~/.codex/config.toml`, so a single
  `codex mcp add make … -- node …/dist/index.js` registers the server
  for both surfaces. Codex namespaces the tools as
  `mcp__make__search` / `mcp__make__execute`, and `gpt-5.5` drove a
  complete `search → execute → reply` round-trip against EU1 with a
  Core-tier token in both clients. CLI transcript at
  `out/verification/codex-cli-make-mcp.txt`; desktop app verified
  interactively against the same registration.

### Repo / CI

- GitHub Actions workflow runs typecheck, lint, format-check, vitest, and
  build on Node 20 and Node 22, plus a separate `wrangler deploy --dry-run`
  smoke for the Cloudflare Worker.
- Dependabot weekly updates for npm (grouped patch/minor) and GitHub
  Actions, with squash-only merges and delete-on-merge.
- Repository ruleset on `main`: required PR, required status checks
  (strict, branch must be up-to-date), required linear history, no
  force-push, no deletion. Admin role can bypass with audit log.
- Bug-report and verification-request issue templates plus a PR template
  with checklist gates (typecheck, lint, test, build, doc updates, no
  PII in transcripts).
- Documented private vulnerability reporting flow in
  [`SECURITY.md`](SECURITY.md).

### Dependencies

- TypeScript 6, vitest 4, zod 4, @types/node 25, quickjs-emscripten 0.32,
  wrangler 4.92, actions/checkout v6, actions/setup-node v6 — all bumped
  in this release. `npm audit` is clean.
- The wrangler 4 bump natively recognises the `worker_loaders` config
  and makes `env.LOADER` a real binding in the Worker scaffold.
