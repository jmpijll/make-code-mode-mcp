<!-- Thanks for the PR! A couple of asks before you click "Create" -->

## What changed

<!-- One or two sentences. Link the issue if there is one. -->

## Verification

<!--
Before opening this PR you should have run, at minimum:
  npm run typecheck
  npm run lint
  npm test
  npm run build
Paste the relevant tails or check the box.
-->

- [ ] `npm run typecheck` clean
- [ ] `npm run lint` clean
- [ ] `npm test` — total / passing
- [ ] `npm run build` succeeds
- [ ] If the change is user-facing, the relevant doc was updated (README / AGENTS / SKILL / docs/*).
- [ ] If verification scope changed, the **Verification status** table in `README.md` was updated in the same PR (no silent widening of "verified").

## Make.com tenant data

- [ ] No real user IDs, org IDs, team IDs, email addresses, or scenario blueprints leak into committed transcripts. (Run `scripts/redact-transcripts.ts` if you regenerated anything in `out/verification/`.)

## Notes for reviewers

<!-- Anything subtle, surprising, or worth a second pair of eyes? -->
