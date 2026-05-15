/**
 * Search Executor — runs LLM-written JS against the OpenAPI spec.
 *
 * Sync QuickJS context. No network. Exposes:
 *   - `spec` — { title, version, sourceUrl, serverPrefix, operations[] }.
 *     Each operation is the compact form from `summarizeOperation()`.
 *     Set to `null` if no spec is loaded.
 *   - `getOperation(idOrMethodPath)` — full operation lookup
 *   - `searchOperations(query, limit?)` — ranked text search
 *   - `findOperationsByPath(pattern)` — substring on path
 */

import type { QuickJSContext, QuickJSHandle, QuickJSRuntime } from 'quickjs-emscripten';
import { findOperation, searchOperations, summarizeOperation } from '../spec/index.js';
import type { ProcessedSpec } from '../types/spec.js';
import { BaseSyncExecutor, injectJsonValue } from './executor.js';
import { SEARCH_MAX_MEMORY_BYTES, SEARCH_TIMEOUT_MS } from './limits.js';

export interface SearchExecutorOptions {
  spec?: ProcessedSpec;
}

export class SearchExecutor extends BaseSyncExecutor {
  private readonly spec?: ProcessedSpec;

  constructor(options: SearchExecutorOptions) {
    super({ timeoutMs: SEARCH_TIMEOUT_MS, maxMemoryBytes: SEARCH_MAX_MEMORY_BYTES });
    this.spec = options.spec;
  }

  protected setupContext(
    context: QuickJSContext,
    _runtime: QuickJSRuntime,
    _warnings: string[],
  ): void {
    const summarized = this.spec
      ? {
          title: this.spec.title,
          version: this.spec.version,
          sourceUrl: this.spec.sourceUrl,
          serverPrefix: this.spec.serverPrefix,
          operations: this.spec.operations.map(summarizeOperation),
        }
      : null;

    injectJsonValue(context, 'spec', summarized);

    const getOperationFn = context.newFunction('getOperation', (idHandle: QuickJSHandle) => {
      const id = context.getString(idHandle);
      if (!this.spec) return context.null;
      const op = findOperation(this.spec, id);
      if (!op) return context.null;
      return jsonValueToHandle(context, op);
    });
    context.setProp(context.global, 'getOperation', getOperationFn);
    getOperationFn.dispose();

    const searchFn = context.newFunction(
      'searchOperations',
      (qHandle: QuickJSHandle, limitHandle?: QuickJSHandle) => {
        const q = context.getString(qHandle);
        const limit = limitHandle ? context.getNumber(limitHandle) : 25;
        if (!this.spec) {
          return jsonValueToHandle(context, []);
        }
        const ops = searchOperations(this.spec, q, limit).map(summarizeOperation);
        return jsonValueToHandle(context, ops);
      },
    );
    context.setProp(context.global, 'searchOperations', searchFn);
    searchFn.dispose();

    const byPathFn = context.newFunction('findOperationsByPath', (pHandle: QuickJSHandle) => {
      const pattern = context.getString(pHandle).toLowerCase();
      if (!this.spec) {
        return jsonValueToHandle(context, []);
      }
      const matches = this.spec.operations
        .filter((op) => op.path.toLowerCase().includes(pattern))
        .map(summarizeOperation);
      return jsonValueToHandle(context, matches);
    });
    context.setProp(context.global, 'findOperationsByPath', byPathFn);
    byPathFn.dispose();
  }
}

function jsonValueToHandle(context: QuickJSContext, value: unknown): QuickJSHandle {
  const json = JSON.stringify(value);
  const result = context.evalCode(`(${json})`);
  if (result.error) {
    result.error.dispose();
    return context.null;
  }
  return result.value;
}
