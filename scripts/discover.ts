#!/usr/bin/env tsx
/**
 * Comprehensive read-only discovery of a Make.com tenant.
 *
 * Drives the make.* sandbox surface end-to-end and writes a JSON
 * snapshot to out/ for offline analysis. Read-only; no mutations and
 * never consumes Make.com "operations" — only scenario runs do that.
 *
 * Probed surface (per org / team where applicable):
 *   /users/me
 *   /users/me/current-authorization                  (token scope inventory)
 *   /organizations
 *   /teams?organizationId=…
 *   /sdk/apps
 *   /audit-logs/organization/{organizationId}        (requires admin scope)
 *   /audit-logs/team/{teamId}                        (requires admin scope)
 *   /scenarios?teamId=…
 *   /connections?teamId=…
 *   /data-stores?teamId=…
 *   /hooks?teamId=…
 *   /admin/owners                                    (probe — VPN-gated 403 expected)
 *
 * Credentials (priority: env > 1Password):
 *   MAKE_API_KEY     (or 1Password ref via OP_MAKE_REF)
 *   MAKE_BASE_URL    defaults to https://eu1.make.com/api/v2
 *
 * Usage:
 *   tsx scripts/discover.ts
 */

import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
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
  console.error(`[discover] target=${creds.baseUrl}`);

  const spec = await loadMakeSpec({
    baseUrl: creds.baseUrl,
    apiKey: creds.apiKey,
    cacheDir: resolve(process.cwd(), 'src/spec/cache'),
    onWarn: (m) => {
      console.error(`[discover][warn] ${m}`);
    },
  });
  console.error(
    `[discover] spec=${spec.title} v${spec.version} (${String(spec.operations.length)} ops)`,
  );

  const tenant = buildContextFromEnv({
    MAKE_BASE_URL: creds.baseUrl,
    MAKE_API_KEY: creds.apiKey,
  });
  const exec = new ExecuteExecutor({
    tenant,
    spec,
    limits: { maxCallsPerExecute: 200, timeoutMs: 120_000 },
  });

  const code = `
    var snapshot = { generatedAt: new Date().toISOString() };

    function safeGet(path, query) {
      try {
        var args = { method: 'GET', path: path };
        if (query) args.query = query;
        return { ok: true, data: make.request(args) };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    }

    snapshot.user = safeGet('/users/me');
    snapshot.authorization = safeGet('/users/me/current-authorization');
    snapshot.adminOwnersProbe = safeGet('/admin/owners');
    snapshot.sdkApps = safeGet('/sdk/apps');

    var orgs = [];
    var orgRes = safeGet('/organizations');
    snapshot.organizations = orgRes;
    if (orgRes.ok && orgRes.data && orgRes.data.organizations) {
      orgs = orgRes.data.organizations;
    }

    snapshot.byOrganization = [];
    for (var i = 0; i < orgs.length; i++) {
      var org = orgs[i];
      var entry = {
        organizationId: org.id,
        name: org.name,
        zone: org.zone,
        teams: [],
        auditLogs: null
      };

      var teamRes = safeGet('/teams', { organizationId: org.id });
      var teamList = (teamRes.ok && teamRes.data && teamRes.data.teams) || [];

      entry.auditLogs = safeGet(
        '/audit-logs/organization/' + org.id,
        { pg: { limit: 5 } }
      );

      for (var j = 0; j < teamList.length; j++) {
        var team = teamList[j];
        var teamSummary = { teamId: team.id, name: team.name };

        teamSummary.scenarios = safeGet('/scenarios', { teamId: team.id, pg: { limit: 25 } });
        teamSummary.connections = safeGet('/connections', { teamId: team.id, pg: { limit: 25 } });
        teamSummary.dataStores = safeGet('/data-stores', { teamId: team.id, pg: { limit: 25 } });
        teamSummary.hooks = safeGet('/hooks', { teamId: team.id, pg: { limit: 25 } });
        teamSummary.auditLogs = safeGet(
          '/audit-logs/team/' + team.id,
          { pg: { limit: 5 } }
        );

        entry.teams.push(teamSummary);
      }

      snapshot.byOrganization.push(entry);
    }

    snapshot;
  `;

  console.error('[discover] running sandbox traversal…');
  const t0 = Date.now();
  const result = await exec.execute(code);
  const elapsed = Date.now() - t0;
  console.error(
    `[discover] sandbox done in ${String(elapsed)}ms — ok=${String(result.ok)} calls=${String(result.callsMade)}`,
  );

  if (!result.ok) {
    console.error(`[discover] sandbox error: ${String(result.error)}`);
    process.exit(1);
  }

  const outDir = resolve(process.cwd(), 'out');
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = resolve(outDir, `make-discovery-${stamp}.json`);
  writeFileSync(outPath, JSON.stringify(result.data, null, 2));
  console.error(`[discover] wrote ${outPath}`);

  interface ProbeResult {
    ok?: boolean;
    error?: string;
    data?: Record<string, unknown>;
  }
  interface TeamProbe {
    teamId?: number;
    name?: string;
    scenarios?: ProbeResult;
    connections?: ProbeResult;
    dataStores?: ProbeResult;
    hooks?: ProbeResult;
    auditLogs?: ProbeResult;
  }
  interface OrgProbe {
    organizationId?: number;
    name?: string;
    zone?: string;
    teams: TeamProbe[];
    auditLogs?: ProbeResult;
  }
  interface Snapshot {
    user?: ProbeResult;
    authorization?: ProbeResult;
    adminOwnersProbe?: ProbeResult;
    sdkApps?: ProbeResult;
    organizations?: ProbeResult;
    byOrganization?: OrgProbe[];
  }
  const data = result.data as Snapshot;

  const userData = data.user?.data?.['authUser'] as { email?: string; name?: string } | undefined;
  if (userData) {
    console.error(`[discover] user=${userData.email ?? userData.name ?? '(unknown)'}`);
  }

  const scopeData = data.authorization?.data?.['authorization'] as { scope?: string[] } | undefined;
  if (scopeData?.scope) {
    console.error(`[discover] token scopes=${String(scopeData.scope.length)}`);
  }

  function describeProbe(probe?: ProbeResult): string {
    if (!probe) return '(skipped)';
    if (probe.ok) {
      const keys = probe.data ? Object.keys(probe.data) : [];
      return `ok keys=[${keys.join(', ')}]`;
    }
    return `fail "${(probe.error ?? '').replace(/^Error:\s*/, '').slice(0, 80)}"`;
  }

  console.error(`[discover] adminOwnersProbe ${describeProbe(data.adminOwnersProbe)}`);
  console.error(`[discover] sdkApps ${describeProbe(data.sdkApps)}`);

  for (const org of data.byOrganization ?? []) {
    const teamCount = org.teams.length;
    let scenarioCount = 0;
    let connectionCount = 0;
    let dataStoreCount = 0;
    let hookCount = 0;
    for (const t of org.teams) {
      const sc = t.scenarios?.data?.['scenarios'] as unknown[] | undefined;
      const cn = t.connections?.data?.['connections'] as unknown[] | undefined;
      const ds = t.dataStores?.data?.['dataStores'] as unknown[] | undefined;
      const hk = t.hooks?.data?.['hooks'] as unknown[] | undefined;
      if (sc) scenarioCount += sc.length;
      if (cn) connectionCount += cn.length;
      if (ds) dataStoreCount += ds.length;
      if (hk) hookCount += hk.length;
    }
    console.error(
      `[discover]   org="${String(org.name)}" teams=${String(teamCount)} scenarios=${String(scenarioCount)} connections=${String(connectionCount)} dataStores=${String(dataStoreCount)} hooks=${String(hookCount)}`,
    );
    console.error(`[discover]     org auditLogs ${describeProbe(org.auditLogs)}`);
    for (const t of org.teams) {
      console.error(
        `[discover]     team "${String(t.name)}" auditLogs ${describeProbe(t.auditLogs)}`,
      );
    }
  }
}

main().catch((err: unknown) => {
  console.error('[discover] FAILED:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
