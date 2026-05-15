/**
 * Execute Executor — runs LLM-written JS that performs real Make.com API calls.
 *
 * Async QuickJS context. Per-tenant credentials are bound at construction
 * time so each MCP request gets its own short-lived executor.
 *
 * Sandbox surface:
 *   make.<tag>.<operationId>(args) -> Promise
 *   make.callOperation(operationId, args) -> Promise
 *   make.request({ method, path, pathParams?, query?, body?, headers? }) -> Promise
 *   make.spec -> { title, version, sourceUrl, operationCount }
 *
 * Hosts are responsible for enforcing the per-execute call budget.
 */

import { newAsyncContext, type QuickJSAsyncContext, type QuickJSHandle } from 'quickjs-emscripten';
import type { HttpClient } from '../client/http.js';
import { createMakeClient } from '../client/factory.js';
import { MakeHttpError } from '../client/types.js';
import {
  buildMakePrelude,
  dispatchOperation,
  dispatchRawRequest,
  UnknownOperationError,
} from './dispatch.js';
import { configureRuntimeLimits, formatError, setupConsole } from './executor.js';
import { DEFAULT_LIMITS, type SandboxLimits } from './limits.js';
import type { ExecuteResult, LogEntry } from './types.js';
import { MissingCredentialsError, type TenantContext } from '../tenant/context.js';
import type { ProcessedSpec } from '../types/spec.js';

export interface ExecuteExecutorOptions {
  /** Tenant credentials — sandboxed clients are built from these on demand. */
  tenant: TenantContext;
  /** OpenAPI spec for the configured Make.com zone. */
  spec?: ProcessedSpec;
  /** Lazy client factory — only invoked if the sandbox makes a real call. */
  buildClient?: (tenant: TenantContext, onWarn: (msg: string) => void) => HttpClient;
  /** Sandbox limits (timeout, memory, calls). */
  limits?: Partial<SandboxLimits>;
}

export class ExecuteExecutor {
  private readonly tenant: TenantContext;
  private readonly spec?: ProcessedSpec;
  private readonly limits: SandboxLimits;
  private readonly buildClient: NonNullable<ExecuteExecutorOptions['buildClient']>;

  constructor(opts: ExecuteExecutorOptions) {
    this.tenant = opts.tenant;
    this.spec = opts.spec;
    this.limits = { ...DEFAULT_LIMITS, ...opts.limits };
    this.buildClient = opts.buildClient ?? defaultBuildClient;
  }

  async execute(code: string): Promise<ExecuteResult> {
    const startTime = Date.now();
    const logs: LogEntry[] = [];
    const warnings: string[] = [];
    let callsMade = 0;

    const context = await newAsyncContext();
    const runtime = context.runtime;

    let client: HttpClient | undefined;
    const onWarn = (msg: string): void => {
      if (!warnings.includes(msg)) warnings.push(msg);
    };

    try {
      configureRuntimeLimits(runtime, this.limits);
      setupConsole(context, logs);

      const callBudgetGuard = (): void => {
        callsMade += 1;
        if (callsMade > this.limits.maxCallsPerExecute) {
          throw new Error(
            `API call limit exceeded (max ${String(this.limits.maxCallsPerExecute)} calls per execute). ` +
              'Use more targeted queries or batch results.',
          );
        }
      };

      const getClient = (): HttpClient => {
        if (!this.spec) {
          throw new Error('No Make.com spec loaded; cannot dispatch operations.');
        }
        if (!this.tenant.make) throw new MissingCredentialsError();
        client ??= this.buildClient(this.tenant, onWarn);
        return client;
      };

      bindMakeFunctions(context, {
        getClient,
        getSpec: () => this.spec,
        callBudgetGuard,
      });

      if (this.spec) {
        const prelude = buildMakePrelude(this.spec);
        const preludeResult = context.evalCode(prelude, 'prelude.js', { type: 'global' });
        if (preludeResult.error) {
          const errValue: unknown = context.dump(preludeResult.error);
          preludeResult.error.dispose();
          throw new Error(`Failed to bootstrap make namespace: ${formatError(errValue)}`);
        }
        preludeResult.value.dispose();
      } else {
        // No spec — stub the namespace so the sandbox at least has something
        // to import. Any call surfaces a clear error.
        const stub = `var make = { __missing: true, spec: null, request: function() { throw new Error('No Make.com spec loaded; configure MAKE_BASE_URL/MAKE_API_KEY or X-Make-* headers.'); }, callOperation: function() { throw new Error('No Make.com spec loaded; configure MAKE_BASE_URL/MAKE_API_KEY or X-Make-* headers.'); } };`;
        const stubResult = context.evalCode(stub, 'stub.js', { type: 'global' });
        if (stubResult.error) {
          stubResult.error.dispose();
        } else {
          stubResult.value.dispose();
        }
      }

      const result = await context.evalCodeAsync(code, 'sandbox.js', { type: 'global' });
      if (result.error) {
        const errorValue: unknown = context.dump(result.error);
        result.error.dispose();
        return {
          ok: false,
          error: formatError(errorValue),
          logs,
          warnings,
          callsMade,
          durationMs: Date.now() - startTime,
        };
      }

      const valueHandle = result.value;
      try {
        if (context.typeof(valueHandle) !== 'object') {
          return {
            ok: true,
            data: context.dump(valueHandle),
            logs,
            warnings,
            callsMade,
            durationMs: Date.now() - startTime,
          };
        }

        const initial = context.getPromiseState(valueHandle);
        if (initial.type === 'fulfilled' && initial.notAPromise === true) {
          return {
            ok: true,
            data: context.dump(valueHandle),
            logs,
            warnings,
            callsMade,
            durationMs: Date.now() - startTime,
          };
        }

        const maxDrains = 1000;
        for (let i = 0; i < maxDrains; i += 1) {
          const state = context.getPromiseState(valueHandle);
          if (state.type === 'fulfilled') {
            const dumped: unknown = context.dump(state.value);
            state.value.dispose();
            return {
              ok: true,
              data: dumped,
              logs,
              warnings,
              callsMade,
              durationMs: Date.now() - startTime,
            };
          }
          if (state.type === 'rejected') {
            const dumped: unknown = context.dump(state.error);
            state.error.dispose();
            return {
              ok: false,
              error: formatError(dumped),
              logs,
              warnings,
              callsMade,
              durationMs: Date.now() - startTime,
            };
          }
          const drain = runtime.executePendingJobs(64);
          if (drain.error) {
            const errorValue: unknown = context.dump(drain.error);
            drain.error.dispose();
            return {
              ok: false,
              error: formatError(errorValue),
              logs,
              warnings,
              callsMade,
              durationMs: Date.now() - startTime,
            };
          }
          await new Promise<void>((r) => setImmediate(r));
        }
        return {
          ok: false,
          error: 'Sandbox promise did not settle within microtask budget',
          logs,
          warnings,
          callsMade,
          durationMs: Date.now() - startTime,
        };
      } finally {
        valueHandle.dispose();
      }
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        logs,
        warnings,
        callsMade,
        durationMs: Date.now() - startTime,
      };
    } finally {
      try {
        context.dispose();
      } catch {
        /* swallow disposal-time WASM aborts */
      }
      try {
        runtime.dispose();
      } catch {
        /* swallow disposal-time WASM aborts */
      }
    }
  }
}

// ─── Bind host functions ────────────────────────────────────────────

interface MakeBinding {
  getClient: () => HttpClient;
  getSpec: () => ProcessedSpec | undefined;
  callBudgetGuard: () => void;
}

function bindMakeFunctions(context: QuickJSAsyncContext, binding: MakeBinding): void {
  const callFn = context.newAsyncifiedFunction(
    '__makeCall',
    async (opIdHandle: QuickJSHandle, argsJsonHandle: QuickJSHandle) => {
      const opId = context.getString(opIdHandle);
      const argsJson = context.getString(argsJsonHandle);
      try {
        binding.callBudgetGuard();
        const args = parseJson(argsJson);
        const spec = binding.getSpec();
        if (!spec) throw new Error('make: spec not loaded');
        const client = binding.getClient();
        const response = await dispatchOperation(client, spec, opId, args);
        return jsonResponseToHandle(context, response.data);
      } catch (err) {
        throw new Error(formatNamespacedError(err));
      }
    },
  );
  context.setProp(context.global, '__makeCall', callFn);
  callFn.dispose();

  const rawFn = context.newAsyncifiedFunction(
    '__makeRaw',
    async (argsJsonHandle: QuickJSHandle) => {
      const argsJson = context.getString(argsJsonHandle);
      try {
        binding.callBudgetGuard();
        const args = parseJson(argsJson) as unknown as Parameters<typeof dispatchRawRequest>[1];
        const client = binding.getClient();
        const response = await dispatchRawRequest(client, args);
        return jsonResponseToHandle(context, response.data);
      } catch (err) {
        throw new Error(formatNamespacedError(err));
      }
    },
  );
  context.setProp(context.global, '__makeRaw', rawFn);
  rawFn.dispose();
}

function formatNamespacedError(err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  const tag =
    err instanceof MakeHttpError
      ? 'make.http'
      : err instanceof MissingCredentialsError
        ? 'make.missing-credentials'
        : err instanceof UnknownOperationError
          ? 'make.unknown-operation'
          : 'make.error';
  return `[${tag}] ${detail}`;
}

function parseJson(json: string): Record<string, unknown> {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json) as unknown;
    if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    return {};
  } catch {
    return {};
  }
}

function jsonResponseToHandle(context: QuickJSAsyncContext, data: unknown): QuickJSHandle {
  const json = JSON.stringify(data ?? null);
  const stringHandle = context.newString(json);
  const parseExpr = context.evalCode('JSON.parse');
  if (parseExpr.error) {
    parseExpr.error.dispose();
    stringHandle.dispose();
    return context.null;
  }
  const parsed = context.callFunction(parseExpr.value, context.undefined, stringHandle);
  parseExpr.value.dispose();
  stringHandle.dispose();
  if (parsed.error) {
    parsed.error.dispose();
    return context.null;
  }
  return parsed.value;
}

// ─── Default client factory ─────────────────────────────────────────

function defaultBuildClient(tenant: TenantContext, onWarn: (msg: string) => void): HttpClient {
  if (!tenant.make) throw new MissingCredentialsError();
  return createMakeClient(tenant.make, { onWarn });
}
