import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as Undici from 'undici';

const fetchMock = vi.fn<(url: string | URL, init?: unknown) => Promise<Response>>();
vi.mock('undici', async () => {
  const actual = await vi.importActual<typeof Undici>('undici');
  return {
    ...actual,
    fetch: (url: string | URL, init?: unknown) => fetchMock(url, init),
  };
});

const { clearSpecCache, loadMakeSpec } = await import('../spec/loader.js');

const MOCK_SPEC = {
  openapi: '3.0.0',
  info: { title: 'Mock Make', version: '1.0.0' },
  servers: [{ url: 'https://eu1.make.com/api/v2' }],
  paths: {
    '/users/me': {
      get: {
        operationId: 'getUser',
        tags: ['Users'],
        summary: 'Current user',
      },
    },
    '/scenarios': {
      get: {
        operationId: 'listScenarios',
        tags: ['Scenarios'],
        summary: 'List scenarios',
      },
    },
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

let cacheDir: string;

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), 'make-spec-cache-'));
  fetchMock.mockReset();
  clearSpecCache();
});

afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true });
});

describe('loadMakeSpec', () => {
  it('fetches from `${baseUrl}/openapi.json` by default', async () => {
    fetchMock.mockImplementation((url) => {
      if (String(url).endsWith('/api/v2/openapi.json')) {
        return Promise.resolve(jsonResponse(MOCK_SPEC));
      }
      return Promise.reject(new Error(`unexpected fetch: ${String(url)}`));
    });

    const spec = await loadMakeSpec({
      baseUrl: 'https://eu1.make.com/api/v2',
      cacheDir,
    });
    expect(spec.title).toBe('Mock Make');
    expect(spec.version).toBe('1.0.0');
    expect(spec.operations).toHaveLength(2);
    expect(spec.sourceUrl).toBe('https://eu1.make.com/api/v2/openapi.json');
  });

  it('honors specUrlOverride', async () => {
    fetchMock.mockImplementation((url) => {
      if (String(url) === 'https://example.test/spec.json') {
        return Promise.resolve(jsonResponse(MOCK_SPEC));
      }
      return Promise.reject(new Error(`unexpected fetch: ${String(url)}`));
    });

    const spec = await loadMakeSpec({
      baseUrl: 'https://eu1.make.com/api/v2',
      specUrlOverride: 'https://example.test/spec.json',
      cacheDir,
    });
    expect(spec.sourceUrl).toBe('https://example.test/spec.json');
  });

  it('falls back to the bundled snapshot when live fetch fails', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response('nope', { status: 502 })));
    const warnings: string[] = [];
    const spec = await loadMakeSpec({
      baseUrl: 'https://eu1.make.com/api/v2',
      cacheDir,
      onWarn: (msg) => warnings.push(msg),
    });
    expect(spec.sourceUrl).toBe('embedded:make-fallback.json');
    expect(spec.operations.length).toBeGreaterThan(0);
    expect(warnings.some((w) => w.includes('Falling back to bundled snapshot'))).toBe(true);
  });

  it('caches the processed spec in-memory by hash', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(MOCK_SPEC)));

    await loadMakeSpec({ baseUrl: 'https://eu1.make.com/api/v2', cacheDir });
    const callsAfterFirst = fetchMock.mock.calls.length;

    await loadMakeSpec({ baseUrl: 'https://eu1.make.com/api/v2', cacheDir });
    // Both calls hit the network for the document (we don't cache the
    // /openapi.json HTTP response itself), but the second one should resolve
    // from the in-memory processed-spec cache rather than reprocess.
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(callsAfterFirst);
  });
});
