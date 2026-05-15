# Contributing to `make-code-mode-mcp`

Thanks for your interest! This file is the contributor-side counterpart to
the operator-facing [`README.md`](README.md) and the agent-facing
[`AGENTS.md`](AGENTS.md). Read `AGENTS.md` first — it captures the
architectural invariants that PRs are gated on.

## Quick start

```bash
git clone https://github.com/jmpijll/make-code-mode-mcp.git
cd make-code-mode-mcp
npm install
cp .env.example .env
# Edit .env: set MAKE_API_KEY (and optionally MAKE_BASE_URL).
npm run typecheck
npm test
```

## Required checks before opening a PR

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run lint        # eslint
npm run format:check
npm run build       # tsc → dist/
```

All five must be green. CI runs the same set on Node 22.

## Conventional Commits

Use [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/):

```text
feat(loader): add hash-keyed cache invalidation
fix(http): preserve scope hint on 403
docs(skill): add scenarios recipe
chore: bump @cloudflare/codemode to 0.3.5
```

One logical change per commit. Don't bump dependencies in unrelated commits.

## Verification before merge

Before claiming "this works with client X", check the
[Verification status table](README.md#verification-status) and add your run
to it. The contract is **evidence before assertions** — only what we
actually executed and captured a transcript for goes in the table.

## Pull request shape

- Title: `<type>(<scope>): <imperative summary>`
- Body: one short paragraph of context, then a bulleted list of changes.
- Link the issue if there is one.
- If your PR adds a sandbox-visible API, update
  [`SKILL.md`](SKILL.md) and at least one of `examples/make-expert-agent/*`
  in the same PR.

## Things we don't accept

- New MCP tools beyond `search` + `execute`. The whole point of code-mode is
  one entrypoint per tool kind. See [`AGENTS.md` §2](AGENTS.md#2-architecture-invariants--do-not-break-these).
- Credential reads inside the sandbox. The TenantContext lives on the host
  and stays there.
- Vendored copies of Make's OpenAPI spec other than the single snapshot at
  `src/spec/make-fallback.json` produced by `npm run update-spec`.
