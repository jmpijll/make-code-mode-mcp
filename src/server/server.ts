/**
 * MCP Server — Make.com Code Mode
 *
 * Registers two tools:
 *   - search   — query the OpenAPI spec via sandboxed JS (no network)
 *   - execute  — run Make.com API calls via sandboxed JS
 *
 * Each tool call resolves a TenantContext (env in single-user mode, headers
 * in multi-user mode), constructs a fresh ExecuteExecutor for that request,
 * runs the code, and returns formatted MCP tool content.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ExecuteExecutor } from '../sandbox/execute-executor.js';
import { SearchExecutor } from '../sandbox/search-executor.js';
import { MAX_CODE_SIZE, MAX_RESULT_SIZE, type SandboxLimits } from '../sandbox/limits.js';
import type { ExecuteResult } from '../sandbox/types.js';
import type { ProcessedSpec } from '../types/spec.js';
import type { TenantContext } from '../tenant/context.js';

// ─── Tool descriptions ──────────────────────────────────────────────

const SEARCH_TOOL_DESCRIPTION = `Search the Make.com Web API v2 OpenAPI spec by writing JavaScript.

The sandbox is read-only — no network. Use this tool to **discover** what to call before invoking \`execute\`.

## Globals

- \`spec\` — \`{ title, version, sourceUrl, serverPrefix, operations[] }\`
  Operations are compact: \`{ operationId, method, path, tag, summary, parameters, hasRequestBody, deprecated, requiredScopes? }\`.
  \`spec\` may be \`null\` if no spec is loaded.
- \`searchOperations(query, limit?)\` — text-ranked search.
- \`getOperation(operationId)\` — full operation including spec parameter detail. Pass either an \`operationId\` or \`"METHOD /path"\`.
- \`findOperationsByPath(substring)\` — list operations whose path contains the substring (case-insensitive).
- \`console.log()\` — captured into the tool output.

## Examples

\`\`\`javascript
// All operations tagged "scenarios"
spec.operations.filter(function (op) { return op.tag === 'scenarios'; });
\`\`\`

\`\`\`javascript
// Top 10 hits for "data store"
searchOperations('data store', 10);
\`\`\`

\`\`\`javascript
// Full detail on listScenarios
getOperation('listScenarios');
\`\`\`
`;

const EXECUTE_TOOL_DESCRIPTION = `Run Make.com API calls by writing JavaScript that uses the \`make\` namespace.

Surface:

- \`make.<tag>.<operationId>(args)\` — typed operation call, e.g. \`make.scenarios.listScenarios({ teamId: 1, pg: { limit: 50 } })\`. Args are auto-routed: keys matching path or query params from the spec are placed correctly; remaining keys form the JSON body if the operation accepts one. To override, pass \`{ pathParams: {...}, query: {...}, body: {...}, headers: {...} }\`.
- \`make.callOperation(operationId, args)\` — flat lookup by id.
- \`make.request({ method, path, pathParams?, query?, body?, headers? })\` — raw HTTP escape hatch.
- \`make.spec\` — \`{ title, version, sourceUrl, operationCount }\` for diagnostics.

Operations are async — use \`await\`. The final expression is the tool result.

## Examples

\`\`\`javascript
const me = await make.callOperation('getUser', {});
return me.data;
\`\`\`

\`\`\`javascript
const orgs = await make.callOperation('getOrganizations', {});
return orgs.organizations.map(function (o) { return { id: o.id, name: o.name }; });
\`\`\`

\`\`\`javascript
// Raw escape hatch — call an endpoint not present in the spec
const r = await make.request({ method: 'GET', path: '/users/me' });
return r;
\`\`\`

## Errors

Errors are prefixed with a structured tag:

- \`[make.http] HTTP 403 on /scenarios: ... (operation requires scope \\\`scenarios:read\\\` — check your Make.com API token has it)\`
- \`[make.missing-credentials] ...\` when no API key is configured
- \`[make.unknown-operation] ...\` when the operationId doesn't exist in the spec
- \`[make.error] ...\` for everything else

## Limits

- Hard ceiling on API calls per execute; exceeded → error.
- Sandbox memory + time bounded.
- Credentials never enter the sandbox.
- The free Make.com plan only includes "Limited" API access — paid plans unlock full /api/v2. Admin/internal endpoints will 403 on most tokens.
`;

// ─── Server factory ─────────────────────────────────────────────────

export interface CreateServerOptions {
  /** Loaded OpenAPI spec, or undefined if not yet loaded. */
  spec?: ProcessedSpec;
  /** Function called per request to obtain the TenantContext. */
  tenantResolver: () => TenantContext | Promise<TenantContext>;
  /** Sandbox limits override. */
  limits?: Partial<SandboxLimits>;
  /** Logger for tool-call audit trail. */
  logger?: {
    info: (msg: string, ...args: unknown[]) => void;
    warn: (msg: string, ...args: unknown[]) => void;
  };
  /** Server name + version for the MCP handshake. */
  name?: string;
  version?: string;
}

export function createMcpServer(options: CreateServerOptions): McpServer {
  const {
    spec,
    tenantResolver,
    limits,
    logger,
    name = 'make-code-mode-mcp',
    version = '0.1.0',
  } = options;

  const server = new McpServer(
    { name, version },
    {
      capabilities: { tools: {} },
      instructions: [
        'Make.com Code Mode MCP Server.',
        spec
          ? `make: ${spec.title} v${spec.version} — ${String(spec.operations.length)} operations`
          : 'make: NOT CONFIGURED — set MAKE_API_KEY (and optionally MAKE_BASE_URL) or send X-Make-* headers.',
        '',
        'Workflow: use `search` to find the operationIds you need, then call them via `execute`.',
        'Operations are gated by token scopes — 403 errors will name the required scope.',
      ].join('\n'),
    },
  );

  // ── Search tool ─────────────────────────────────────────────────

  const searchExecutor = new SearchExecutor({
    ...(spec ? { spec } : {}),
  });

  server.registerTool(
    'search',
    {
      title: 'Search Make.com API spec',
      description: SEARCH_TOOL_DESCRIPTION,
      inputSchema: {
        code: z
          .string()
          .describe(
            'JavaScript code to execute against the OpenAPI spec. The final expression is returned.',
          ),
      },
    },
    async ({ code }) => {
      logger?.info(`[search] ${String(code.length)} chars`);
      if (code.length > MAX_CODE_SIZE) {
        return errorResult(
          `Code too large (${String(code.length)} chars, max ${String(MAX_CODE_SIZE)}).`,
        );
      }
      try {
        const result = await searchExecutor.execute(code);
        logger?.info(`[search] ${result.ok ? 'ok' : 'error'} ${String(result.durationMs)}ms`);
        return formatToolResult(result);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // ── Execute tool ────────────────────────────────────────────────

  server.registerTool(
    'execute',
    {
      title: 'Execute Make.com API calls',
      description: EXECUTE_TOOL_DESCRIPTION,
      inputSchema: {
        code: z
          .string()
          .describe(
            'JavaScript code to execute against the live Make.com API. Use await — operations are async.',
          ),
      },
    },
    async ({ code }) => {
      logger?.info(`[execute] ${String(code.length)} chars`);
      if (code.length > MAX_CODE_SIZE) {
        return errorResult(
          `Code too large (${String(code.length)} chars, max ${String(MAX_CODE_SIZE)}).`,
        );
      }

      let tenant: TenantContext;
      try {
        tenant = await tenantResolver();
      } catch (err) {
        return errorResult(
          `Failed to resolve tenant credentials: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const executor = new ExecuteExecutor({
        tenant,
        ...(spec ? { spec } : {}),
        ...(limits ? { limits } : {}),
      });

      try {
        const result = await executor.execute(code);
        logger?.info(
          `[execute][${tenant.requestId}] ${result.ok ? 'ok' : 'error'} ${String(result.durationMs)}ms ${String(result.callsMade ?? 0)} calls`,
        );
        return formatToolResult(result);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  return server;
}

// ─── Result formatting ──────────────────────────────────────────────

function errorResult(message: string): {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
} {
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
  };
}

function formatToolResult(result: ExecuteResult): {
  content: Array<{ type: 'text'; text: string }>;
  isError: boolean;
} {
  const parts: Array<{ type: 'text'; text: string }> = [];

  if (result.warnings.length > 0) {
    parts.push({
      type: 'text',
      text: `--- Warnings ---\n${result.warnings.map((w) => `[warn] ${w}`).join('\n')}`,
    });
  }

  if (result.logs.length > 0) {
    parts.push({
      type: 'text',
      text: `--- Console Output ---\n${result.logs.map((l) => `[${l.level}] ${l.message}`).join('\n')}`,
    });
  }

  if (result.ok) {
    let dataStr =
      result.data !== undefined
        ? typeof result.data === 'string'
          ? result.data
          : JSON.stringify(result.data, null, 2)
        : '(no return value)';
    if (dataStr.length > MAX_RESULT_SIZE) {
      const total = dataStr.length;
      dataStr =
        dataStr.slice(0, MAX_RESULT_SIZE) +
        `\n\n--- TRUNCATED (${String(total)} chars total, showing first ${String(MAX_RESULT_SIZE)}) ---` +
        '\nTip: filter, paginate, or select specific fields to reduce size.';
    }
    parts.push({ type: 'text', text: dataStr });
  } else {
    parts.push({ type: 'text', text: `Error: ${result.error ?? 'Unknown error'}` });
  }

  const meta = [`--- Executed in ${String(result.durationMs)}ms`];
  if (typeof result.callsMade === 'number' && result.callsMade > 0) {
    meta.push(`${String(result.callsMade)} API calls`);
  }
  parts.push({ type: 'text', text: `${meta.join(' · ')} ---` });

  return {
    content: parts,
    isError: !result.ok,
  };
}
