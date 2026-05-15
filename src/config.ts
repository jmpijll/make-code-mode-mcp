/**
 * Top-level config loader. All env vars validated through Zod.
 */

import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { z } from 'zod';

function defaultCacheDir(): string {
  return resolve(homedir(), '.cache', 'make-code-mode-mcp');
}

/**
 * Known Make.com regional zone host suffixes. The base URL must point at
 * one of these — see https://developers.make.com/api-documentation for the
 * canonical list. We warn-but-don't-reject anything else so private/test
 * Make instances can still drive this server.
 */
export const KNOWN_MAKE_ZONES: readonly string[] = [
  'https://eu1.make.com/api/v2',
  'https://eu2.make.com/api/v2',
  'https://us1.make.com/api/v2',
  'https://us2.make.com/api/v2',
  'https://eu1.make.celonis.com/api/v2',
  'https://us1.make.celonis.com/api/v2',
];

export const DEFAULT_MAKE_BASE_URL = 'https://eu1.make.com/api/v2';

const configSchema = z.object({
  // Transport
  mcpTransport: z.enum(['stdio', 'http']).default('stdio'),
  mcpHttpPort: z.coerce.number().int().min(1).max(65535).default(8000),
  mcpHttpAllowedOrigins: z
    .string()
    .default('http://localhost,http://127.0.0.1')
    .transform((s) =>
      s
        .split(',')
        .map((p) => p.trim())
        .filter((p) => p.length > 0),
    ),

  // Make.com credentials
  makeBaseUrl: z.string().default(DEFAULT_MAKE_BASE_URL),
  makeApiKey: z.string().optional(),

  // Spec loading
  makeSpecUrl: z.string().optional(),
  makeSpecCacheDir: z
    .string()
    .optional()
    .transform((p) => (p && p.length > 0 ? resolve(p) : defaultCacheDir())),

  // Sandbox limits
  makeMaxCallsPerExecute: z.coerce.number().int().min(1).max(1000).default(50),
  // Wall-clock deadline for `execute` invocations (milliseconds). Make's
  // per-minute rate limits are forgiving on read but tight on write; long
  // sweeps may legitimately want a longer budget. Hard-capped at 10 minutes.
  makeExecuteTimeoutMs: z.coerce.number().int().min(1000).max(600_000).default(30_000),
});

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = configSchema.safeParse({
    mcpTransport: env['MCP_TRANSPORT'],
    mcpHttpPort: env['MCP_HTTP_PORT'],
    mcpHttpAllowedOrigins: env['MCP_HTTP_ALLOWED_ORIGINS'],

    makeBaseUrl: env['MAKE_BASE_URL'],
    makeApiKey: env['MAKE_API_KEY'],

    makeSpecUrl: env['MAKE_SPEC_URL'],
    makeSpecCacheDir: env['MAKE_SPEC_CACHE_DIR'],

    makeMaxCallsPerExecute: env['MAKE_MAX_CALLS_PER_EXECUTE'],
    makeExecuteTimeoutMs: env['MAKE_EXECUTE_TIMEOUT_MS'],
  });

  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Configuration validation failed:\n${issues}`);
  }
  return result.data;
}

/**
 * Returns true if the given base URL is one of the known Make zones. Used
 * for a startup warning when the operator points at something we don't
 * recognise (could be a typo, a private instance, or a new zone).
 */
export function isKnownMakeZone(baseUrl: string): boolean {
  const normalised = baseUrl.trim().replace(/\/+$/, '');
  return KNOWN_MAKE_ZONES.some((z) => z === normalised);
}
