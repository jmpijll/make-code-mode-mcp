/**
 * Mock Make.com Web API v2 controller for integration tests.
 *
 * Speaks just enough of the API to drive the MCP server end-to-end. Records
 * every request so tests can assert which operations were called and with
 * which bodies.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  ADMIN_FORBIDDEN,
  ORG_ID,
  ORGANIZATIONS_PAGE,
  SCENARIO_ID,
  SCENARIO_DETAIL,
  SCENARIOS_PAGE,
  TEAMS_PAGE,
  USER_ME,
} from './fixtures/make-canned.js';

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

export interface MockMake {
  baseUrl: string;
  requests: RecordedRequest[];
  reset(): void;
  close(): Promise<void>;
}

export async function startMockMake(opts: { apiKey: string }): Promise<MockMake> {
  const requests: RecordedRequest[] = [];

  const server: Server = createServer((req, res) => {
    void handle(req, res, opts.apiKey, requests);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${String(addr.port)}`;

  return {
    baseUrl,
    requests,
    reset() {
      requests.length = 0;
    },
    async close() {
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
    },
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  expectedApiKey: string,
  requests: RecordedRequest[],
): Promise<void> {
  const body = await readBody(req);
  const path = req.url ?? '/';
  const method = req.method ?? 'GET';
  requests.push({ method, path, headers: { ...req.headers }, body });

  const expectedAuthHeader = `Token ${expectedApiKey}`;
  if (req.headers['authorization'] !== expectedAuthHeader) {
    json(res, 401, {
      message: 'Invalid API token',
      code: 'IM001',
    });
    return;
  }

  const route = `${method} ${stripQuery(path)}`;
  switch (route) {
    case 'GET /users/me':
      json(res, 200, USER_ME);
      return;
    case 'GET /organizations':
      json(res, 200, ORGANIZATIONS_PAGE);
      return;
    case `GET /organizations/${String(ORG_ID)}/teams`:
      json(res, 200, TEAMS_PAGE);
      return;
    case 'GET /scenarios':
      json(res, 200, SCENARIOS_PAGE);
      return;
    case `GET /scenarios/${String(SCENARIO_ID)}`:
      json(res, 200, SCENARIO_DETAIL);
      return;
    case 'GET /admin/owners':
      json(res, ADMIN_FORBIDDEN.status, ADMIN_FORBIDDEN.body);
      return;
    default:
      json(res, 404, {
        message: `No mock route for ${route}`,
        code: 'IM404',
      });
  }
}

function stripQuery(path: string): string {
  const i = path.indexOf('?');
  return i === -1 ? path : path.slice(0, i);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }
      const text = Buffer.concat(chunks).toString('utf-8');
      try {
        resolve(text.length > 0 ? JSON.parse(text) : undefined);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
