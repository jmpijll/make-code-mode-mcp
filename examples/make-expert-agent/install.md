# Install snippets — Make.com expert agent

How to wire the `make-code-mode-mcp` server into common MCP clients. Each entry is marked **VERIFIED** (we drove it end-to-end against a real Make.com tenant), **HANDSHAKE-VERIFIED** (the client connects but we didn't drive an LLM call), or **NOT-VERIFIED** (untested).

Replace `/abs/path/to/make-code-mode-mcp` with the absolute clone path on your machine. Replace `<token>` with a Make.com Web API v2 token minted at `https://eu1.make.com/profile/api`.

Build first:

```bash
git clone https://github.com/jmpijll/make-code-mode-mcp.git
cd make-code-mode-mcp
npm install
npm run build
```

## opencode (`--pure run`) — **VERIFIED**

Project-scoped at the repo root or your project, file `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "make": {
      "type": "local",
      "command": ["node", "/abs/path/to/make-code-mode-mcp/dist/index.js"],
      "enabled": true,
      "environment": {
        "MAKE_API_KEY": "{env:MAKE_API_KEY}",
        "MAKE_BASE_URL": "{env:MAKE_BASE_URL}"
      }
    }
  },
  "permission": {
    "make_*": "allow"
  }
}
```

Then:

```bash
export MAKE_API_KEY=<token>
export MAKE_BASE_URL=https://eu1.make.com/api/v2
opencode run --pure --model opencode-go/deepseek-v4-flash \
  "Use make_search to find getUsersMe, then make_execute to fetch /users/me. Report only the JSON the tool returned."
```

opencode auto-injects the MCP tools as `make_search` / `make_execute`. Run with `--pure` to avoid the bundled `plugin.copilot` Zod-validation hang in opencode 1.14.30.

## MCP Inspector CLI — **VERIFIED**

```bash
export MAKE_API_KEY=<token>
npx @modelcontextprotocol/inspector@0.20.0 --cli node /abs/path/to/make-code-mode-mcp/dist/index.js --method tools/list
npx @modelcontextprotocol/inspector@0.20.0 --cli node /abs/path/to/make-code-mode-mcp/dist/index.js --method tools/call --tool-name search --tool-arg "code=findOperationsByPath('/users/me')"
npx @modelcontextprotocol/inspector@0.20.0 --cli node /abs/path/to/make-code-mode-mcp/dist/index.js --method tools/call --tool-name execute --tool-arg 'code=(async () => { const me = await make.callOperation("getUsersMe", {}); return me.authUser.email; })()'
```

Pin Inspector at v0.20.0 — v0.21.x has an upstream missing-`commander` dep on newer Node versions.

## Cursor IDE / Cursor CLI — **NOT-VERIFIED**

Project-scoped at `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "make": {
      "command": "node",
      "args": ["/abs/path/to/make-code-mode-mcp/dist/index.js"],
      "env": {
        "MAKE_API_KEY": "<token>",
        "MAKE_BASE_URL": "https://eu1.make.com/api/v2"
      }
    }
  }
}
```

Restart Cursor after editing. As of writing, Cursor IDE chat tool-injection has not been validated end-to-end against this server.

## Claude Desktop — **NOT-VERIFIED**

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "make": {
      "command": "node",
      "args": ["/abs/path/to/make-code-mode-mcp/dist/index.js"],
      "env": {
        "MAKE_API_KEY": "<token>"
      }
    }
  }
}
```

Restart Claude Desktop. Untested.

## Claude Code CLI — **NOT-VERIFIED**

```bash
claude mcp add make --transport stdio \
  -e MAKE_API_KEY=<token> \
  -e MAKE_BASE_URL=https://eu1.make.com/api/v2 \
  -- node /abs/path/to/make-code-mode-mcp/dist/index.js
claude mcp list
claude mcp get make
```

The handshake should report `✓ Connected`. End-to-end LLM-driven invocation requires `ANTHROPIC_API_KEY`; not yet verified.

## VS Code + GitHub Copilot — **NOT-VERIFIED**

VS Code 1.89+ with Copilot Chat reads `.vscode/mcp.json`:

```json
{
  "servers": {
    "make": {
      "type": "stdio",
      "command": "node",
      "args": ["/abs/path/to/make-code-mode-mcp/dist/index.js"],
      "env": {
        "MAKE_API_KEY": "<token>"
      }
    }
  }
}
```

Untested.

## Codex CLI — **NOT-VERIFIED**

In `~/.codex/config.toml`:

```toml
[mcp_servers.make]
command = "node"
args = ["/abs/path/to/make-code-mode-mcp/dist/index.js"]

[mcp_servers.make.env]
MAKE_API_KEY = "<token>"
```

Untested.

## Continue — **NOT-VERIFIED**

`.continue/config.yaml`:

```yaml
mcpServers:
  - name: make
    command: node
    args:
      - /abs/path/to/make-code-mode-mcp/dist/index.js
    env:
      MAKE_API_KEY: <token>
```

Untested.

## Cline — **NOT-VERIFIED**

`~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`:

```json
{
  "mcpServers": {
    "make": {
      "command": "node",
      "args": ["/abs/path/to/make-code-mode-mcp/dist/index.js"],
      "env": {
        "MAKE_API_KEY": "<token>"
      }
    }
  }
}
```

Untested.

## Streamable HTTP transport (multi-tenant)

Run the server in HTTP mode:

```bash
cd /abs/path/to/make-code-mode-mcp
MCP_TRANSPORT=http MCP_HTTP_PORT=3000 npm start
```

Then any MCP client that supports the Streamable HTTP transport can connect:

```http
POST /mcp HTTP/1.1
Host: localhost:3000
Content-Type: application/json
X-Make-Api-Key: <token>
X-Make-Base-Url: https://eu1.make.com/api/v2

{ "jsonrpc": "2.0", "method": "tools/list", "id": 1 }
```

This is the recommended deployment for shared / multi-tenant use. See [`docs/multi-tenant.md`](../../docs/multi-tenant.md).

## Reporting verification

Tested a client? Open an issue at `https://github.com/jmpijll/make-code-mode-mcp/issues` with:

- Client name + version.
- The exact config snippet you used.
- One sample prompt and the result.
- Any error messages or workarounds.

Both successes and failures help future testers.
