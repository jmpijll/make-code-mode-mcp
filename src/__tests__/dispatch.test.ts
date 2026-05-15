import { describe, expect, it, vi } from 'vitest';
import {
  buildMakePrelude,
  dispatchOperation,
  dispatchRawRequest,
  sanitizeIdentifier,
  UnknownOperationError,
} from '../sandbox/dispatch.js';
import { buildOperationIndex } from '../spec/index-builder.js';
import type { OpenApiDocument, ProcessedSpec } from '../types/spec.js';
import type { HttpClient } from '../client/http.js';

function makeMockClient(): HttpClient & { request: ReturnType<typeof vi.fn> } {
  const fn = vi.fn((params: unknown, extras?: unknown) =>
    Promise.resolve({ status: 200, headers: {}, data: { ok: true, params, extras } }),
  );
  return { request: fn } as unknown as HttpClient & { request: ReturnType<typeof vi.fn> };
}

const SPEC_DOC: OpenApiDocument = {
  openapi: '3.0.0',
  info: { title: 'Mock', version: '1.0' },
  paths: {
    '/scenarios/{scenarioId}': {
      get: {
        operationId: 'getScenario',
        tags: ['Scenarios'],
        summary: 'Get a scenario',
        parameters: [
          { name: 'scenarioId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'cols', in: 'query', schema: { type: 'string' } },
        ],
        security: [{ token: ['scenarios:read'] }],
      },
    },
    '/scenarios/{scenarioId}/clone': {
      post: {
        operationId: 'cloneScenario',
        tags: ['Scenarios'],
        summary: 'Clone a scenario',
        parameters: [
          { name: 'scenarioId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: { required: true, content: { 'application/json': {} } },
      },
    },
  },
};

const SPEC: ProcessedSpec = {
  sourceUrl: 'mock://spec',
  version: '1.0',
  title: 'Mock',
  serverPrefix: '',
  operations: buildOperationIndex(SPEC_DOC),
  document: SPEC_DOC,
};

describe('dispatchOperation', () => {
  it('throws UnknownOperationError for missing op', async () => {
    const client = makeMockClient();
    await expect(dispatchOperation(client, SPEC, 'noSuch', {})).rejects.toBeInstanceOf(
      UnknownOperationError,
    );
  });

  it('auto-routes path and query args by spec', async () => {
    const client = makeMockClient();
    await dispatchOperation(client, SPEC, 'getScenario', {
      scenarioId: 'abc',
      cols: 'name,id',
    });
    expect(client.request).toHaveBeenCalledWith(
      {
        method: 'GET',
        path: '/scenarios/{scenarioId}',
        pathParams: { scenarioId: 'abc' },
        query: { cols: 'name,id' },
        body: undefined,
      },
      { requiredScopes: [['scenarios:read']] },
    );
  });

  it('treats non-spec keys as the body when op accepts a body', async () => {
    const client = makeMockClient();
    await dispatchOperation(client, SPEC, 'cloneScenario', {
      scenarioId: 'abc',
      name: 'clone1',
      teamId: 4,
    });
    expect(client.request).toHaveBeenCalledWith(
      {
        method: 'POST',
        path: '/scenarios/{scenarioId}/clone',
        pathParams: { scenarioId: 'abc' },
        query: undefined,
        body: { name: 'clone1', teamId: 4 },
      },
      {},
    );
  });

  it('merges convenience path params with an explicit body', async () => {
    const client = makeMockClient();
    await dispatchOperation(client, SPEC, 'cloneScenario', {
      scenarioId: 'abc',
      body: { name: 'clone1', teamId: 4 },
    });
    expect(client.request).toHaveBeenCalledWith(
      {
        method: 'POST',
        path: '/scenarios/{scenarioId}/clone',
        pathParams: { scenarioId: 'abc' },
        query: undefined,
        body: { name: 'clone1', teamId: 4 },
      },
      {},
    );
  });

  it('passes through explicit query and headers verbatim', async () => {
    const client = makeMockClient();
    await dispatchOperation(client, SPEC, 'getScenario', {
      scenarioId: 'abc',
      query: { cols: 'all' },
      headers: { 'X-Custom': 'value' },
    });
    expect(client.request).toHaveBeenCalledWith(
      {
        method: 'GET',
        path: '/scenarios/{scenarioId}',
        pathParams: { scenarioId: 'abc' },
        query: { cols: 'all' },
        body: undefined,
        headers: { 'X-Custom': 'value' },
      },
      { requiredScopes: [['scenarios:read']] },
    );
  });
});

describe('dispatchRawRequest', () => {
  it('rejects missing path', async () => {
    const client = makeMockClient();
    await expect(
      dispatchRawRequest(client, { path: undefined as unknown as string }),
    ).rejects.toThrow(/string `path`/);
  });

  it('passes args through to client.request', async () => {
    const client = makeMockClient();
    await dispatchRawRequest(client, { method: 'GET', path: '/users/me' });
    expect(client.request).toHaveBeenCalledWith({ method: 'GET', path: '/users/me' });
  });
});

// Use new Function(...) to evaluate the generated sandbox prelude in V8 — the
// real sandbox uses QuickJS WASM, but for unit tests this is sufficient.
/* eslint-disable @typescript-eslint/no-implied-eval, @typescript-eslint/no-non-null-assertion */
describe('buildMakePrelude', () => {
  it('builds tag-grouped methods', () => {
    const prelude = buildMakePrelude(SPEC);
    expect(prelude).toContain('var make');
    expect(prelude).toContain('ns.scenarios');
    expect(prelude).toContain('ns.scenarios.getScenario');
    expect(prelude).toContain('ns.scenarios.cloneScenario');
    expect(prelude).toContain('__makeCall');
    expect(prelude).toContain('__makeRaw');
  });

  it('produces a syntactically valid script', () => {
    const prelude = buildMakePrelude(SPEC);
    expect(() => new Function(prelude)).not.toThrow();
  });

  it('typed accessors route to __makeCall with the operationId', () => {
    const prelude = buildMakePrelude(SPEC);
    const calls: Array<{ opId: string; argsJson: string }> = [];
    const fn = new Function('__makeCall', '__makeRaw', `${prelude}\nreturn make;`) as (
      ...args: unknown[]
    ) => Record<string, unknown>;

    const make = fn(
      (opId: string, argsJson: string) => {
        calls.push({ opId, argsJson });
        return { ok: true };
      },
      () => undefined,
    );

    const scenarios = make['scenarios'] as Record<string, (args: unknown) => unknown>;
    scenarios['getScenario']({ scenarioId: 'abc' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ opId: 'getScenario' });
    const parsed = JSON.parse(calls[0]!.argsJson) as Record<string, unknown>;
    expect(parsed['scenarioId']).toBe('abc');
  });

  it('make.request routes to __makeRaw', () => {
    const prelude = buildMakePrelude(SPEC);
    const calls: string[] = [];
    const fn = new Function('__makeCall', '__makeRaw', `${prelude}\nreturn make;`) as (
      ...args: unknown[]
    ) => Record<string, unknown>;
    const make = fn(
      () => undefined,
      (argsJson: string) => {
        calls.push(argsJson);
        return { ok: true };
      },
    );
    (make['request'] as (args: unknown) => unknown)({ method: 'GET', path: '/users/me' });
    expect(calls).toHaveLength(1);
    const parsed = JSON.parse(calls[0]!) as Record<string, unknown>;
    expect(parsed['path']).toBe('/users/me');
  });

  it('exposes a spec summary object', () => {
    const prelude = buildMakePrelude(SPEC);
    const fn = new Function('__makeCall', '__makeRaw', `${prelude}\nreturn make.spec;`) as (
      ...args: unknown[]
    ) => Record<string, unknown>;
    const specObj = fn(
      () => undefined,
      () => undefined,
    );
    expect(specObj['title']).toBe('Mock');
    expect(specObj['version']).toBe('1.0');
    expect(specObj['operationCount']).toBe(2);
  });
});
/* eslint-enable @typescript-eslint/no-implied-eval, @typescript-eslint/no-non-null-assertion */

describe('sanitizeIdentifier', () => {
  it('replaces non-identifier chars', () => {
    expect(sanitizeIdentifier('foo-bar.baz')).toBe('foo_bar_baz');
  });
  it('prefixes digits', () => {
    expect(sanitizeIdentifier('1foo')).toBe('_1foo');
  });
  it('escapes reserved words', () => {
    expect(sanitizeIdentifier('class')).toBe('class_');
    expect(sanitizeIdentifier('return')).toBe('return_');
  });
});
