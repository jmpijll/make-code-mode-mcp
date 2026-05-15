import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExecuteExecutor } from '../sandbox/execute-executor.js';
import { SearchExecutor } from '../sandbox/search-executor.js';
import { buildOperationIndex } from '../spec/index-builder.js';
import { buildContextFromEnv } from '../tenant/context.js';
import type { OpenApiDocument, ProcessedSpec } from '../types/spec.js';
import type { HttpClient } from '../client/http.js';

const SPEC_DOC: OpenApiDocument = {
  openapi: '3.0.0',
  info: { title: 'Mock Make', version: '1.0' },
  paths: {
    '/scenarios': {
      get: {
        operationId: 'listScenarios',
        tags: ['Scenarios'],
        summary: 'List scenarios',
        parameters: [{ name: 'teamId', in: 'query', schema: { type: 'integer' } }],
      },
    },
    '/users/me': {
      get: {
        operationId: 'getUser',
        tags: ['Users'],
        summary: 'Current user',
      },
    },
  },
};

const SPEC: ProcessedSpec = {
  sourceUrl: 'mock://spec',
  version: '1.0',
  title: 'Mock Make',
  serverPrefix: '',
  operations: buildOperationIndex(SPEC_DOC),
  document: SPEC_DOC,
};

function makeMockClient(): HttpClient & { request: ReturnType<typeof vi.fn> } {
  const fn = vi.fn((params: unknown) => {
    void params;
    return Promise.resolve({
      status: 200,
      headers: {},
      data: { scenarios: [{ id: 1, name: 'Scenario 1' }] },
    });
  });
  return { request: fn } as unknown as HttpClient & { request: ReturnType<typeof vi.fn> };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SearchExecutor', () => {
  it('returns spec data via simple JS', async () => {
    const exec = new SearchExecutor({ spec: SPEC });
    const result = await exec.execute('spec.title');
    expect(result.ok).toBe(true);
    expect(result.data).toBe('Mock Make');
  });

  it('exposes searchOperations', async () => {
    const exec = new SearchExecutor({ spec: SPEC });
    const result = await exec.execute('searchOperations("scenario").length');
    expect(result.ok).toBe(true);
    expect(typeof result.data).toBe('number');
    expect(result.data as number).toBeGreaterThan(0);
  });

  it('returns null when no spec is loaded', async () => {
    const exec = new SearchExecutor({});
    const result = await exec.execute('spec');
    expect(result.ok).toBe(true);
    expect(result.data).toBeNull();
  });

  it('captures console.log', async () => {
    const exec = new SearchExecutor({ spec: SPEC });
    const result = await exec.execute('console.log("hello"); 42');
    expect(result.logs.some((l) => l.message.includes('hello'))).toBe(true);
  });

  it('findOperationsByPath returns matches', async () => {
    const exec = new SearchExecutor({ spec: SPEC });
    const result = await exec.execute(
      'findOperationsByPath("/users").map(function (o) { return o.operationId; })',
    );
    expect(result.ok).toBe(true);
    expect(result.data).toEqual(['getUser']);
  });
});

describe('ExecuteExecutor', () => {
  it('dispatches a typed operation call', async () => {
    const client = makeMockClient();
    const tenant = buildContextFromEnv({
      MAKE_API_KEY: 'k',
      MAKE_BASE_URL: 'https://eu1.make.com/api/v2',
    });
    const exec = new ExecuteExecutor({
      tenant,
      spec: SPEC,
      buildClient: () => client,
    });

    const code = `
      (async function() {
        var r = await make.scenarios.listScenarios({ teamId: 5 });
        return r;
      })()
    `;
    const result = await exec.execute(code);
    expect(result.ok).toBe(true);
    expect(client.request).toHaveBeenCalledWith(
      {
        method: 'GET',
        path: '/scenarios',
        pathParams: undefined,
        query: { teamId: 5 },
        body: undefined,
      },
      {},
    );
  });

  it('enforces the per-execute call budget', async () => {
    const client = makeMockClient();
    const tenant = buildContextFromEnv({
      MAKE_API_KEY: 'k',
      MAKE_BASE_URL: 'https://eu1.make.com/api/v2',
    });
    const exec = new ExecuteExecutor({
      tenant,
      spec: SPEC,
      buildClient: () => client,
      limits: { maxCallsPerExecute: 2 },
    });
    const code = `
      (async function() {
        var calls = [];
        for (var i = 0; i < 5; i++) {
          calls.push(make.scenarios.listScenarios({ teamId: 1 }));
        }
        return await Promise.all(calls);
      })()
    `;
    const result = await exec.execute(code);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/call limit exceeded/i);
  });

  it('rejects calls when credentials are missing', async () => {
    const tenant = buildContextFromEnv({});
    const exec = new ExecuteExecutor({
      tenant,
      spec: SPEC,
    });
    const code = `
      (async function() {
        return await make.scenarios.listScenarios({});
      })()
    `;
    const result = await exec.execute(code);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/missing-credentials|MissingCredentialsError/i);
  });

  it('rejects calls when spec is not loaded', async () => {
    const tenant = buildContextFromEnv({
      MAKE_API_KEY: 'k',
      MAKE_BASE_URL: 'https://eu1.make.com/api/v2',
    });
    const exec = new ExecuteExecutor({ tenant });
    const code = `
      (async function() {
        try {
          return await make.request({ method: 'GET', path: '/users/me' });
        } catch (err) {
          return 'error: ' + err.message;
        }
      })()
    `;
    const result = await exec.execute(code);
    expect(result.ok).toBe(true);
    expect(String(result.data)).toMatch(/no .*spec loaded/i);
  });

  it('honors raw request escape hatch', async () => {
    const client = makeMockClient();
    const tenant = buildContextFromEnv({
      MAKE_API_KEY: 'k',
      MAKE_BASE_URL: 'https://eu1.make.com/api/v2',
    });
    const exec = new ExecuteExecutor({
      tenant,
      spec: SPEC,
      buildClient: () => client,
    });
    const code = `
      (async function() {
        return await make.request({ method: 'GET', path: '/anything', query: { a: 1 } });
      })()
    `;
    const result = await exec.execute(code);
    expect(result.ok).toBe(true);
    expect(client.request).toHaveBeenCalledWith({
      method: 'GET',
      path: '/anything',
      query: { a: 1 },
    });
  });

  it('surfaces a structured error for an unknown operationId', async () => {
    const tenant = buildContextFromEnv({
      MAKE_API_KEY: 'k',
      MAKE_BASE_URL: 'https://eu1.make.com/api/v2',
    });
    const exec = new ExecuteExecutor({
      tenant,
      spec: SPEC,
      buildClient: () => makeMockClient(),
    });
    const code = `
      (async function() {
        try {
          return await make.callOperation('totallyMadeUp', {});
        } catch (err) {
          return String(err);
        }
      })()
    `;
    const result = await exec.execute(code);
    expect(result.ok).toBe(true);
    expect(String(result.data)).toMatch(/make\.(unknown-operation|http|error)/);
  });
});
