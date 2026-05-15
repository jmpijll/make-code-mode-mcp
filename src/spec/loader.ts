/**
 * OpenAPI spec loader for the Make.com Web API v2.
 *
 * Loading order:
 *   1. opts.specUrlOverride (full URL — highest priority).
 *   2. `${baseUrl}/openapi.json` — live fetch from the configured zone.
 *   3. The bundled curated snapshot at `src/spec/make-fallback.json`
 *      (offline fallback, refreshed by `npm run update-spec`).
 *
 * The processed result is $ref-resolved and cached:
 *   - In-memory by content hash for the lifetime of the process.
 *   - On disk under `cacheDir/make-<hash>.json` for cross-process reuse.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dereference } from '@apidevtools/json-schema-ref-parser';
import { fetch as undiciFetch } from 'undici';
import { buildOperationIndex } from './index-builder.js';
import type { OpenApiDocument, ProcessedSpec } from '../types/spec.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Resolves to `src/spec/make-fallback.json` regardless of dev vs dist layout. */
export const MAKE_FALLBACK_PATH = resolve(__dirname, 'make-fallback.json');

// ─── Cache keys ─────────────────────────────────────────────────────

const memoryCache = new Map<string, ProcessedSpec>();

function cacheFilePath(cacheDir: string, hash: string): string {
  return resolve(cacheDir, `make-${hash}.json`);
}

// ─── Public API ─────────────────────────────────────────────────────

export interface LoadMakeSpecOptions {
  /** Make.com zone base URL, e.g. `https://eu1.make.com/api/v2`. */
  baseUrl: string;
  /** Override the OpenAPI URL — bypasses the `${baseUrl}/openapi.json` default. */
  specUrlOverride?: string;
  /** Where to cache fetched specs on disk. */
  cacheDir: string;
  /** Force re-fetch from network even if cache exists. */
  forceRefresh?: boolean;
  /** Optional callback for non-fatal load warnings (spec fallbacks, etc.). */
  onWarn?: (msg: string) => void;
}

/**
 * Fetch and cache the Make.com OpenAPI spec.
 *
 * Errors here are usually fatal at startup in single-user mode but should be
 * tolerated in multi-tenant mode (the bundled fallback keeps the server
 * useful even when Make's zone is unreachable).
 */
export async function loadMakeSpec(opts: LoadMakeSpecOptions): Promise<ProcessedSpec> {
  await mkdir(opts.cacheDir, { recursive: true });
  const onWarn = opts.onWarn ?? ((): void => undefined);

  const url = opts.specUrlOverride ?? `${opts.baseUrl.replace(/\/+$/, '')}/openapi.json`;

  // Try the live URL first.
  let document: OpenApiDocument | undefined;
  let sourceUrl: string = url;
  try {
    document = await fetchSpec(url);
  } catch (err) {
    onWarn(
      `Failed to fetch Make.com spec from ${url}: ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        'Falling back to bundled snapshot.',
    );
    try {
      document = await readFallbackSpec();
      sourceUrl = `embedded:make-fallback.json`;
    } catch (fallbackErr) {
      throw new Error(
        `Could not load Make.com OpenAPI spec from ${url} or bundled fallback: ` +
          (fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)),
      );
    }
  }

  // Hash-keyed cache lookup.
  const hash = hashDocument(document);
  if (!opts.forceRefresh) {
    const cached = memoryCache.get(hash);
    if (cached) return cached;

    const onDisk = await readCacheFile(cacheFilePath(opts.cacheDir, hash));
    if (onDisk) {
      memoryCache.set(hash, onDisk);
      return onDisk;
    }
  }

  const processed = await processSpec({
    document,
    sourceUrl,
    version: document.info.version ?? 'unknown',
    title: document.info.title?.trim() || 'Make.com Web API v2',
  });

  memoryCache.set(hash, processed);
  await writeCacheFile(cacheFilePath(opts.cacheDir, hash), processed);
  return processed;
}

/** Drop all cached specs (forces re-fetch on next access). */
export function clearSpecCache(): void {
  memoryCache.clear();
}

// ─── Internals ──────────────────────────────────────────────────────

async function fetchSpec(url: string): Promise<OpenApiDocument> {
  const res = await undiciFetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const err = new Error(`Failed to fetch OpenAPI from ${url}: HTTP ${String(res.status)}`);
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }
  const body = (await res.json()) as OpenApiDocument;
  if (typeof body !== 'object' || typeof body.paths !== 'object') {
    throw new Error(`Invalid OpenAPI document at ${url} — missing paths`);
  }
  return body;
}

interface ProcessSpecArgs {
  document: OpenApiDocument;
  sourceUrl: string;
  version: string;
  title: string;
}

async function processSpec(args: ProcessSpecArgs): Promise<ProcessedSpec> {
  // Resolve $refs in-place. json-schema-ref-parser handles internal + external refs.
  const resolved = (await dereference(
    args.document as unknown as Parameters<typeof dereference>[0],
  )) as unknown as OpenApiDocument;

  // For Make.com, all operation paths are relative to a base URL (e.g.
  // https://eu1.make.com/api/v2). The /api/v2 prefix is part of the
  // configured baseUrl, so we don't apply an additional serverPrefix.
  const serverPrefix = '';

  const operations = buildOperationIndex(resolved);

  return {
    sourceUrl: args.sourceUrl,
    version: args.version,
    title: args.title,
    serverPrefix,
    operations,
    document: resolved,
  };
}

function hashDocument(document: OpenApiDocument): string {
  // Sort-stable JSON so equivalent specs hash to the same key. We only use
  // this as a cache key, not for cryptographic purposes, so the simple
  // JSON.stringify path is sufficient.
  const h = createHash('sha256');
  h.update(JSON.stringify(document));
  return h.digest('hex').slice(0, 16);
}

/**
 * Bump this whenever the shape produced by `buildOperationIndex` or
 * `processSpec` changes in a way that would make stale on-disk caches
 * misleading. A mismatch causes `readCacheFile` to ignore the cache
 * and refetch upstream.
 *
 * History:
 *   v1 — initial cache schema (2026-05-15)
 */
const CACHE_SCHEMA_VERSION = 1;

interface CacheEnvelope extends ProcessedSpec {
  cacheSchemaVersion?: number;
}

async function readCacheFile(path: string): Promise<ProcessedSpec | undefined> {
  if (!existsSync(path)) return undefined;
  try {
    const raw = await readFile(path, 'utf-8');
    const parsed = JSON.parse(raw) as CacheEnvelope;
    if (parsed.cacheSchemaVersion !== CACHE_SCHEMA_VERSION) {
      return undefined;
    }
    const { cacheSchemaVersion: _v, ...spec } = parsed;
    return spec;
  } catch {
    return undefined;
  }
}

async function writeCacheFile(path: string, spec: ProcessedSpec): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const envelope: CacheEnvelope = { ...spec, cacheSchemaVersion: CACHE_SCHEMA_VERSION };
  await writeFile(path, JSON.stringify(envelope), 'utf-8');
}

async function readFallbackSpec(): Promise<OpenApiDocument> {
  const raw = await readFile(MAKE_FALLBACK_PATH, 'utf-8');
  return JSON.parse(raw) as OpenApiDocument;
}
