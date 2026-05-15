# Deployment

## Node.js (recommended)

### Local install

```bash
git clone https://github.com/jmpijll/make-code-mode-mcp.git
cd make-code-mode-mcp
npm install
cp .env.example .env
$EDITOR .env
npm run build
npm start
```

Requires Node 20+.

### Docker

```bash
docker compose up -d
```

The shipped `docker-compose.yml` runs the HTTP transport on port 3000 by default. Provide `MAKE_API_KEY` and `MAKE_BASE_URL` in `.env` for single-tenant mode, or omit them and pass credentials per-request in headers for multi-tenant mode.

### systemd

A minimal unit file:

```ini
[Unit]
Description=Make.com Code-Mode MCP
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/make-code-mode-mcp
EnvironmentFile=/opt/make-code-mode-mcp/.env
ExecStart=/usr/bin/node /opt/make-code-mode-mcp/dist/index.js
Restart=on-failure
RestartSec=5
User=make-mcp
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
ReadOnlyPaths=/opt/make-code-mode-mcp
ReadWritePaths=/opt/make-code-mode-mcp/src/spec/cache

[Install]
WantedBy=multi-user.target
```

## Cloudflare Workers (scaffold)

`cf-worker/` ships a scaffold using `@cloudflare/codemode`'s `DynamicWorkerExecutor` and `openApiMcpServer`. As of writing, the transport adapter is a 501 scaffold; routing, auth-header validation, spec loader, and the 401/502/404 paths are verified end-to-end with `npm run cf:dev`. See [`cf-worker/README.md`](../cf-worker/README.md) for the open work.

To run locally with Miniflare:

```bash
npm run cf:dev
# then in another shell
curl -s http://localhost:8788/health
curl -s -X POST http://localhost:8788/mcp -H 'X-Make-Api-Key: <token>' -d '{}'
```

To deploy (when the transport adapter is finished):

```bash
wrangler secret put DEFAULT_MAKE_API_KEY   # optional, for single-tenant
npm run cf:deploy
```

## Reverse proxy

Terminate TLS at the proxy and forward credential headers:

```nginx
location /mcp {
  proxy_pass http://127.0.0.1:3000;
  proxy_set_header X-Make-Api-Key  $http_x_make_api_key;
  proxy_set_header X-Make-Base-Url $http_x_make_base_url;
}
```

## Health and observability

- `GET /health` (HTTP transport) returns `{"status":"ok"}` for liveness probes.
- The server writes structured `INFO`/`WARN`/`ERROR` lines to stderr, prefixed with `[make-mcp]`.
- `[make.http] HTTP 4xx` lines indicate upstream errors. Watch for them, especially 401/403 (auth/scope), 429 (rate limit), and 5xx (Make.com side).

## Updating the bundled fallback spec

```bash
MAKE_BASE_URL=https://eu1.make.com/api/v2 npm run update-spec
git add src/spec/make-fallback.json && git commit -m "chore: refresh make-fallback.json"
```

The live loader always tries `${MAKE_BASE_URL}/openapi.json` first; the fallback is only consulted when the live fetch fails.
