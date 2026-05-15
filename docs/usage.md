# Usage

## Install

```bash
git clone https://github.com/jmpijll/make-code-mode-mcp.git
cd make-code-mode-mcp
npm install      # uses --legacy-peer-deps via .npmrc
npm run build
```

## Configure

```bash
cp .env.example .env
$EDITOR .env
```

| Variable | Required | Default | Notes |
|---|---|---|---|
| `MAKE_API_KEY` | yes (single-user) | — | Make.com Web API v2 token. Mint one at `https://<zone>.make.com/profile/api`. |
| `MAKE_BASE_URL` | no | `https://eu1.make.com/api/v2` | Regional zone base URL. Known zones: `eu1`, `eu2`, `us1`, `us2`, plus two Celonis variants. Unknown URLs emit a startup warning but otherwise work. |
| `MCP_TRANSPORT` | no | `stdio` | Set to `http` for multi-user. |
| `MCP_HTTP_PORT` | no | `3000` | Listen port when `MCP_TRANSPORT=http`. |
| `MCP_HTTP_ALLOWED_ORIGINS` | no | (none) | Comma-separated CORS allow-list. |
| `MAKE_SPEC_URL` | no | `${MAKE_BASE_URL}/openapi.json` | Override the spec endpoint. |
| `MAKE_SPEC_CACHE_DIR` | no | `src/spec/cache` | Hash-keyed on-disk spec cache. |
| `MAKE_MAX_CALLS_PER_EXECUTE` | no | `25` | Per-`execute` call budget. |
| `MAKE_EXECUTE_TIMEOUT_MS` | no | `30000` | Per-`execute` wall-clock timeout. |

## Run

### Single-user (stdio)

```bash
npm start
```

Point your MCP client at `node /path/to/make-code-mode-mcp/dist/index.js`.

### Multi-user (HTTP)

```bash
MCP_TRANSPORT=http npm start
```

Then `POST /mcp` with credentials in headers:

```http
POST /mcp HTTP/1.1
Content-Type: application/json
X-Make-Api-Key: <your token>
X-Make-Base-Url: https://eu1.make.com/api/v2

{ "jsonrpc": "2.0", "method": "tools/list", "id": 1 }
```

See [`multi-tenant.md`](multi-tenant.md).

## The two tools

### `search`

Read-only sandbox over the OpenAPI spec. Globals: `spec`, `searchOperations(query, limit?)`, `getOperation(operationIdOrLocator)`, `findOperationsByPath(substring)`, `console.log(...)`. No network access. Final expression is the tool result.

### `execute`

Live sandbox with the `make` namespace bound:

```js
make.spec                                  // { title, version, sourceUrl, operationCount }
make.callOperation(operationId, args)      // typed call by operationId
make.request({ method, path, query, body, headers, pathParams })
make.<tag>.<operationId>(args)             // tag-grouped accessor sugar
```

Host calls are async — wrap your code in an async IIFE so the executor can unwrap the resulting Promise:

```js
(async () => {
  const me = await make.callOperation('getUsersMe', {});
  return { id: me.authUser.id, email: me.authUser.email };
})();
```

See [`SKILL.md`](../SKILL.md) for the full operating manual.

## Operational scripts

```bash
npm run update-spec        # refresh src/spec/make-fallback.json from MAKE_BASE_URL
npm run live-test          # read-only sweep: /users/me + /organizations + /teams
npm run discover           # broader sweep: orgs → teams → scenarios; writes JSON to out/
```

`live-test` and `discover` resolve `MAKE_API_KEY` from the environment first, then fall back to 1Password (`op read 'op://AI Agents/Make.com API Key Full Access/password'` by default; override via `OP_MAKE_REF`).

## Common gotchas

- **Three distinct upstream gates** can produce 4xx responses: plan tier (`402 Payment Required` for endpoints that need Teams/Enterprise), token scope (`403` with scope hint in the error), and IP allowlist (`403 VPN access only [IM121]` for `/admin/*` from outside Make's VPN). Read the status + code before claiming a scope problem. See SKILL §11.
- **One zone per server.** Register multiple MCP entries to talk to multiple zones from one client.
- **Top-level `await` and `return` are not allowed.** Use an async IIFE: `(async () => { … })()`.
- **Don't invent operationIds.** Always confirm with `search` first — the spec changes per zone and per release.
