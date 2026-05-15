#!/usr/bin/env tsx
/**
 * Fetch the latest Make.com OpenAPI spec and write it to
 * `src/spec/make-fallback.json`. Run this whenever Make ships a new revision
 * or whenever you need to refresh the bundled offline fallback.
 *
 * Usage:
 *   npm run update-spec                       # default: eu1
 *   MAKE_BASE_URL=https://us2.make.com/api/v2 npm run update-spec
 */

import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { fetch as undiciFetch } from 'undici';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const baseUrl = (process.env['MAKE_BASE_URL'] ?? 'https://eu1.make.com/api/v2').replace(/\/+$/, '');
const url = `${baseUrl}/openapi.json`;

async function main(): Promise<void> {
  console.error(`[update-spec] Fetching ${url} ...`);
  const start = Date.now();
  const res = await undiciFetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    console.error(`[update-spec] HTTP ${String(res.status)} ${res.statusText}`);
    process.exit(1);
  }
  const buffer = await res.text();
  const target = resolve(__dirname, '..', 'src', 'spec', 'make-fallback.json');

  // Parse + reserialize for stable formatting.
  const parsed = JSON.parse(buffer) as Record<string, unknown>;
  await writeFile(target, JSON.stringify(parsed, null, 2) + '\n', 'utf-8');

  const info = parsed['info'] as Record<string, unknown> | undefined;
  const title = (info?.['title'] as string | undefined) ?? '?';
  const version = (info?.['version'] as string | undefined) ?? '?';
  const paths = parsed['paths'] as Record<string, unknown> | undefined;
  const pathCount = paths ? Object.keys(paths).length : 0;
  const ms = Date.now() - start;
  console.error(
    `[update-spec] Wrote ${target} (${title} v${version}, ${String(pathCount)} paths, ${String(ms)}ms)`,
  );
}

main().catch((err: unknown) => {
  console.error('[update-spec] Failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
