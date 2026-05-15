import { describe, expect, it } from 'vitest';
import {
  buildOperationIndex,
  compactTagPhrase,
  normalizeTag,
  synthesizeOperationId,
} from '../spec/index-builder.js';
import { findOperation, searchOperations, summarizeOperation } from '../spec/index.js';
import type { OpenApiDocument, ProcessedSpec } from '../types/spec.js';

const MOCK_SPEC: OpenApiDocument = {
  openapi: '3.0.0',
  info: { title: 'Mock Make', version: '1.0.0' },
  security: [{ token: [] }],
  paths: {
    '/scenarios': {
      get: {
        operationId: 'listScenarios',
        tags: ['Scenarios'],
        summary: 'List scenarios',
        parameters: [
          { name: 'teamId', in: 'query', schema: { type: 'integer' } },
          { name: 'pg[limit]', in: 'query', schema: { type: 'integer' } },
        ],
        security: [{ token: ['scenarios:read'] }],
      },
      post: {
        operationId: 'createScenario',
        tags: ['Scenarios'],
        summary: 'Create a scenario',
        requestBody: { required: true, content: { 'application/json': {} } },
        security: [{ token: ['scenarios:write'] }],
      },
    },
    '/scenarios/{scenarioId}': {
      get: {
        operationId: 'getScenario',
        tags: ['Scenarios'],
        summary: 'Get a scenario',
        parameters: [
          { name: 'scenarioId', in: 'path', required: true, schema: { type: 'integer' } },
        ],
      },
    },
    '/data-stores': {
      get: {
        // operationId omitted on purpose to test synthesis
        tags: ['Data stores'],
        summary: 'List data stores',
      },
    },
  },
};

const buildProcessed = (): ProcessedSpec => ({
  sourceUrl: 'mock://spec',
  version: '1.0.0',
  title: 'Mock Make',
  serverPrefix: '',
  operations: buildOperationIndex(MOCK_SPEC),
  document: MOCK_SPEC,
});

describe('buildOperationIndex', () => {
  it('flattens paths into operations', () => {
    const ops = buildOperationIndex(MOCK_SPEC);
    expect(ops).toHaveLength(4);
    const ids = ops.map((o) => o.operationId);
    expect(ids).toContain('listScenarios');
    expect(ids).toContain('createScenario');
    expect(ids).toContain('getScenario');
  });

  it('synthesizes operationId when missing', () => {
    const ops = buildOperationIndex(MOCK_SPEC);
    const op = ops.find((o) => o.path === '/data-stores');
    expect(op?.operationId).toBe(synthesizeOperationId('get', '/data-stores'));
  });

  it('extracts request body flag', () => {
    const ops = buildOperationIndex(MOCK_SPEC);
    expect(ops.find((o) => o.operationId === 'createScenario')?.hasRequestBody).toBe(true);
    expect(ops.find((o) => o.operationId === 'listScenarios')?.hasRequestBody).toBe(false);
  });

  it('flags path parameters as required', () => {
    const ops = buildOperationIndex(MOCK_SPEC);
    const op = ops.find((o) => o.operationId === 'getScenario');
    const param = op?.parameters.find((p) => p.name === 'scenarioId');
    expect(param?.required).toBe(true);
    expect(param?.in).toBe('path');
  });

  it('extracts requiredScopes from operation.security', () => {
    const ops = buildOperationIndex(MOCK_SPEC);
    expect(ops.find((o) => o.operationId === 'listScenarios')?.requiredScopes).toEqual([
      ['scenarios:read'],
    ]);
    expect(ops.find((o) => o.operationId === 'createScenario')?.requiredScopes).toEqual([
      ['scenarios:write'],
    ]);
  });

  it('omits requiredScopes when the operation lists no specific scopes', () => {
    // getScenario inherits global `[{ token: [] }]` — empty scope list,
    // so requiredScopes is undefined (auth required but no scope name).
    const ops = buildOperationIndex(MOCK_SPEC);
    expect(ops.find((o) => o.operationId === 'getScenario')?.requiredScopes).toBeUndefined();
  });
});

describe('normalizeTag', () => {
  it('camelCases multi-word tags', () => {
    expect(normalizeTag('Data stores')).toBe('dataStores');
    expect(normalizeTag('Scenarios')).toBe('scenarios');
    expect(normalizeTag('AI Agents')).toBe('aiAgents');
  });

  it('handles slashes as word separators (SDK Apps / Modules)', () => {
    expect(normalizeTag('SDK Apps / Modules')).toBe('sdkAppsModules');
  });

  it('returns "default" for empty input', () => {
    expect(normalizeTag('')).toBe('default');
    expect(normalizeTag('   ')).toBe('default');
  });

  it('prefers a parenthetical alias when one is supplied', () => {
    expect(normalizeTag('Foo Bar (Baz)')).toBe('baz');
  });
});

describe('compactTagPhrase', () => {
  it('is a no-op for boilerplate-free phrases', () => {
    expect(compactTagPhrase('Scenarios')).toBe('Scenarios');
    expect(compactTagPhrase('Data stores')).toBe('Data stores');
  });
});

describe('findOperation', () => {
  const spec = buildProcessed();

  it('finds by operationId', () => {
    expect(findOperation(spec, 'listScenarios')?.operationId).toBe('listScenarios');
  });

  it('finds by "METHOD path"', () => {
    expect(findOperation(spec, 'GET /scenarios/{scenarioId}')?.operationId).toBe('getScenario');
  });

  it('returns undefined for unknown id', () => {
    expect(findOperation(spec, 'nonExistent')).toBeUndefined();
  });
});

describe('searchOperations', () => {
  const spec = buildProcessed();

  it('ranks operationId hits highest', () => {
    const results = searchOperations(spec, 'listScenarios');
    expect(results[0]?.operationId).toBe('listScenarios');
  });

  it('returns matches by tag', () => {
    const results = searchOperations(spec, 'data');
    expect(results.length).toBeGreaterThan(0);
  });

  it('respects limit', () => {
    const results = searchOperations(spec, 'scenario', 1);
    expect(results).toHaveLength(1);
  });
});

describe('summarizeOperation', () => {
  const spec = buildProcessed();

  it('produces compact serializable output', () => {
    const op = findOperation(spec, 'listScenarios');
    if (!op) throw new Error('expected listScenarios to be findable in mock spec');
    const summary = summarizeOperation(op);
    expect(summary['operationId']).toBe('listScenarios');
    expect(summary['method']).toBe('GET');
    expect(summary['path']).toBe('/scenarios');
    expect(summary['parameters']).toHaveLength(2);
    expect(summary['requiredScopes']).toEqual([['scenarios:read']]);
  });
});
