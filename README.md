<p align="center">
  <img src="docs/assets/hero.svg" alt="Make.com Code Mode MCP. Two tools. One API." width="100%">
</p>

<p align="center">
  <strong>Work with Make.com through two MCP tools.</strong><br>
  Search the Web API v2 specification and call it through one sandboxed make.* surface.
</p>

<p align="center">
  <a href="#get-started">Get started</a> ·
  <a href="#example-session">Example session</a> ·
  <a href="#know-the-boundaries">Boundaries</a> ·
  <a href="CONTRIBUTING.md">Contribute</a>
</p>

<p align="center">Node.js 22.19+ · Public beta · v0.1.0-beta.1 · MIT license</p>

[![CI](https://github.com/jmpijll/make-code-mode-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/jmpijll/make-code-mode-mcp/actions/workflows/ci.yml)

## Two tools, one API

This [Model Context Protocol](https://modelcontextprotocol.io/) server exposes `search` and `execute`.
The agent searches the API reference, then runs JavaScript inside a QuickJS WASM sandbox.
API calls go through the host; credentials remain outside the sandbox.

- **Use one namespace.** `make.*` covers the Web API v2, including scope-gated operations.
- **Search the current spec.** Live OpenAPI loading with a bundled fallback.
- **Select your region.** `MAKE_BASE_URL` chooses one zone per server.
- **Understand API failures.** Scope metadata accompanies upstream authorization errors.

## Get started

Install from source and point your MCP client at the built `dist/index.js`.

### Requirements

- Node.js **22.19.0 or newer** and npm. CI checks Node 22 and 24.
- A Make.com API token for your regional zone.

### Build from source

```bash
git clone https://github.com/jmpijll/make-code-mode-mcp.git
cd make-code-mode-mcp
npm ci
cp .env.example .env
# Edit .env: MAKE_API_KEY; MAKE_BASE_URL selects your zone.
npm run build
npm start
```

The shell examples use Bash. In PowerShell, use `Copy-Item .env.example .env` and
set variables with `$env:NAME = 'value'`.

Configure your MCP client with `node /absolute/path/to/make-code-mode-mcp/dist/index.js`.
Use an absolute path and supply credentials through the client's environment configuration
when its working directory does not contain your `.env` file.
See the [client setup and usage guide](docs/usage.md).

For hosted use, set `MCP_TRANSPORT=http` and follow the [per-request credential contract](docs/multi-tenant.md).
Docker instructions are in [docker-compose.yml](docker-compose.yml).

## Example session

After discovering the operation with the search tool, use the execute tool:

```javascript
(async () => {
  return await make.callOperation('getUsersMe', {});
})();
```

See the [usage guide](docs/usage.md) for search recipes, configuration and additional call shapes.

## Know the boundaries

| Area | Current boundary |
| --- | --- |
| API permissions | Token scopes, subscription tier and upstream IP restrictions can each block operations. |
| Live coverage | Historical read-only verification used EU1 and a Core account. Mutations and other regions remain unverified. |
| Workers | Routing/spec-loading scaffold; the MCP transport adapter returns 501. |
| Sandbox | Resource limits bound each invocation; allowed API calls still act with the supplied account's permissions. |

### Verification status

Earlier maintainer runs cover EU1 read-only calls through MCP Inspector CLI, opencode and Codex. Mocked integration coverage includes Streamable HTTP; a hosted multi-tenant deployment remains unverified.
See the [setup and verification reference](docs/usage.md#setup-and-verification-reference)
for the detailed historical evidence and remaining work. New verification reports should
identify the server revision, client, upstream version and operations actually exercised.

### Project status

Public beta · v0.1.0-beta.1. Install from source; the package remains private and is not published to npm.

## Privacy

The host sends API requests to the service configured for this server. Tool results and
captured sandbox logs are returned to your MCP client; that client may send them to its
configured model provider. Spec caches may be written locally.

Keep `.env` files and credentials private. Redact account identifiers, IP addresses and
service data before sharing logs or verification reports. See [SECURITY.md](SECURITY.md)
for vulnerability reporting.

## Development and contribution

```bash
npm run check
npm run format:check
```

`check` runs lint, typecheck, mocked tests and the build. Formatting is checked separately;
existing formatter drift is reported in PR validation. See [CONTRIBUTING.md](CONTRIBUTING.md)
for the repository layout and contribution checks, and [AGENTS.md](AGENTS.md) for
architectural invariants. Live API tests require separate credentials and verification scope.

<a id="plan-tiers--scopes"></a>

## Documentation

- [Usage and client setup](docs/usage.md)
- [Architecture](docs/architecture.md)
- [Agent operating manual](SKILL.md) and [example persona](examples/make-expert-agent/)
- [Changelog](CHANGELOG.md)

## License and acknowledgements

[MIT](LICENSE). Built with TypeScript, the MCP SDK and QuickJS, following the
[Cloudflare Code Mode pattern](https://github.com/cloudflare/mcp-server-cloudflare).
