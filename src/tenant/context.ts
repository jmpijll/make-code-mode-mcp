/**
 * TenantContext — per-request credentials for the Make.com Web API v2.
 *
 * The same code paths handle:
 *   - Single-user mode: context built from environment variables once at startup.
 *   - Multi-user mode: context built from HTTP request headers on each request.
 *
 * Credentials NEVER enter the QuickJS sandbox. The host-side dispatch handler
 * receives the TenantContext and uses it to authorize outbound HTTPS calls.
 */

import { DEFAULT_MAKE_BASE_URL } from '../config.js';

// ─── Types ──────────────────────────────────────────────────────────

export interface MakeCreds {
  /** Base URL of a Make.com zone, e.g. https://eu1.make.com/api/v2 (no trailing slash). */
  baseUrl: string;
  /** API token minted in Make.com → Profile → API/MCP access. Sent as `Authorization: Token <key>`. */
  apiKey: string;
}

export interface TenantContext {
  make?: MakeCreds;
  /** A short id used in logs; not security-sensitive. */
  requestId: string;
  /** Whether this context was assembled from HTTP headers (true) or env vars (false). */
  fromHeaders: boolean;
}

// ─── Errors ─────────────────────────────────────────────────────────

export class MissingCredentialsError extends Error {
  override readonly name = 'MissingCredentialsError';
  constructor(detail?: string) {
    super(
      'No Make.com credentials configured. ' +
        'Provide MAKE_API_KEY via env (single-user) ' +
        'or X-Make-Api-Key + X-Make-Base-Url headers (multi-user).' +
        (detail ? ` (${detail})` : ''),
    );
  }
}

// ─── Header constants ───────────────────────────────────────────────

export const HEADER_API_KEY = 'x-make-api-key';
export const HEADER_BASE_URL = 'x-make-base-url';

// ─── Builders ───────────────────────────────────────────────────────

export interface EnvCreds {
  MAKE_API_KEY?: string;
  MAKE_BASE_URL?: string;
}

/** Build a TenantContext from process.env. */
export function buildContextFromEnv(env: EnvCreds = process.env): TenantContext {
  const ctx: TenantContext = {
    requestId: randomId(),
    fromHeaders: false,
  };

  const make = readFromEnv(env);
  if (make) ctx.make = make;

  return ctx;
}

/**
 * Build a TenantContext from a Node IncomingMessage's headers, falling back
 * to env vars when headers are absent. If `X-Make-Api-Key` is present, the
 * header set wins; the base URL falls back to `X-Make-Base-Url`, then the
 * env `MAKE_BASE_URL`, then the default zone.
 */
export function buildContextFromHeaders(
  headers: Record<string, string | string[] | undefined>,
  fallbackEnv: EnvCreds = process.env,
): TenantContext {
  const get = (name: string): string | undefined => {
    const raw = headers[name.toLowerCase()];
    if (raw === undefined) return undefined;
    if (Array.isArray(raw)) return raw[0];
    return raw;
  };

  const ctx: TenantContext = {
    requestId: randomId(),
    fromHeaders: true,
  };

  const headerApiKey = get(HEADER_API_KEY);
  const headerBaseUrl = get(HEADER_BASE_URL);
  if (headerApiKey) {
    const baseUrl = headerBaseUrl ?? fallbackEnv.MAKE_BASE_URL ?? DEFAULT_MAKE_BASE_URL;
    ctx.make = {
      baseUrl: normalizeBaseUrl(baseUrl),
      apiKey: headerApiKey,
    };
  } else {
    const fromEnv = readFromEnv(fallbackEnv);
    if (fromEnv) ctx.make = fromEnv;
  }

  return ctx;
}

// ─── Helpers ────────────────────────────────────────────────────────

function readFromEnv(env: EnvCreds): MakeCreds | undefined {
  const apiKey = env.MAKE_API_KEY;
  if (!apiKey) return undefined;
  const baseUrl = env.MAKE_BASE_URL ?? DEFAULT_MAKE_BASE_URL;
  return {
    apiKey,
    baseUrl: normalizeBaseUrl(baseUrl),
  };
}

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}
