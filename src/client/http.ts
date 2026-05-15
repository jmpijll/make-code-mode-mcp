/**
 * Make.com HTTP client — wraps undici's fetch with auth + retry + error
 * normalisation.
 *
 * Handles:
 *   - Path-parameter substitution
 *   - Query string serialization
 *   - JSON encoding
 *   - `Authorization: Token <api-key>` header
 *   - 429 Retry-After honoring (single retry)
 *   - Error normalization to MakeHttpError / MakeTransportError
 *   - Optional `requiredScopes` carried on 401/403 errors so the agent can
 *     tell the user which scope is missing on their token.
 *
 * Note: Make.com is public cloud only, so TLS verification is always strict.
 * There is no `caCert` / `insecure` knob on this client.
 */

import { fetch as undiciFetch, type RequestInit } from 'undici';
import {
  MakeHttpError,
  MakeTransportError,
  type HttpMethod,
  type MakeQueryLeaf,
  type MakeQueryValue,
  type MakeRequestParams,
  type MakeResponse,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RETRIES_429 = 1;

export interface HttpClientConfig {
  /** Full origin + base path, e.g. `https://eu1.make.com/api/v2`. No trailing slash. */
  baseUrl: string;
  /** Path prefix added between baseUrl and operation paths. For Make.com, "" (the /api/v2 is part of baseUrl). */
  pathPrefix: string;
  /** API token for the `Authorization: Token <...>` header. */
  apiKey: string;
  /** Per-request timeout (ms). */
  timeoutMs?: number;
  /** A descriptive label for log messages. */
  label?: string;
  /** Optional warn handler — used to surface degraded-mode warnings (rate limit retries, etc.). */
  onWarn?: (msg: string) => void;
}

export interface RequestExtras {
  /**
   * Operation security requirements, if known. Each element is the set of
   * required scope names for one acceptable scheme (logical OR across
   * elements, logical AND within an element). Used to enrich 401/403
   * errors with the scope list the operation expected.
   */
  requiredScopes?: string[][];
}

export class HttpClient {
  private readonly timeoutMs: number;

  constructor(public readonly config: HttpClientConfig) {
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async request<T = unknown>(
    params: MakeRequestParams,
    extras: RequestExtras = {},
  ): Promise<MakeResponse<T>> {
    const method = (params.method ?? 'GET').toUpperCase() as HttpMethod;
    const url = this.buildUrl(params);
    return this.send<T>(url, method, params, extras);
  }

  // ─── Internals ────────────────────────────────────────────────────

  private buildUrl(params: MakeRequestParams): string {
    const pathWithParams = substitutePathParams(params.path, params.pathParams);
    const qs = buildQueryString(params.query);
    const fullPath = `${this.config.pathPrefix}${pathWithParams}`;
    const safe = fullPath.startsWith('/') ? fullPath : `/${fullPath}`;
    return `${this.config.baseUrl}${safe}${qs}`;
  }

  private async send<T>(
    url: string,
    method: HttpMethod,
    params: MakeRequestParams,
    extras: RequestExtras,
    attempt = 0,
  ): Promise<MakeResponse<T>> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Token ${this.config.apiKey}`,
      ...(params.headers ?? {}),
    };

    let body: string | undefined;
    if (params.body !== undefined && method !== 'GET' && method !== 'HEAD') {
      body = JSON.stringify(params.body);
      headers['Content-Type'] ??= 'application/json';
    }

    const init: RequestInit = {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
      signal: AbortSignal.timeout(this.timeoutMs),
    };

    let res: Awaited<ReturnType<typeof undiciFetch>>;
    try {
      res = await undiciFetch(url, init);
    } catch (err) {
      const isTimeout = err instanceof DOMException && err.name === 'TimeoutError';
      throw new MakeTransportError(
        isTimeout
          ? `Request to ${url} timed out after ${String(this.timeoutMs)}ms`
          : `Network error calling ${url}: ${err instanceof Error ? err.message : String(err)}`,
        params.path,
        err,
      );
    }

    if (res.status === 429 && attempt < MAX_RETRIES_429) {
      const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
      if (retryAfter !== undefined) {
        this.config.onWarn?.(
          `[${this.config.label ?? 'make'}] 429 from ${params.path}; retrying after ${String(retryAfter)}ms`,
        );
        await sleep(retryAfter);
        return this.send<T>(url, method, params, extras, attempt + 1);
      }
    }

    const responseHeaders: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    const ct = res.headers.get('content-type') ?? '';
    let data: unknown;
    if (ct.includes('application/json')) {
      try {
        data = await res.json();
      } catch {
        data = undefined;
      }
    } else if (res.status === 204) {
      data = undefined;
    } else {
      data = await res.text().catch(() => undefined);
    }

    if (!res.ok) {
      const requiredScopes = extras.requiredScopes
        ? flattenScopes(extras.requiredScopes)
        : undefined;
      throw new MakeHttpError(
        formatHttpError(res.status, params.path, data, requiredScopes),
        res.status,
        params.path,
        data,
        requiredScopes,
      );
    }

    return { status: res.status, headers: responseHeaders, data: data as T };
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

export function substitutePathParams(
  path: string,
  params: Record<string, string | number | boolean> | undefined,
): string {
  if (!params) return path;
  return path.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = params[name];
    if (value === undefined) {
      throw new Error(`Missing path parameter "${name}" for ${path}`);
    }
    return encodeURIComponent(String(value));
  });
}

export function buildQueryString(query: MakeQueryValue | undefined): string {
  if (!query) return '';
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    appendQueryValue(sp, key, value);
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

function appendQueryValue(
  sp: URLSearchParams,
  key: string,
  value: MakeQueryLeaf | Record<string, MakeQueryLeaf>,
): void {
  if (value === undefined) return;
  if (Array.isArray(value)) {
    // Repeat the key for each item. `cols[]`-style suffix is part of the
    // caller-supplied key — we don't synthesize it.
    for (const item of value) sp.append(key, String(item));
    return;
  }
  if (typeof value === 'object') {
    // One-level bracket nesting, e.g. `pg: { limit: 25 }` → `pg[limit]=25`.
    for (const [subKey, subValue] of Object.entries(value)) {
      if (subValue === undefined) continue;
      if (Array.isArray(subValue)) {
        for (const item of subValue) sp.append(`${key}[${subKey}]`, String(item));
      } else {
        sp.append(`${key}[${subKey}]`, String(subValue));
      }
    }
    return;
  }
  sp.append(key, String(value));
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function flattenScopes(requiredScopes: string[][]): string[] {
  // Deduplicate while preserving order — useful for display.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const set of requiredScopes) {
    for (const s of set) {
      if (!seen.has(s)) {
        seen.add(s);
        out.push(s);
      }
    }
  }
  return out;
}

function formatHttpError(
  status: number,
  path: string,
  body: unknown,
  requiredScopes: string[] | undefined,
): string {
  let detail = '';
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    const msg = b['message'];
    const code = b['code'] ?? b['detail'];
    const subErrors = b['subErrors'];
    if (typeof msg === 'string') detail = `: ${msg}`;
    if (typeof code === 'string') detail += ` [${code}]`;
    if (Array.isArray(subErrors) && subErrors.length > 0) {
      const first: unknown = subErrors[0];
      if (typeof first === 'object' && first !== null) {
        const m = (first as Record<string, unknown>)['message'];
        if (typeof m === 'string') detail += ` — ${m}`;
      }
    }
  } else if (typeof body === 'string' && body.length < 500) {
    detail = `: ${body}`;
  }
  let scopeHint = '';
  if ((status === 401 || status === 403) && requiredScopes && requiredScopes.length > 0) {
    scopeHint = ` (operation requires scope${requiredScopes.length > 1 ? 's' : ''} ${requiredScopes
      .map((s) => `\`${s}\``)
      .join(', ')} — check your Make.com API token has them)`;
  }
  return `HTTP ${String(status)} on ${path}${detail}${scopeHint}`;
}
