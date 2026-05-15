# Multi-tenant deployment

## Single-user vs multi-user

The same Node binary serves two operating modes. The decision is made by `MCP_TRANSPORT`:

| `MCP_TRANSPORT` | Mode | Credentials | Use when |
|---|---|---|---|
| `stdio` (default) | Single-user | Env vars (`MAKE_API_KEY`, `MAKE_BASE_URL`) | One operator, one zone, one workspace |
| `http` | Multi-user | Per-request HTTP headers | Hosted gateway, shared infra, multiple zones |

## HTTP transport: header contract

When `MCP_TRANSPORT=http`, the server listens on `MCP_HTTP_PORT` (default `3000`) and reads credentials from request headers:

| Header | Required | Default | Purpose |
|---|---|---|---|
| `X-Make-Api-Key` | yes | — | Make.com Web API v2 token. |
| `X-Make-Base-Url` | no | `https://eu1.make.com/api/v2` | Regional zone. |

Missing `X-Make-Api-Key` produces a structured `MissingCredentialsError` inside the sandbox the first time the user code dispatches a host call. Tool calls themselves succeed (so the model can still call `search`), but `execute` scripts that touch the wire fail loudly with an actionable message.

## Per-request scoping

Each MCP request is wrapped in a Node `AsyncLocalStorage` scope (`src/server/request-context.ts`). The `tenantResolver()` reads the ALS slot and builds a fresh `TenantContext` from headers. Two requests interleaved on the same Node process never share credentials.

## Deployment patterns

### Behind a reverse proxy (recommended)

Terminate TLS at the proxy, forward the four headers above, and run the Node host on a private interface:

```nginx
location /mcp {
  proxy_pass http://127.0.0.1:3000;
  proxy_set_header X-Make-Api-Key   $http_x_make_api_key;
  proxy_set_header X-Make-Base-Url  $http_x_make_base_url;
}
```

### Docker

```bash
docker compose up -d
```

The shipped `Dockerfile` and `docker-compose.yml` default to HTTP mode on port 3000.

### Cloudflare Workers

`cf-worker/` ships a scaffold using `@cloudflare/codemode`'s `DynamicWorkerExecutor`. As of writing, the transport adapter is a 501 scaffold; routing, auth-header validation, spec-loader, and the 401/502/404 paths are verified end-to-end with `npm run cf:dev`. See [`cf-worker/README.md`](../cf-worker/README.md).

## Security boundary

- **Credentials never enter the sandbox.** The QuickJS prelude only sees opaque `__makeCall` / `__makeRaw` host bindings. The HTTP client that holds the API key is constructed on the host side from the resolved `TenantContext`.
- **One HTTP client per request.** No client is reused across tenants; the lazy factory runs inside the request scope.
- **Per-IP rate limiting** is enabled by default in HTTP mode (see `src/server/transport.ts`). It is *not* per-tenant — if you need per-tenant limits, terminate them at the proxy.

## Operational checklist

- [ ] Set `MAKE_API_KEY` and `MAKE_BASE_URL` only when running stdio (single-user).
- [ ] In HTTP mode, do *not* set `MAKE_API_KEY` in the server's environment — credentials come from headers per request.
- [ ] Configure CORS via `MCP_HTTP_ALLOWED_ORIGINS` when serving browser clients.
- [ ] Put the server behind TLS termination. Make.com tokens are bearer credentials.
- [ ] Use `npm run live-test` from the deployment host with a low-privilege token to confirm reachability.
- [ ] Monitor `[make.http] HTTP 4xx` log lines — they hint at scope or quota issues before users complain.
