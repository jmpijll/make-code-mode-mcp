import { describe, expect, it } from 'vitest';
import { buildQueryString, substitutePathParams } from '../client/http.js';
import { createMakeClient } from '../client/index.js';

describe('substitutePathParams', () => {
  it('replaces placeholders', () => {
    expect(
      substitutePathParams('/scenarios/{scenarioId}/blueprints/{blueprintId}', {
        scenarioId: 1,
        blueprintId: 'b',
      }),
    ).toBe('/scenarios/1/blueprints/b');
  });

  it('encodes special characters', () => {
    expect(substitutePathParams('/items/{id}', { id: 'a/b c' })).toBe('/items/a%2Fb%20c');
  });

  it('throws on missing param', () => {
    expect(() => substitutePathParams('/x/{y}', {})).toThrow(/Missing path parameter/);
  });

  it('returns input unchanged when no params object', () => {
    expect(substitutePathParams('/scenarios', undefined)).toBe('/scenarios');
  });
});

describe('buildQueryString', () => {
  it('skips undefined values', () => {
    expect(buildQueryString({ a: 1, b: undefined, c: 'x' })).toBe('?a=1&c=x');
  });

  it('repeats array values', () => {
    expect(buildQueryString({ tag: ['a', 'b'] })).toBe('?tag=a&tag=b');
  });

  it('returns empty string for empty input', () => {
    expect(buildQueryString({})).toBe('');
    expect(buildQueryString(undefined)).toBe('');
  });

  it('expands one-level nested objects with bracket notation (Make.com pg shape)', () => {
    expect(
      buildQueryString({
        teamId: 1,
        pg: { limit: 25, offset: 0, sortBy: 'name', sortDir: 'asc' },
      }),
    ).toBe('?teamId=1&pg%5Blimit%5D=25&pg%5Boffset%5D=0&pg%5BsortBy%5D=name&pg%5BsortDir%5D=asc');
  });

  it('expands arrays inside nested objects', () => {
    expect(
      buildQueryString({
        pg: { sortBy: ['name', 'created'] },
      }),
    ).toBe('?pg%5BsortBy%5D=name&pg%5BsortBy%5D=created');
  });

  it('skips undefined values inside nested objects', () => {
    expect(
      buildQueryString({
        pg: { limit: 25, offset: undefined },
      }),
    ).toBe('?pg%5Blimit%5D=25');
  });

  it('handles boolean values as "true" / "false"', () => {
    expect(buildQueryString({ isActive: true, deprecated: false })).toBe(
      '?isActive=true&deprecated=false',
    );
  });
});

describe('createMakeClient', () => {
  it('uses an empty pathPrefix (api/v2 is part of baseUrl)', () => {
    const client = createMakeClient({ baseUrl: 'https://eu1.make.com/api/v2', apiKey: 'k' });
    expect(client.config.baseUrl).toBe('https://eu1.make.com/api/v2');
    expect(client.config.pathPrefix).toBe('');
    expect(client.config.label).toBe('make');
  });

  it('preserves API key on the config (for Authorization: Token wiring)', () => {
    const client = createMakeClient({ baseUrl: 'https://eu1.make.com/api/v2', apiKey: 'secret' });
    expect(client.config.apiKey).toBe('secret');
  });
});
