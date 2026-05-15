#!/usr/bin/env tsx
/**
 * Live smoke test against the Make.com Web API v2.
 *
 * READ-ONLY. Drives the make.* sandbox surface end-to-end:
 *   1. GET /users/me                — almost always allowed
 *   2. GET /organizations           — needs `organization:read`
 *   3. GET /teams?organizationId=…  — needs `team:read`
 *
 * Credentials (priority: env > 1Password):
 *   MAKE_API_KEY     (or 1Password ref via OP_MAKE_REF)
 *   MAKE_BASE_URL    defaults to https://eu1.make.com/api/v2
 *
 * 1Password reference (default):
 *   OP_MAKE_REF = op://AI Agents/Make.com API Key Full Access/credential
 *
 * Run:
 *   npm run live-test
 */

import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { loadMakeSpec } from '../src/spec/loader.js';
import { ExecuteExecutor } from '../src/sandbox/execute-executor.js';
import { buildContextFromEnv } from '../src/tenant/context.js';

const OP_MAKE_REF =
  process.env['OP_MAKE_REF'] ?? 'op://AI Agents/Make.com API Key Full Access/password';

const DEFAULT_BASE_URL = 'https://eu1.make.com/api/v2';

function safeOpRead(ref: string): string | undefined {
  try {
    const out = execSync(`op read ${JSON.stringify(ref)}`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

function getCreds(): { baseUrl: string; apiKey: string } {
  const baseUrl = process.env['MAKE_BASE_URL'] ?? DEFAULT_BASE_URL;
  const fromEnv = process.env['MAKE_API_KEY'];
  const apiKey = fromEnv ?? safeOpRead(OP_MAKE_REF);
  if (!apiKey) {
    throw new Error(
      `No Make API key — set MAKE_API_KEY or store one at ${OP_MAKE_REF} (1Password CLI: 'op read').`,
    );
  }
  return { baseUrl, apiKey };
}

async function main(): Promise<void> {
  const creds = getCreds();
  console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.error(`[live] target=${creds.baseUrl}`);

  const spec = await loadMakeSpec({
    baseUrl: creds.baseUrl,
    apiKey: creds.apiKey,
    cacheDir: resolve(process.cwd(), 'src/spec/cache'),
    onWarn: (m) => {
      console.error(`[live][warn] ${m}`);
    },
  });
  console.error(
    `[live] spec=${spec.title} v${spec.version} (${String(spec.operations.length)} ops)`,
  );

  const tenant = buildContextFromEnv({
    MAKE_BASE_URL: creds.baseUrl,
    MAKE_API_KEY: creds.apiKey,
  });
  const exec = new ExecuteExecutor({
    tenant,
    spec,
    limits: { maxCallsPerExecute: 20, timeoutMs: 60_000 },
  });

  const code = `
    var snapshot = { generatedAt: new Date().toISOString() };

    try {
      var me = make.request({ method: 'GET', path: '/users/me' });
      snapshot.user = me;
    } catch (e) {
      snapshot.userError = String(e);
    }

    try {
      var orgs = make.request({ method: 'GET', path: '/organizations' });
      snapshot.organizations = orgs;
    } catch (e) {
      snapshot.organizationsError = String(e);
    }

    snapshot.teamsByOrg = [];
    try {
      var orgList = (snapshot.organizations && snapshot.organizations.organizations) || [];
      for (var i = 0; i < Math.min(orgList.length, 3); i++) {
        var org = orgList[i];
        try {
          var teams = make.request({
            method: 'GET',
            path: '/teams',
            query: { organizationId: org.id }
          });
          snapshot.teamsByOrg.push({ organizationId: org.id, teams: teams });
        } catch (e) {
          snapshot.teamsByOrg.push({ organizationId: org.id, error: String(e) });
        }
      }
    } catch (e) {
      snapshot.teamsError = String(e);
    }

    snapshot;
  `;

  console.error('[live] running sandbox sweep…');
  const t0 = Date.now();
  const result = await exec.execute(code);
  const elapsed = Date.now() - t0;
  console.error(
    `[live] sandbox done in ${String(elapsed)}ms — ok=${String(result.ok)} calls=${String(result.callsMade)}`,
  );

  console.error('[live] result:');
  console.error(JSON.stringify(result, null, 2));

  if (!result.ok) process.exit(1);
}

main().catch((err: unknown) => {
  console.error('[live] FAILED:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
