/**
 * Build the lightweight operations index from a resolved OpenAPI document.
 *
 * The index is the data structure exposed to the `search` tool inside the
 * sandbox. It must stay small and JSON-serializable.
 */

import type {
  HttpMethod,
  IndexedOperation,
  OpenApiDocument,
  OperationObject,
  ParameterObject,
  PathItemObject,
  SchemaObject,
  SecurityRequirement,
} from '../types/spec.js';

const HTTP_METHODS: HttpMethod[] = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

const MAX_DESCRIPTION_LENGTH = 500;

export function buildOperationIndex(spec: OpenApiDocument): IndexedOperation[] {
  const operations: IndexedOperation[] = [];
  const globalSecurity = spec.security;

  for (const [path, item] of Object.entries(spec.paths)) {
    if (typeof item !== 'object') continue;
    const pathItem = item;
    const pathLevelParams = pathItem.parameters ?? [];

    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op) continue;

      operations.push(buildOperation(method, path, op, pathLevelParams, pathItem, globalSecurity));
    }
  }

  // Sort: tag, then path, then method — produces stable, scannable output.
  operations.sort(
    (a, b) =>
      a.primaryTag.localeCompare(b.primaryTag) ||
      a.path.localeCompare(b.path) ||
      a.method.localeCompare(b.method),
  );

  return operations;
}

function buildOperation(
  method: HttpMethod,
  path: string,
  op: OperationObject,
  pathLevelParams: ParameterObject[],
  _pathItem: PathItemObject,
  globalSecurity: SecurityRequirement[] | undefined,
): IndexedOperation {
  const tags = op.tags ?? [];
  const primaryTag = normalizeTag(tags[0] ?? 'default');
  const operationId = op.operationId ?? synthesizeOperationId(method, path);
  const summary = op.summary ?? '';
  const description = (op.description ?? '').slice(0, MAX_DESCRIPTION_LENGTH);

  const allParams: ParameterObject[] = [...pathLevelParams, ...(op.parameters ?? [])];

  const parameters = allParams.map((p) => ({
    name: p.name,
    in: p.in,
    required: p.required ?? p.in === 'path',
    description: p.description,
    type: extractType(p.schema),
  }));

  // OpenAPI semantics: an empty security array on an operation EXPLICITLY
  // disables the global requirement; absent (`undefined`) means "inherit
  // global". Make's spec uses the latter form throughout.
  const opSecurity: SecurityRequirement[] | undefined = op.security ?? globalSecurity;
  const requiredScopes = opSecurity ? extractScopes(opSecurity) : undefined;

  const result: IndexedOperation = {
    operationId,
    primaryTag,
    tags: tags.slice(),
    method: method.toUpperCase(),
    path,
    summary,
    description,
    parameters,
    hasRequestBody: Boolean(op.requestBody),
    deprecated: Boolean(op.deprecated),
  };
  if (requiredScopes && requiredScopes.length > 0) {
    result.requiredScopes = requiredScopes;
  }
  return result;
}

/**
 * Flatten an OpenAPI security requirement array into a per-scheme list of
 * scope arrays. Empty inner arrays (auth-required-but-no-scope, e.g. plain
 * API key) collapse to a single empty entry — we still surface "auth
 * required" via the 401 error message even if no scope is named.
 */
function extractScopes(security: SecurityRequirement[]): string[][] {
  const out: string[][] = [];
  for (const requirement of security) {
    for (const scopes of Object.values(requirement)) {
      if (Array.isArray(scopes) && scopes.length > 0) {
        out.push([...scopes]);
      }
    }
  }
  return out;
}

function extractType(schema: SchemaObject | undefined): string | undefined {
  if (!schema) return undefined;
  const t = schema['type'];
  if (typeof t === 'string') return t;
  if (Array.isArray(t)) return t.join('|');
  return undefined;
}

/**
 * Lower-camelCase the tag so `Scenarios` → `scenarios`, `Data stores` → `dataStores`.
 *
 * Also compacts a few common boilerplate phrases that show up in API-doc
 * tag names:
 *   - "SDK Apps / Modules"   → "sdkAppsModules"  (slashes treated as spaces)
 *   - "Audit logs"           → "auditLogs"
 *   - "On-prem agents"       → "onPremAgents"
 *
 * Novel multi-word tags pass through unchanged.
 */
export function normalizeTag(tag: string): string {
  const compact = compactTagPhrase(tag);
  const cleaned = compact
    .trim()
    .replace(/[/]/g, ' ')
    .replace(/[^a-zA-Z0-9 _-]/g, '')
    .replace(/[_-]+/g, ' ');
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'default';
  const [first, ...rest] = parts;
  if (first === undefined) return 'default';
  return [
    first.toLowerCase(),
    ...rest.map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()),
  ].join('');
}

/**
 * Strip the most common API-doc boilerplate that shows up in tag names.
 * Pure phrase-level normalisation — no camelCasing here.
 *
 * Exposed for unit tests; not part of the public API.
 */
export function compactTagPhrase(tag: string): string {
  let s = tag.trim();
  if (s.length === 0) return s;

  const paren = s.match(/^([^()]+?)\s*\(([^)]+)\)\s*$/);
  if (paren?.[2]) {
    s = paren[2].trim();
  }

  return s;
}

/**
 * Synthesize a stable, REST-friendly operationId for specs that don't supply one.
 *
 * Heuristics, in order:
 *   1. Drop a /v\d+ version prefix.
 *   2. Collection root  /resource              → list/create/update/delete<Resource[s]>
 *   3. Single resource  /resource/{id}         → get/update/delete<Resource> (singular)
 *   4. Action endpoint  /resource/{id}/<verb…> → get<Resource><Action> for GET,
 *                                                <resource><Action> for POST
 *                                                update/delete<Resource><Action> for others
 *   5. No params, multi-segment (/v1/meta/info) → get/create/update/delete<JoinedSegments>
 *   6. Fallback: legacy `<method><camelCasedPath>` form.
 */
export function synthesizeOperationId(method: string, path: string): string {
  const m = method.toLowerCase();

  const segments = path.split('/').filter(Boolean);
  if (segments[0] && /^v\d+$/i.test(segments[0])) {
    segments.shift();
  }

  if (segments.length === 0) {
    return m === 'get' ? 'getRoot' : `${m}Root`;
  }

  type Seg = { type: 'resource' | 'param'; name: string };
  const parts: Seg[] = segments.map((s) =>
    /^\{.*\}$/.test(s)
      ? { type: 'param' as const, name: s.slice(1, -1) }
      : { type: 'resource' as const, name: s },
  );

  const last = parts[parts.length - 1];
  if (!last) {
    return m === 'get' ? 'getRoot' : `${m}Root`;
  }

  // Case 2: /resource (collection root)
  if (parts.length === 1 && last.type === 'resource') {
    const collection = pascalSegment(last.name);
    if (m === 'get') return `list${collection}`;
    if (m === 'post') return `create${pascalSegment(singularize(last.name))}`;
    if (m === 'delete') return `delete${collection}`;
    if (m === 'patch' || m === 'put') return `update${collection}`;
  }

  // Case 3: /resource/{id} (path ends in single param, all preceding are resources)
  const isSingularResource =
    parts.length >= 2 &&
    last.type === 'param' &&
    parts.slice(0, -1).every((p) => p.type === 'resource');
  if (isSingularResource) {
    const resourceParts = parts.slice(0, -1).map((p) => p.name);
    const lastResource = resourceParts[resourceParts.length - 1];
    if (lastResource !== undefined) {
      const prefix = resourceParts.slice(0, -1).map(pascalSegment).join('');
      const target = `${prefix}${pascalSegment(singularize(lastResource))}`;
      if (m === 'get') return `get${target}`;
      if (m === 'patch' || m === 'put') return `update${target}`;
      if (m === 'delete') return `delete${target}`;
      if (m === 'post') return `create${target}`;
    }
  }

  // Case 4: action endpoint — at least one path param somewhere in the path,
  // with resource segments both before and after that first param.
  const firstParamIdx = parts.findIndex((p) => p.type === 'param');
  if (firstParamIdx > 0) {
    const entityResources = parts
      .slice(0, firstParamIdx)
      .filter((p) => p.type === 'resource')
      .map((p) => p.name);
    const trailingResources = parts
      .slice(firstParamIdx + 1)
      .filter((p) => p.type === 'resource')
      .map((p) => p.name);

    if (entityResources.length > 0 && trailingResources.length > 0) {
      const entityWord = entityResources
        .map((n, i) => (i === entityResources.length - 1 ? singularize(n) : n))
        .map(pascalSegment)
        .join('');
      const actionWord = trailingResources.map(pascalSegment).join('');
      if (m === 'get') return `get${entityWord}${actionWord}`;
      if (m === 'post') return `${lowerFirstChar(entityWord)}${actionWord}`;
      if (m === 'patch' || m === 'put') return `update${entityWord}${actionWord}`;
      if (m === 'delete') return `delete${entityWord}${actionWord}`;
    }
  }

  // Case 5: no params at all, multi-segment.
  if (parts.every((p) => p.type === 'resource')) {
    const joined = parts.map((p) => pascalSegment(p.name)).join('');
    if (m === 'get') return `get${joined}`;
    if (m === 'post') return `create${joined}`;
    if (m === 'patch' || m === 'put') return `update${joined}`;
    if (m === 'delete') return `delete${joined}`;
  }

  // Case 6: anything weirder.
  const cleanPath = path
    .replace(/[{}]/g, '')
    .split('/')
    .filter(Boolean)
    .map((seg) => seg.replace(/[^a-zA-Z0-9]+/g, ''))
    .map((seg, i) => (i === 0 ? seg : seg.charAt(0).toUpperCase() + seg.slice(1)))
    .join('');
  return `${m}${cleanPath.charAt(0).toUpperCase()}${cleanPath.slice(1)}`;
}

/** "data-stores" / "ai_agents" / "scenarios" → "DataStores" / "AiAgents" / "Scenarios" */
function pascalSegment(s: string): string {
  return s
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join('');
}

function lowerFirstChar(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toLowerCase() + s.slice(1);
}

/** Naive English singularizer tuned for the Make domain (scenarios→scenario, etc.). */
function singularize(s: string): string {
  if (s.length <= 2) return s;
  const lower = s.toLowerCase();
  if (lower.endsWith('ies')) return s.slice(0, -3) + 'y';
  if (lower.endsWith('ses') && !lower.endsWith('sses')) return s.slice(0, -2);
  if (lower.endsWith('s') && !lower.endsWith('ss') && !lower.endsWith('us')) {
    return s.slice(0, -1);
  }
  return s;
}
