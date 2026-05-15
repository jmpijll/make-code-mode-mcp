# Security model

## Threat model

The server sits between an LLM agent (potentially adversarial in its code generation) and the Make.com Web API (a SaaS that can mutate scenarios, rotate connections, drain webhooks). The threat surface is:

1. **Adversarial sandbox code.** The LLM (or a user prompt-injecting it) might try to exfiltrate credentials, exhaust resources, or call destructive operations.
2. **Credential leakage.** The Make.com API token must not be visible to the sandbox, MCP responses, logs, or other tenants' requests.
3. **Resource exhaustion.** Malicious or buggy code might loop forever, allocate gigabytes, or spam the upstream API.
4. **Privilege escalation across tenants.** In HTTP mode, one tenant's request must not affect another's.

## Defenses

### Credentials never enter the sandbox

The QuickJS prelude only exposes opaque host bindings (`__makeCall`, `__makeRaw`). The HTTP client that holds the API token is constructed on the host side from `TenantContext`, which lives outside the sandbox. The sandbox cannot read `process.env`, cannot list environment variables, and cannot inspect the host's HTTP client object.

### Per-request scoping

In HTTP mode, every request runs inside its own Node `AsyncLocalStorage` scope. The `tenantResolver()` reads the ALS slot and builds a fresh `TenantContext` from headers. Two interleaved requests on the same Node process cannot share credentials.

### Sandbox limits

`src/sandbox/limits.ts` caps every sandbox invocation:

- **Time**: 30 s wall-clock deadline (configurable via `MAKE_EXECUTE_TIMEOUT_MS`). Enforced by QuickJS's interrupt handler.
- **Memory**: 64 MB. Enforced by `runtime.setMemoryLimit`.
- **Stack**: 512 KB. Enforced by `runtime.setMaxStackSize`.
- **API call budget**: 25 per execute (configurable via `MAKE_MAX_CALLS_PER_EXECUTE`). Enforced in the dispatcher before forwarding to the HTTP client.
- **Code input**: 100 000 characters. Enforced at the MCP boundary.
- **Result size**: 100 000 characters. Truncated with notice.
- **Console capture**: 1 MB / 1000 entries. Enforced inside the prelude.

### Always-strict TLS

The Make.com API is public cloud only. There is no `insecure` mode, no custom CA support, no self-signed certificates. If your DNS resolves `eu1.make.com` to anything that isn't a publicly-trusted Make.com endpoint, the request fails — that's intentional.

### Rate-limit respect

When Make.com returns `429 Too Many Requests`, the HTTP client honours `Retry-After` (capped at 60 s) and retries once. The sandbox sees a single API call regardless. No exponential backoff loops — the second 429 propagates.

### Scope-aware error surfacing

`MakeHttpError` for 401/403 includes the operation's `requiredScopes` extracted from `operation.security`. The model sees `(operation requires scope ``scenarios:read`` — check your Make.com API token has it)` and can route the failure back to the user. This is informational only; the server does not pre-filter operations by scope.

## What is *not* defended against

- **Destructive operations the LLM was asked to run.** If a user prompts the agent to `make.scenarios.deleteScenario({...})` and the agent does so, the server happily forwards that request. Pre-execution review of mutating operations is the SKILL §7's responsibility, not the runtime's.
- **Subtle scope abuse with a privileged token.** A token with `scenarios:write` can mutate any scenario the user can reach. The server does not narrow scopes; that's the operator's job at token-minting time.
- **Cross-zone data exfiltration.** If `MAKE_BASE_URL` is changed mid-session (e.g. via headers), the same token may or may not work against the new zone — Make.com tokens are usually zone-scoped, but the server doesn't enforce this.
- **Side-channel timing.** The sandbox does not isolate timing; an adversarial sandbox script could in principle measure HTTP latencies to infer state. We accept this.

## Credential handling

- The token is read once per request (env or headers) into `TenantContext.make.apiKey`.
- The HTTP client copies it into the `Authorization` header at request build time.
- The token is **never** logged, **never** included in MCP tool responses, and **never** echoed back in error messages.
- On process exit / sandbox dispose, `TenantContext` and the HTTP client are garbage-collected. There is no on-disk credential cache.

## Operator responsibilities

- Use the **least-privilege scope set** when minting tokens. The full scope list is documented at `https://<zone>.make.com/profile/api`.
- Run the HTTP transport behind TLS termination.
- Set `MCP_HTTP_ALLOWED_ORIGINS` to a strict list when serving browser clients.
- Monitor `[make.http] HTTP 4xx` log lines — they often hint at scope or quota issues before users complain.

## Reporting vulnerabilities

See [`SECURITY.md`](../SECURITY.md).
