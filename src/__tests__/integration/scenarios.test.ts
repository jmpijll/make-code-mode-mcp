/**
 * End-to-end MCP integration scenarios.
 *
 * Each scenario runs the real createMcpServer() against an in-process MCP
 * Client and a mock Make.com controller. Both transports — InMemoryTransport
 * (linked pair) and Streamable HTTP — are exercised, so the wire format
 * round-trip is fully covered.
 *
 * Scenarios:
 *   A) "Discover → sweep"          — search → execute that fans across endpoints.
 *   B) "Scope-aware 403"           — call an admin endpoint, assert the scope
 *                                    hint is surfaced in the error text.
 *   C) "Intentionally impossible"  — execute with a bogus operationId; assert
 *                                    the structured error prefix is informative.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  setupHarness,
  toolResultText,
  TEST_API_KEY,
  type Harness,
  type TransportMode,
} from './harness.js';
import { ORG_ID, ORGANIZATIONS_PAGE, SCENARIOS_PAGE, SCENARIO_ID } from './fixtures/make-canned.js';

const TRANSPORT_MODES: TransportMode[] = ['memory', 'http'];

interface ToolContent {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

async function callTool(
  harness: Harness,
  name: 'search' | 'execute',
  code: string,
): Promise<ToolContent> {
  return (await harness.client.callTool({ name, arguments: { code } })) as ToolContent;
}

describe.each(TRANSPORT_MODES)('integration (%s transport)', (mode) => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await setupHarness({ mode });
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it('lists the two tools after handshake', async () => {
    const tools = await harness.client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual(['execute', 'search']);
  });

  // ─── Scenario A — discover then sweep ─────────────────────────────

  it('A: discovers operations and fans out a multi-call execute()', async () => {
    const search = await callTool(
      harness,
      'search',
      `searchOperations('user', 5).map(function (o) { return o.operationId; })`,
    );
    expect(search.isError).toBeFalsy();
    expect(toolResultText(search)).toContain('getUser');

    const code = `
      var me = make.callOperation('getUser', {});
      var orgs = make.callOperation('getOrganizations', {});
      var teams = make.callOperation('getTeams', { organizationId: ${String(ORG_ID)} });
      var scenario = make.callOperation('getScenario', { scenarioId: ${String(SCENARIO_ID)} });
      ({
        userName: me.name,
        orgCount: orgs.organizations.length,
        teamCount: teams.teams.length,
        scenarioName: scenario.scenario.name,
      });
    `;

    const exec = await callTool(harness, 'execute', code);
    expect(exec.isError).toBeFalsy();
    const text = toolResultText(exec);
    expect(text).toContain('"userName": "Jane Tester"');
    expect(text).toContain(`"orgCount": ${String(ORGANIZATIONS_PAGE.organizations.length)}`);
    expect(text).toContain(`"scenarioName": "${SCENARIOS_PAGE.scenarios[0]?.name ?? '?'}"`);

    const calls = harness.controller.requests.map(
      (r) => `${r.method} ${r.path.split('?')[0] ?? ''}`,
    );
    expect(calls).toContain('GET /users/me');
    expect(calls).toContain('GET /organizations');
    expect(calls).toContain(`GET /organizations/${String(ORG_ID)}/teams`);
    expect(calls).toContain(`GET /scenarios/${String(SCENARIO_ID)}`);
  });

  // ─── Scenario B — scope-aware 403 ─────────────────────────────────

  it('B: surfaces required scope hint on 403', async () => {
    const code = `
      (async function() {
        try {
          return await make.callOperation('listOwners', {});
        } catch (err) {
          return String(err);
        }
      })()
    `;
    const exec = await callTool(harness, 'execute', code);
    expect(exec.isError).toBeFalsy();
    const text = toolResultText(exec);
    expect(text).toMatch(/make\.http/);
    expect(text).toContain('403');
    expect(text).toContain('admin:read');
  });

  // ─── Scenario C — intentionally impossible ────────────────────────

  it('C: a bogus operationId surfaces a structured, informative error', async () => {
    const code = `
      try {
        make.callOperation('totallyMadeUpOperation', {});
        ({ unexpected: true });
      } catch (e) {
        ({ caught: String(e) });
      }
    `;

    const exec = await callTool(harness, 'execute', code);
    expect(exec.isError).toBeFalsy();
    const text = toolResultText(exec);
    expect(text).toContain('"caught"');
    expect(text.toLowerCase()).toMatch(
      /unknown operation|operation not found|no operation|make\.unknown-operation/,
    );
  });
});

// ─── HTTP-only assertion: per-request header propagation ────────────

describe('integration (http transport — header propagation)', () => {
  it('refuses calls when X-Make-Api-Key is missing', async () => {
    // We deliberately pass no API key header. The base-url header alone is
    // not enough; the tenant resolver should return an empty context and
    // the executor should refuse with a missing-credentials error.
    const harness = await setupHarness({
      mode: 'http',
      headers: { 'X-Make-Base-Url': 'http://127.0.0.1:1/api/v2' },
    });

    try {
      const exec = (await harness.client.callTool({
        name: 'execute',
        arguments: {
          code: `(async function() { try { return await make.callOperation('getUser', {}); } catch (e) { return String(e); } })()`,
        },
      })) as ToolContent;
      expect(exec.isError).toBeFalsy();
      const text = toolResultText(exec);
      expect(text.toLowerCase()).toMatch(/missing-credentials|make_api_key|x-make-api-key/);
    } finally {
      await harness.cleanup();
    }
    // Reference TEST_API_KEY so linters don't complain about unused imports
    // in test files where every other suite uses it.
    void TEST_API_KEY;
  });
});
