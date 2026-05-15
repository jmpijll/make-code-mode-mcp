/**
 * Canned response bodies for the mock Make.com controller.
 */

export const ORG_ID = 7;
export const TEAM_ID = 42;
export const SCENARIO_ID = 1234;

export const USER_ME = {
  id: 99,
  name: 'Jane Tester',
  email: 'jane@example.test',
  language: 'en',
};

export const ORGANIZATIONS_PAGE = {
  organizations: [
    { id: ORG_ID, name: 'Acme Automations' },
    { id: 8, name: 'Other Org (out of scope)' },
  ],
};

export const TEAMS_PAGE = {
  teams: [
    { id: TEAM_ID, name: 'Marketing Ops' },
    { id: 43, name: 'Sales Ops' },
  ],
};

export const SCENARIOS_PAGE = {
  scenarios: [
    { id: SCENARIO_ID, name: 'Send invoice on payment', isPaused: false },
    { id: 1235, name: 'Notify on new lead', isPaused: true },
  ],
};

export const SCENARIO_DETAIL = {
  scenario: {
    id: SCENARIO_ID,
    name: 'Send invoice on payment',
    isPaused: false,
    teamId: TEAM_ID,
    description: 'On webhook from Stripe, render PDF, email to customer.',
  },
};

export const ADMIN_FORBIDDEN = {
  status: 403,
  body: {
    message: 'Insufficient scope: admin:read',
    code: 'IM003',
    detail: 'free token lacks admin scopes',
  },
};
