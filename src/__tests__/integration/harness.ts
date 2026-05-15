/**
 * Integration test harness.
 *
 * Spins up the real MCP server (createMcpServer) with the test OpenAPI
 * fixture and a mock Make.com controller, then connects an MCP Client over
 * either an in-memory transport (linked pair) or a real Streamable HTTP
 * server on a random localhost port.
 */

import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from '../../server/server.js';
import { requestStore } from '../../server/request-context.js';
import { buildOperationIndex } from '../../spec/index-builder.js';
import { buildContextFromHeaders, type TenantContext } from '../../tenant/context.js';
import type { OpenApiDocument, ProcessedSpec } from '../../types/spec.js';
import type { MockMake } from './mock-make.js';
import { startMockMake } from './mock-make.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const TEST_API_KEY = 'test-api-key-fixture';

export type TransportMode = 'memory' | 'http';

export interface Harness {
  client: Client;
  controller: MockMake;
  cleanup(): Promise<void>;
}

export async function loadFixtureSpec(baseUrl: string): Promise<ProcessedSpec> {
  const path = resolve(__dirname, 'fixtures', 'openapi.json');
  const raw = await readFile(path, 'utf-8');
  const document = JSON.parse(raw) as OpenApiDocument;
  // Point the spec at the mock server so the fixture can stay zone-agnostic.
  document.servers = [{ url: baseUrl }];
  return {
    sourceUrl: 'fixture://openapi.json',
    version: document.info.version ?? '1.0.0-test',
    title: document.info.title ?? 'Mock Make.com',
    serverPrefix: '',
    operations: buildOperationIndex(document),
    document,
  };
}

interface HarnessOptions {
  mode: TransportMode;
  /** Override headers passed by the MCP client (HTTP mode only). */
  headers?: Record<string, string>;
}

export async function setupHarness(opts: HarnessOptions): Promise<Harness> {
  const controller = await startMockMake({ apiKey: TEST_API_KEY });
  const spec = await loadFixtureSpec(controller.baseUrl);

  if (opts.mode === 'memory') {
    const tenant: TenantContext = {
      requestId: 'test',
      fromHeaders: false,
      make: {
        baseUrl: controller.baseUrl,
        apiKey: TEST_API_KEY,
      },
    };
    const server = createMcpServer({
      spec,
      tenantResolver: () => tenant,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client(
      { name: 'integration-client', version: '0.0.0' },
      { capabilities: {} },
    );
    await client.connect(clientTransport);

    return {
      client,
      controller,
      async cleanup() {
        await client.close();
        await server.close();
        await controller.close();
      },
    };
  }

  // HTTP mode — full request/response path including header propagation.
  const headers: Record<string, string> = opts.headers ?? {
    'X-Make-Api-Key': TEST_API_KEY,
    'X-Make-Base-Url': controller.baseUrl,
  };

  const server = createMcpServer({
    spec,
    tenantResolver: () => {
      const ctx = requestStore.getStore();
      if (!ctx) throw new Error('No request context — header propagation broken');
      // Pass an empty fallback env so tests are deterministic regardless of the
      // ambient MAKE_API_KEY / MAKE_BASE_URL on the developer machine.
      return buildContextFromHeaders(ctx.headers, {});
    },
  });
  const serverTransport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  await server.connect(serverTransport);

  const httpServer: HttpServer = createServer((req, res) => {
    void requestStore.run({ headers: req.headers, clientIp: '127.0.0.1' }, async () => {
      await serverTransport.handleRequest(req, res);
    });
  });
  await new Promise<void>((resolveListen) => httpServer.listen(0, '127.0.0.1', resolveListen));
  const addr = httpServer.address() as AddressInfo;
  const url = new URL(`http://127.0.0.1:${String(addr.port)}/mcp`);

  const clientTransport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers },
  });

  const client = new Client({ name: 'integration-client', version: '0.0.0' }, { capabilities: {} });
  await client.connect(clientTransport);

  return {
    client,
    controller,
    async cleanup() {
      await client.close();
      await serverTransport.close();
      await server.close();
      await new Promise<void>((r) =>
        httpServer.close(() => {
          r();
        }),
      );
      await controller.close();
    },
  };
}

/** Helper that flattens a tool result's content into one string for assertions. */
export function toolResultText(result: {
  content: Array<{ type: string; text?: string }>;
}): string {
  return result.content
    .filter(
      (p): p is { type: 'text'; text: string } => p.type === 'text' && typeof p.text === 'string',
    )
    .map((p) => p.text)
    .join('\n---\n');
}
