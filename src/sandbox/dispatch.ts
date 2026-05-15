/**
 * Host-side dispatch — turns sandbox calls into real HTTP requests.
 *
 * Two entry points:
 *   - dispatchOperation(): named operation lookup (the LLM calls
 *     `make.scenarios.listScenarios({...})` which becomes a call here).
 *   - dispatchRawRequest(): the LLM calls `make.request({...})`.
 *
 * Smart argument routing for dispatchOperation():
 *   - If args has any of {pathParams, query, body, headers}, those are
 *     used as-is and other keys are still auto-routed for path/query
 *     placeholders that match spec parameters.
 *   - Args keys matching the operation's spec parameters are auto-routed
 *     to pathParams or query based on `param.in`. Remaining keys form
 *     the body (if the operation accepts one and no explicit body was given).
 */

import type { HttpClient } from '../client/http.js';
import { findOperation } from '../spec/index.js';
import type { IndexedOperation, ProcessedSpec } from '../types/spec.js';
import type { HttpMethod, MakeRequestParams, MakeResponse } from '../client/types.js';

export interface DispatchOperationArgs {
  [key: string]: unknown;
  pathParams?: Record<string, string | number | boolean>;
  query?: Record<string, string | number | boolean | string[] | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
}

export class UnknownOperationError extends Error {
  override readonly name = 'UnknownOperationError';
  constructor(public readonly operationId: string) {
    super(`No operation "${operationId}" in Make.com spec`);
  }
}

export async function dispatchOperation(
  client: HttpClient,
  spec: ProcessedSpec,
  operationId: string,
  args: DispatchOperationArgs = {},
): Promise<MakeResponse> {
  const op = findOperation(spec, operationId);
  if (!op) throw new UnknownOperationError(operationId);

  const params = routeArgsToRequest(op, args);
  return client.request(params, {
    ...(op.requiredScopes ? { requiredScopes: op.requiredScopes } : {}),
  });
}

export async function dispatchRawRequest(
  client: HttpClient,
  args: MakeRequestParams,
): Promise<MakeResponse> {
  if (typeof args !== 'object' || typeof args.path !== 'string') {
    throw new Error(
      'request() argument must be an object with at least a string `path` field. ' +
        'Example: make.request({ method: "GET", path: "/users/me" })',
    );
  }
  return client.request(args);
}

function routeArgsToRequest(op: IndexedOperation, args: DispatchOperationArgs): MakeRequestParams {
  const pathParams: Record<string, string | number | boolean> = {
    ...(args.pathParams ?? {}),
  };
  const query: Record<string, string | number | boolean | string[] | undefined> = {
    ...(args.query ?? {}),
  };
  const headers = args.headers;
  let body: unknown = args.body;

  const remaining: Record<string, unknown> = { ...args };
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
  delete remaining['pathParams'];
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
  delete remaining['query'];
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
  delete remaining['body'];
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
  delete remaining['headers'];

  for (const param of op.parameters) {
    if (param.in !== 'path' && param.in !== 'query') continue;
    if (!(param.name in remaining)) continue;
    const value = remaining[param.name];
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete remaining[param.name];
    if (value === undefined) continue;
    if (param.in === 'path') {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        pathParams[param.name] = value;
      }
    } else {
      if (
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean' ||
        Array.isArray(value)
      ) {
        query[param.name] = value as string | number | boolean | string[];
      }
    }
  }

  if (body === undefined && op.hasRequestBody) {
    const remainingKeys = Object.keys(remaining);
    if (remainingKeys.length > 0) body = remaining;
  }

  const result: MakeRequestParams = {
    method: op.method as HttpMethod,
    path: op.path,
    pathParams: Object.keys(pathParams).length > 0 ? pathParams : undefined,
    query: Object.keys(query).length > 0 ? query : undefined,
    body,
  };
  if (headers !== undefined) result.headers = headers;
  return result;
}

/**
 * Build a JS prelude that creates the `make` namespace at sandbox init time.
 *
 * Output shape:
 *   make.<tag>.<operationId>(args) -> Promise           // typed call
 *   make.callOperation(operationId, args) -> Promise    // flat lookup
 *   make.request({ method, path, ... }) -> Promise      // raw escape hatch
 *   make.spec -> { title, version, sourceUrl, operationCount }
 *
 * The functions delegate to host-side bindings injected separately:
 *   __makeCall(opId, argsJson)
 *   __makeRaw(argsJson)
 */
export function buildMakePrelude(spec: ProcessedSpec): string {
  const lines: string[] = [];
  lines.push('var make = (function() {');
  lines.push('  var ns = {');
  lines.push(
    `    spec: ${JSON.stringify({
      title: spec.title,
      version: spec.version,
      sourceUrl: spec.sourceUrl,
      operationCount: spec.operations.length,
    })},`,
  );
  lines.push('    request: function(args) { return __makeRaw(JSON.stringify(args || {})); },');
  lines.push(
    '    callOperation: function(opId, args) { return __makeCall(opId, JSON.stringify(args || {})); }',
  );
  lines.push('  };');

  const groups = new Map<string, IndexedOperation[]>();
  for (const op of spec.operations) {
    const key = op.primaryTag || 'default';
    const arr = groups.get(key) ?? [];
    arr.push(op);
    groups.set(key, arr);
  }

  // Reserved property names on `ns` that we must not stomp on with a tag.
  const reserved = new Set(['spec', 'request', 'callOperation']);

  for (const [tag, ops] of groups) {
    let safeTag = sanitizeIdentifier(tag);
    if (reserved.has(safeTag)) {
      // Some Make tags are literally "Request" or similar; bump them so we
      // don't shadow the raw request helper.
      safeTag = `${safeTag}_`;
    }
    lines.push(`  ns.${safeTag} = {};`);
    for (const op of ops) {
      const methodName = sanitizeIdentifier(op.operationId);
      lines.push(
        `  ns.${safeTag}.${methodName} = function(args) { return __makeCall(${JSON.stringify(op.operationId)}, JSON.stringify(args || {})); };`,
      );
    }
  }

  lines.push('  return ns;');
  lines.push('})();');

  return lines.join('\n');
}

const RESERVED_WORDS = new Set([
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'import',
  'in',
  'instanceof',
  'new',
  'null',
  'return',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
  'let',
  'static',
]);

export function sanitizeIdentifier(input: string): string {
  let out = input.replace(/[^a-zA-Z0-9_$]/g, '_');
  if (out.length === 0 || /^[0-9]/.test(out)) out = `_${out}`;
  if (RESERVED_WORDS.has(out)) out = `${out}_`;
  return out;
}
