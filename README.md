# Computer-Use Automation System

This is a focused vertical slice for the Interface.ai take-home. It discovers a workflow on a deliberately hostile, server-rendered member-servicing UI, records a typed capability, replays it without model decisions, handles expected and exceptional states, and pauses the *same session* for a human when needed.

The target is a local fake bank application with table-heavy markup, unstable-looking element IDs, no test IDs, and server-rendered pages. It contains only synthetic member data. The adapter used in the repeatable test path drives its HTML form UI over HTTP; an optional Playwright adapter drives the same UI in a real Chromium page. Both implement the same `ComputerSurface` seam.

## Quick start

Requirements: Node 20+ (Node 24 used for development). There are no required runtime packages for the deterministic demo or tests.

```bash
npm test
npm run demo:evidence
npm run demo:fixture
npm run demo:replay
npm run demo:replay:not-found
npm run demo:handoff
```

`demo:evidence` recreates the checked-in offline evidence using a recorded planner fixture, not a hidden model call. The fixture exists so reviewers can execute the full vertical slice with no credentials and receive repeatable results.

## A genuine LLM-driven discovery run

The production path is `OpenAIResponsesPolicy`, which sends only the goal, a redacted UI observation, permitted actions, and the action JSON schema to the configured model. It takes one action per turn; the artifact is recorded by the executor rather than copied from the model transcript.

```bash
export OPENAI_API_KEY='...'
export OPENAI_MODEL='gpt-5.6' # optional
npm run demo:live
```

That launches the local app, runs the LLM-driven observe -> decide -> act loop against its live server-rendered surface, and writes a redacted artifact, JSONL journal, and HTML failure/success snapshot to `evidence/live/`. No key, model response, cookie, raw member number, or balance is written to the artifact or journal.

To exercise a browser rather than the protocol-level legacy adapter:

```bash
npm install
npx playwright install chromium
export OPENAI_API_KEY='...'
npm run demo:live-browser
```

The browser adapter is optional so this submission remains runnable in a restricted/offline environment. It uses accessibility/name locators first and a legacy form-control fallback; the recording format does not contain a Playwright selector.

## Demo path

1. Discovery goal: `Look up member {{memberId}} and return the current savings balance.`
2. The planner opens `/members`, types the parameter in `member_no`, clicks `Find member`, and extracts the labeled balance.
3. The recorder emits `evidence/capabilities/read-savings-balance.v1.json`.
4. Replay invokes that artifact without importing or calling an LLM:

```bash
node src/cli.js replay \
  --artifact=evidence/capabilities/read-savings-balance.v1.json \
  --memberId=M-1042
```

5. A replay with `M-404` returns `{ kind: "business_outcome", code: "member_not_found" }`; it is not a crash.
6. A replay with `M-TIMEOUT` creates an intervention request. The mock operator takes and resumes the exact same `surfaceSessionId`; its actions are appended to the handoff transcript.

## Repository map

| Path | Purpose |
| --- | --- |
| `src/localLegacyApp.js` | Synthetic server-rendered, table-based target application. |
| `src/surfaces.js` | Surface contract plus HTTP and optional Playwright implementations. |
| `src/policies.js` | Recorded fixture and OpenAI Responses JSON planner. |
| `src/discovery.js` | Observe -> decide -> guard -> act -> record loop. |
| `src/replay.js` | Model-free deterministic executor and outcome/error handling. |
| `src/handoff.js` | Same-session ownership transfer and minimal operator facade. |
| `src/core.js` | Capability validation, guardrails, redaction, journaling, and schemas. |
| `evidence/` | Redacted capability, run journals, results, snapshots, and handoff transcript. |
| `REPORT.md` | Required design write-up. |

## Safety model

- Every action is evaluated against the capability allowlist (origin, route, action type, and risk tier) before it reaches the surface.
- `submit` / irreversible actions are blocked by default. A capability can declare a separate, audited approval gate; the demo only performs reversible member lookup actions.
- The recorder refuses literal input values for sensitive fields and stores parameter templates such as `{{memberId}}` instead.
- Journals and snapshots are redacted before persistence. The caller may receive a declared output at runtime, but the evidence stream stores `[REDACTED]` rather than the balance or member number.
- An artifact must be `approved` before unattended replay. Discovery creates a draft; the sample fixture artifact carries a deliberately explicit demo approval marker so the replay path is runnable.

## Tests

`node --test` covers the end-to-end discovery/record/replay path, the not-found business outcome, transient recovery, session-expiry handoff, artifact validation, route allowlisting, risk blocking, and redaction. Tests start the local app on an ephemeral port and do not make network calls.

## Deliberate cuts

There is no persistent database, queue, credential vault, operator authentication UI, or production browser farm. Those are documented in `REPORT.md`; the implementation keeps seams for them rather than faking scale.
# Assignment_interface.ai
