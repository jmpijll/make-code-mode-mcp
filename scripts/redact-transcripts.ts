#!/usr/bin/env tsx
/**
 * Redact personal data from verification transcripts before publishing.
 *
 * Replaces:
 *   - Make.com user / org / team IDs the caller supplies via env or 1Password
 *   - Email addresses (RFC-5322 simplified)
 *   - The configured user's full name (case-insensitive, word-boundary)
 *   - Gravatar avatar URLs (MD5 hash leaks the email)
 *
 * Idempotent — safe to re-run on already-redacted files.
 *
 * Inputs are read from env:
 *   REDACT_USER_ID    (single Make user id)     → 9999999
 *   REDACT_ORG_IDS    (comma-separated)         → 9999000
 *   REDACT_TEAM_IDS   (comma-separated)         → 8888000
 *   REDACT_USER_NAME  ("First Last")            → "Example User"
 *   REDACT_ORG_NAMES  (comma-separated)         → "example-org-N"
 *   REDACT_PATHS      (comma-separated dirs)    → posix paths are rewritten to /home/user/...
 *
 * The script also performs zero-config replacements:
 *   - Any email address                          → user@example.com
 *   - Gravatar /avatar/<32-hex-md5>              → /avatar/<redacted-gravatar-hash>
 *
 * Run:
 *   tsx scripts/redact-transcripts.ts             # redacts every file in out/verification/
 *   tsx scripts/redact-transcripts.ts FILE [...]  # redacts only the given files
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

interface RedactionPair {
  pattern: RegExp;
  replacement: string;
}

function pairs(): RedactionPair[] {
  const out: RedactionPair[] = [];

  // Email — apply first so name redaction below doesn't dirty the local-part.
  out.push({
    pattern: /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g,
    replacement: 'user@example.com',
  });

  // Gravatar avatar hash leaks email even when the email is redacted.
  out.push({
    pattern: /\/avatar\/[a-f0-9]{32}/gi,
    replacement: '/avatar/<redacted-gravatar-hash>',
  });

  const userId = process.env['REDACT_USER_ID'];
  if (userId) {
    out.push({ pattern: literalRegex(userId), replacement: '9999999' });
  }

  for (const id of splitCsv(process.env['REDACT_ORG_IDS'])) {
    out.push({ pattern: literalRegex(id), replacement: '9999000' });
  }
  for (const id of splitCsv(process.env['REDACT_TEAM_IDS'])) {
    out.push({ pattern: literalRegex(id), replacement: '8888000' });
  }

  const userName = process.env['REDACT_USER_NAME'];
  if (userName) {
    out.push({
      pattern: new RegExp(`\\b${escapeRegex(userName)}\\b`, 'gi'),
      replacement: 'Example User',
    });
  }

  let orgIdx = 0;
  for (const name of splitCsv(process.env['REDACT_ORG_NAMES'])) {
    orgIdx += 1;
    out.push({
      pattern: new RegExp(`\\b${escapeRegex(name)}\\b`, 'gi'),
      replacement: `example-org-${String(orgIdx)}`,
    });
  }

  for (const path of splitCsv(process.env['REDACT_PATHS'])) {
    const normalised = path.endsWith('/') ? path : `${path}/`;
    out.push({
      pattern: new RegExp(escapeRegex(normalised), 'g'),
      replacement: '/home/user/',
    });
  }

  return out;
}

function splitCsv(v: string | undefined): string[] {
  if (!v) return [];
  return v
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function literalRegex(s: string): RegExp {
  return new RegExp(`\\b${escapeRegex(s)}\\b`, 'g');
}

function redact(content: string, rules: RedactionPair[]): string {
  let out = content;
  for (const { pattern, replacement } of rules) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

function targets(args: string[]): string[] {
  if (args.length > 0) return args;
  const dir = resolve(process.cwd(), 'out/verification');
  const entries = readdirSync(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && (e.name.endsWith('.txt') || e.name.endsWith('.json')))
    .map((e) => join(dir, e.name));
}

function main(): void {
  const rules = pairs();
  if (rules.length === 0) {
    console.error(
      '[redact] no rules configured. Set REDACT_USER_ID / REDACT_ORG_IDS / etc. — see header comment.',
    );
    process.exit(2);
  }

  const files = targets(process.argv.slice(2));
  let changed = 0;
  for (const file of files) {
    const stat = statSync(file);
    if (!stat.isFile()) continue;
    const before = readFileSync(file, 'utf-8');
    const after = redact(before, rules);
    if (after !== before) {
      writeFileSync(file, after);
      changed += 1;
      console.error(`[redact] rewrote ${file}`);
    }
  }
  console.error(`[redact] ${String(changed)}/${String(files.length)} files modified`);
}

main();
