/**
 * Shared client types — what the sandbox sees when it calls request().
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

export type MakeQueryScalar = string | number | boolean;
export type MakeQueryLeaf = MakeQueryScalar | MakeQueryScalar[] | undefined;
/**
 * One level of nesting is allowed (Make.com's documented `pg[limit]`,
 * `pg[offset]`, `cols[]` shapes). Deeper nesting is silently flattened to JSON.
 */
export type MakeQueryValue = Record<string, MakeQueryLeaf | Record<string, MakeQueryLeaf>>;

export interface MakeRequestParams {
  /** HTTP method (case-insensitive) — default GET. */
  method?: HttpMethod | Lowercase<HttpMethod>;
  /** Path under the API server (e.g. "/scenarios" or "/scenarios/{scenarioId}"). */
  path: string;
  /**
   * Path parameters to substitute. The path may contain `{name}` placeholders
   * which are replaced with `encodeURIComponent(value)`.
   */
  pathParams?: Record<string, string | number | boolean>;
  /**
   * Query parameters. The encoder understands a few Make.com-flavoured shapes:
   *   - `string | number | boolean`           → `key=value`
   *   - `Array<string | number | boolean>`    → repeated `key=v1&key=v2` (or `key[]=…` if the
   *                                              spec parameter ends in `[]`)
   *   - Nested objects (one level only)       → bracket notation, e.g.
   *                                              `{ pg: { limit: 25, offset: 0 } }` becomes
   *                                              `pg[limit]=25&pg[offset]=0` — matches Make.com's
   *                                              published query convention.
   *   - `undefined`                            → omitted
   */
  query?: MakeQueryValue;
  /** JSON request body. */
  body?: unknown;
  /** Extra headers (Authorization is set automatically). */
  headers?: Record<string, string>;
}

export interface MakeResponse<T = unknown> {
  /** HTTP status code. */
  status: number;
  /** Response headers as a plain object. */
  headers: Record<string, string>;
  /** Parsed JSON response body, or text fallback. */
  data: T;
}

export class MakeHttpError extends Error {
  override readonly name = 'MakeHttpError';
  public readonly status: number;
  public override readonly cause?: unknown;
  /**
   * Required scopes (e.g. `['scenarios:read']`) extracted from the OpenAPI
   * operation when the response was 401/403. Helps the agent tell the user
   * which scope is missing on their token.
   */
  public readonly requiredScopes?: string[];
  constructor(
    message: string,
    status: number,
    public readonly path: string,
    public readonly responseBody?: unknown,
    requiredScopes?: string[],
  ) {
    super(message);
    this.status = status;
    if (requiredScopes && requiredScopes.length > 0) {
      this.requiredScopes = requiredScopes;
    }
  }
}

export class MakeTransportError extends Error {
  override readonly name = 'MakeTransportError';
  public override readonly cause?: unknown;
  constructor(
    message: string,
    public readonly path: string,
    cause?: unknown,
  ) {
    super(message);
    this.cause = cause;
  }
}
