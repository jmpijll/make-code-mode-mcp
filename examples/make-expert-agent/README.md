# Make.com expert agent — example persona

A drop-in persona + skill bundle that turns any MCP-capable AI agent into a senior Make.com automation engineer driving the [`make-code-mode-mcp`](../..) server. Designed for **testers** who want to wire this MCP into their preferred client and report back what works.

## Status

This persona is **beta**, alongside the server itself. We've smoke-tested the persona instructions with DeepSeek v4 Flash through opencode; we haven't tested it with other models. If you do — even just once with the sample prompts — open an issue with your transcript. Both successes and failures are useful.

## What's in this directory

| File | What it does | When to copy / link it |
|---|---|---|
| [`AGENTS.md`](AGENTS.md) | The persona itself: who the agent is, how it operates, what guardrails it follows. Designed to be loaded as a system prompt or as the agent's `AGENTS.md`. | Always — this is the headline file. |
| [`SKILL.md`](SKILL.md) | A condensed, recipe-driven companion to the root [`SKILL.md`](../../SKILL.md). Explains the 2-tool / 1-surface pattern in the persona's terms and links to recipes. | When your agent has a separate "skill" or "instructions" slot, or you're feeding both files into a single combined system prompt. |
| [`install.md`](install.md) | Cross-platform install snippets (Cursor IDE, opencode, Claude Code, Claude Desktop, VS Code + Copilot, Codex CLI, Continue, Cline, MCP Inspector). | Whenever you want to wire the server up. Each platform is clearly marked **VERIFIED** or **NOT-VERIFIED**. |
| [`SAMPLE_PROMPTS.md`](SAMPLE_PROMPTS.md) | Prompts to test the persona with — inventory, audit, scenario investigation, troubleshooting, and one prompt designed to surface scope errors. | Whenever you've installed the server and want to validate the bundle. |

## Quick start

1. **Install the MCP server.** From the repo root:

   ```bash
   git clone https://github.com/jmpijll/make-code-mode-mcp.git
   cd make-code-mode-mcp
   npm install
   cp .env.example .env
   # set MAKE_API_KEY (mint a token at https://eu1.make.com/profile/api)
   npm run build
   ```

2. **Wire it into your agent.** Pick your platform from [`install.md`](install.md) and follow the snippet. For most platforms, it's a one-line stdio entry pointing at `node dist/index.js`.

3. **Adopt the persona.** Either:
   - Set [`AGENTS.md`](AGENTS.md) as the agent's system prompt, **or**
   - Copy `AGENTS.md` into your agent's persona / instructions slot (`.cursor/rules/`, `.claude/CLAUDE.md`, `AGENTS.md` for Codex, `.opencode/agent/<name>.md`, etc. — see install.md for paths).

4. **Run a sample prompt.** Try one from [`SAMPLE_PROMPTS.md`](SAMPLE_PROMPTS.md). The first one ("Inventory my Make.com workspace") is read-only and works against any token with `user:read`, `organization:read`, and `team:read` scopes.

5. **Tell us what happened.** Open an issue with the transcript — even one-line "it worked" reports are useful.

## Why a separate persona?

The root `AGENTS.md` is for **contributors editing the server**. The root `SKILL.md` is for **any** MCP client driving the server, vendor-neutral and exhaustive. This directory adds a third layer: an opinionated **Make.com automation expert persona** with a fixed mental model, default workflow, and specific guardrails (read-only by default, ask before mutations, scope-error literacy).

## Honest expectations

- This persona will be wrong sometimes. It is a beta on a beta.
- The server itself is honest about what's verified — see the [Verification status](../../README.md#verification-status) table. The persona inherits those caveats and refuses to confidently mutate things on unverified surfaces without asking you first.
- If you build on this persona and ship it elsewhere, please link back here so the next tester can find their way to the issue tracker.

## License

MIT, same as the rest of the repo.
