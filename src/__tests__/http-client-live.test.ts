import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HttpClient } from '../client/http.js';
import { MakeHttpError } from '../client/types.js';

interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
}

interface RouteHandler {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  delayMs?: number;
}

function startTestServer(): Promise<{
  baseUrl: string;
  requests: RecordedRequest[];
  routes: Map<string, RouteHandler[]>;
  close: () => Promise<void>;
}> {
  const requests: RecordedRequest[] = [];
  const routes = new Map<string, RouteHandler[]>();

  const server: Server = createServer((req, res) => {
    requests.push({
      method: req.method ?? 'GET',
      url: req.url ?? '/',
      headers: { ...req.headers },
    });
    const pathOnly = (req.url ?? '/').split('?')[0] ?? '/';
    const key = `${req.method ?? 'GET'} ${pathOnly}`;
    const queue = routes.get(key);
    const handler = queue?.shift();
    void respond(res, handler);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${String(addr.port)}`,
        requests,
        routes,
        close: () =>
          new Promise((r) =>
            server.close(() => {
              r();
            }),
          ),
      });
    });
  });
}

async function respond(res: ServerResponse, handler: RouteHandler | undefined): Promise<void> {
  if (!handler) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'no handler' }));
    return;
  }
  if (handler.delayMs) await new Promise((r) => setTimeout(r, handler.delayMs));
  res.writeHead(handler.status, {
    'Content-Type': 'application/json',
    ...(handler.headers ?? {}),
  });
  res.end(handler.body !== undefined ? JSON.stringify(handler.body) : '');
}

// Drain request bodies so the connection doesn't stall.
function drain(req: IncomingMessage): void {
  req.on('data', () => undefined);
  req.on('end', () => undefined);
}
void drain;

describe('HttpClient (live loopback)', () => {
  let srv: Awaited<ReturnType<typeof startTestServer>>;
  beforeEach(async () => {
    srv = await startTestServer();
  });
  afterEach(async () => {
    await srv.close();
  });

  it('sends Authorization: Token <key>', async () => {
    srv.routes.set('GET /users/me', [{ status: 200, body: { id: 7 } }]);
    const client = new HttpClient({
      baseUrl: srv.baseUrl,
      pathPrefix: '',
      apiKey: 'tok-secret',
    });
    const res = await client.request({ method: 'GET', path: '/users/me' });
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ id: 7 });
    expect(srv.requests[0]?.headers['authorization']).toBe('Token tok-secret');
  });

  it('throws MakeHttpError with body excerpt + scope hint on 403', async () => {
    srv.routes.set('GET /scenarios', [
      { status: 403, body: { message: 'forbidden', code: 'IM003' } },
    ]);
    const client = new HttpClient({
      baseUrl: srv.baseUrl,
      pathPrefix: '',
      apiKey: 'tok',
    });
    let err: unknown;
    try {
      await client.request(
        { method: 'GET', path: '/scenarios' },
        { requiredScopes: [['scenarios:read']] },
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MakeHttpError);
    const httpErr = err as MakeHttpError;
    expect(httpErr.status).toBe(403);
    expect(httpErr.message).toContain('HTTP 403');
    expect(httpErr.message).toContain('forbidden');
    expect(httpErr.message).toContain('scenarios:read');
    expect(httpErr.requiredScopes).toEqual(['scenarios:read']);
  });

  it('retries once after a 429 honoring Retry-After', async () => {
    srv.routes.set('GET /scenarios', [
      { status: 429, headers: { 'Retry-After': '0' } },
      { status: 200, body: { ok: true } },
    ]);
    const warns: string[] = [];
    const client = new HttpClient({
      baseUrl: srv.baseUrl,
      pathPrefix: '',
      apiKey: 'tok',
      onWarn: (m) => warns.push(m),
    });
    const res = await client.request({ method: 'GET', path: '/scenarios' });
    expect(res.status).toBe(200);
    expect(srv.requests).toHaveLength(2);
    expect(warns.some((w) => w.includes('429'))).toBe(true);
  });

  it('does not loop on repeated 429', async () => {
    srv.routes.set('GET /scenarios', [
      { status: 429, headers: { 'Retry-After': '0' } },
      { status: 429, headers: { 'Retry-After': '0' } },
      { status: 200, body: { ok: true } },
    ]);
    const client = new HttpClient({ baseUrl: srv.baseUrl, pathPrefix: '', apiKey: 'tok' });
    let err: unknown;
    try {
      await client.request({ method: 'GET', path: '/scenarios' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MakeHttpError);
    expect((err as MakeHttpError).status).toBe(429);
    // Two attempts total (one initial + one retry); third 429 is not retried.
    expect(srv.requests).toHaveLength(2);
  });

  it('does not crash on 204 No Content', async () => {
    srv.routes.set('DELETE /scenarios/1', [{ status: 204 }]);
    const client = new HttpClient({ baseUrl: srv.baseUrl, pathPrefix: '', apiKey: 'tok' });
    const res = await client.request({ method: 'DELETE', path: '/scenarios/1' });
    expect(res.status).toBe(204);
    expect(res.data).toBeUndefined();
  });
});
