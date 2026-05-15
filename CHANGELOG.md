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
