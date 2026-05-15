#!/usr/bin/env node
/**
 * Make.com Code-Mode MCP Server — entry point.
 *
 * Lifecycle:
 *   1. Validate env config (Zod).
 *   2. Pre-warm QuickJS WASM module.
 *   3. Load the OpenAPI spec (live fetch with bundled fallback).
 *   4. Build MCP server with `search` + `execute` tools.
 *   5. Start the chosen transport (stdio or HTTP).
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isKnownMakeZone, loadConfig, type AppConfig } from './config.js';
import { getQuickJSModule } from './sandbox/executor.js';
import { loadMakeSpec } from './spec/loader.js';
import { specSummary } from './spec/index.js';
import {
  buildContextFromEnv,
  buildContextFromHeaders,
  type TenantContext,
} from './tenant/context.js';
import { createMcpServer } from './server/server.js';
import { startHttpTransport, startStdioTransport } from './server/transport.js';
import { currentRequestScope } from './server/request-context.js';
import type { ProcessedSpec } from './types/spec.js';

function readPackageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '..', 'package.json'),
    resolve(here, '..', '..', 'package.json'),
  ];
  for (const candidate of candidates) {
    try {
      const raw = readFileSync(candidate, 'utf8');
      const parsed = JSON.parse(raw) as { version?: unknown };
      if (typeof parsed.version === 'string' && parsed.version.length > 0) {
        return parsed.version;
      }
    } catch {
      // Try next candidate.
    }
  }
  return '0.0.0-unknown';
}

const SERVER_VERSION = readPackageVersion();

const logger = {
  info: (msg: string, ...args: unknown[]): void => {
    console.error(`[INFO] ${msg}`, ...args);
  },
  warn: (msg: string, ...args: unknown[]): void => {
    console.error(`[WARN] ${msg}`, ...args);
  },
  error: (msg: string, ...args: unknown[]): void => {
    console.error(`[ERROR] ${msg}`, ...args);
  },
};

async function loadSpec(config: AppConfig): Promise<ProcessedSpec | undefined> {
  try {
    const spec = await loadMakeSpec({
      baseUrl: config.makeBaseUrl,
      ...(config.makeSpecUrl ? { specUrlOverride: config.makeSpecUrl } : {}),
      cacheDir: config.makeSpecCacheDir,
      onWarn: (msg: string) => {
        logger.warn(`[spec] ${msg}`);
      },
    });
    const sum = specSummary(spec);
    logger.info(
      `Loaded spec: ${sum.title} v${sum.version} ` +
        `(${String(sum.operationCount)} operations across ${String(sum.tagCount)} tags) from ${spec.sourceUrl}`,
    );
    return spec;
  } catch (err) {
    logger.warn(
      `Failed to load Make.com spec at startup: ${err instanceof Error ? err.message : String(err)}. ` +
        'Server will start without a spec; tools will refuse calls until one is available.',
    );
    return undefined;
  }
}

async function main(): Promise<void> {
  logger.info('Make.com Code-Mode MCP Server starting...');
  const config = loadConfig();
  logger.info(`Transport: ${config.mcpTransport}`);
  logger.info(`Zone: ${config.makeBaseUrl}`);

  if (!isKnownMakeZone(config.makeBaseUrl)) {
    logger.warn(
      `MAKE_BASE_URL=${config.makeBaseUrl} is not one of the published Make.com zones. ` +
        'If this is a typo, fix it; if it is a private/test instance, ignore this warning.',
    );
  }

  const wasmStart = Date.now();
  await getQuickJSModule();
  logger.info(`QuickJS WASM initialized in ${String(Date.now() - wasmStart)}ms`);

  const spec = await loadSpec(config);

  const tenantResolver = (): TenantContext => {
    const scope = currentRequestScope();
    if (scope) return buildContextFromHeaders(scope.headers);
    return buildContextFromEnv();
  };

  const server = createMcpServer({
    ...(spec ? { spec } : {}),
    tenantResolver,
    limits: {
      maxCallsPerExecute: config.makeMaxCallsPerExecute,
      timeoutMs: config.makeExecuteTimeoutMs,
    },
    logger,
    name: 'make-code-mode-mcp',
    version: SERVER_VERSION,
  });

  if (config.mcpTransport === 'stdio') {
    await startStdioTransport(server, logger);
  } else {
    await startHttpTransport(
      server,
      {
        port: config.mcpHttpPort,
        allowedOrigins: config.mcpHttpAllowedOrigins,
      },
      logger,
    );
  }
}

main().catch((err: unknown) => {
  logger.error('Fatal error:', err);
  process.exit(1);
});
