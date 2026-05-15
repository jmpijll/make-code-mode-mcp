import { describe, expect, it } from 'vitest';
import {
  buildContextFromEnv,
  buildContextFromHeaders,
  HEADER_API_KEY,
  HEADER_BASE_URL,
  MissingCredentialsError,
} from '../tenant/context.js';

describe('TenantContext', () => {
  describe('buildContextFromEnv', () => {
    it('returns empty context when no env creds set', () => {
      const ctx = buildContextFromEnv({});
      expect(ctx.make).toBeUndefined();
      expect(ctx.fromHeaders).toBe(false);
    });

    it('builds creds from env using default base URL', () => {
      const ctx = buildContextFromEnv({ MAKE_API_KEY: 'k' });
      expect(ctx.make).toEqual({
        baseUrl: 'https://eu1.make.com/api/v2',
        apiKey: 'k',
      });
    });

    it('honors MAKE_BASE_URL and strips trailing slashes', () => {
      const ctx = buildContextFromEnv({
        MAKE_API_KEY: 'k',
        MAKE_BASE_URL: 'https://us2.make.com/api/v2/',
      });
      expect(ctx.make).toEqual({
        baseUrl: 'https://us2.make.com/api/v2',
        apiKey: 'k',
      });
    });

    it('ignores base URL when no api key is set', () => {
      const ctx = buildContextFromEnv({ MAKE_BASE_URL: 'https://x' });
      expect(ctx.make).toBeUndefined();
    });
  });

  describe('buildContextFromHeaders', () => {
    it('reads creds from headers (api key + base URL)', () => {
      const ctx = buildContextFromHeaders(
        {
          [HEADER_API_KEY]: 'tk',
          [HEADER_BASE_URL]: 'https://us1.make.com/api/v2/',
        },
        {},
      );
      expect(ctx.fromHeaders).toBe(true);
      expect(ctx.make).toEqual({
        baseUrl: 'https://us1.make.com/api/v2',
        apiKey: 'tk',
      });
    });

    it('uses the default base URL when only api key header is provided', () => {
      const ctx = buildContextFromHeaders({ [HEADER_API_KEY]: 'tk' }, {});
      expect(ctx.make).toEqual({
        baseUrl: 'https://eu1.make.com/api/v2',
        apiKey: 'tk',
      });
    });

    it('falls back to env MAKE_BASE_URL when header is absent', () => {
      const ctx = buildContextFromHeaders(
        { [HEADER_API_KEY]: 'tk' },
        { MAKE_BASE_URL: 'https://eu2.make.com/api/v2' },
      );
      expect(ctx.make?.baseUrl).toBe('https://eu2.make.com/api/v2');
    });

    it('falls back to env when no headers are present', () => {
      const ctx = buildContextFromHeaders(
        {},
        { MAKE_API_KEY: 'envk', MAKE_BASE_URL: 'https://us2.make.com/api/v2' },
      );
      expect(ctx.make?.apiKey).toBe('envk');
      expect(ctx.make?.baseUrl).toBe('https://us2.make.com/api/v2');
    });

    it('treats array header values like the first value', () => {
      const ctx = buildContextFromHeaders(
        {
          [HEADER_API_KEY]: ['k1', 'k2'],
          [HEADER_BASE_URL]: 'https://eu1.make.com/api/v2',
        },
        {},
      );
      expect(ctx.make?.apiKey).toBe('k1');
    });
  });

  describe('MissingCredentialsError', () => {
    it('produces actionable message', () => {
      const err = new MissingCredentialsError();
      expect(err.message).toContain('MAKE_API_KEY');
      expect(err.message).toContain('X-Make-Api-Key');
    });
  });
});
