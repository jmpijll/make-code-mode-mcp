# Security Policy

## Supported versions

This project is pre-1.0 (public beta). Only the latest commit on `main` receives
security fixes — there are no maintained release branches yet.

| Version          | Supported |
| ---------------- | --------- |
| `main` (latest)  | ✅         |
| Tagged pre-releases (e.g. `v0.1.0-beta.x`) | ❌ — upgrade to `main` |

## Reporting a vulnerability

Please **do not** open public GitHub issues for security problems.

Use GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository:

> Security → Report a vulnerability →
> <https://github.com/jmpijll/make-code-mode-mcp/security/advisories/new>

If that's unavailable, email the maintainer listed in `package.json` and put
`[make-code-mode-mcp security]` in the subject line.

Please include, at minimum:

- A clear description of the issue.
- A minimum reproducible example (sandbox code, request, environment).
- The impact you believe the issue has — credential exposure, sandbox escape,
  request smuggling, DoS, etc.
- Whether you've already disclosed it elsewhere.

You should receive an acknowledgement within **5 business days**. We aim to
ship a fix or a public mitigation within **30 days** of acknowledgement for
high-severity issues. Lower-severity issues may be folded into a normal
release.

## Scope

### In scope

- The MCP server (`src/`, `dist/`) — sandbox isolation, credential handling,
  spec-loader cache integrity, scope-aware error formatting, multi-tenant
  header parsing.
- The Cloudflare Workers entry (`cf-worker/`).
- Bundled fallback spec (`src/spec/make-fallback.json`) — supply-chain
  concerns only; not the upstream Make.com API surface.

### Out of scope

- The Make.com Web API v2 itself — please report directly to Make.com via
  their bug bounty / security contact.
- Vulnerabilities in upstream dependencies — we'll pick those up via
  Dependabot; if you find one before the public advisory, please report it
  to the dependency maintainer first.
- LLM-generated sandbox code that exfiltrates data the LLM is *authorised to
  access*. The sandbox isolates the *host*; it does not police what the LLM
  decides to fetch with valid credentials. Treat the LLM operator and the
  scopes granted to the API token as the trust boundary.

## Hardening reminders

- Mint Make.com API tokens with the **narrowest scope set** the workflow
  needs. The server's 401/403 errors will tell you when a scope is missing.
- Pin `MAKE_BASE_URL` to the regional zone you actually use; the server
  warns on unknown zones but still proxies to them.
- Do not run the server in HTTP mode on a public interface without a
  reverse proxy that terminates TLS and enforces the multi-tenant header
  contract documented in `docs/multi-tenant.md`.
- Keep the bundled fallback spec under version control; do not load it from
  an untrusted location.
