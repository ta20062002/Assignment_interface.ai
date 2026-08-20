# Design write-up

## 1. Architecture

The system has five small boundaries: `ComputerSurface`, planner, discovery recorder, deterministic replay executor, and handoff broker. `ComputerSurface` exposes observations, actions, condition detection, evidence capture, and a session identity. The demo has an HTTP/form adapter for a server-rendered legacy UI and an optional Playwright implementation for a real browser page; neither leaks its locator implementation into the recorded capability. The planner has one action per turn and never touches a surface directly. Discovery validates a proposed action, executes it, journals redacted evidence, and records the executor's normalized action. Replay consumes only the artifact and inputs, never imports a planner.

This is intentionally a single Node process. The durable seams are more valuable here than premature queues or services: a production deployment would put capability versions in a signed registry, journals/snapshots in a restricted evidence store, and run/session state in a durable workflow engine.

## 2. Artifact schema

`schemas/capability.schema.json` describes a versioned capability contract. An artifact has: identity/version/approval; a surface fingerprint; tenant compatibility scope; typed input/output definitions; policy; ordered steps; success predicates; and a three-class outcome catalogue. A target is a ranked set of semantic locators, for example accessible role/name followed by a legacy form action/control-name fallback. This is reviewable and survives an adapter change because it is a description of the *control*, not a raw selector.

The recorder owns the artifact. The model can suggest a target/action but cannot inject a transcript or arbitrary JavaScript into a reusable capability. Sensitive input values are converted to parameter references before serialization. The artifact is initially `draft`; approved status is an explicit replay gate. The checked-in demo artifact has a clearly named synthetic approval only to make the offline example runnable.

## 3. Determinism & error handling

Replay validates input types, approval state, route/action policy, locator resolution, post-step checkpoints, and final success predicates. It selects the first locator that resolves exactly one current control; a missing or ambiguous target is a debuggable failure, not a heuristic click. It uses bounded waits and records expected/observed state for each failed assertion.

The error taxonomy matters more than UI drift. `member_not_found` is a business outcome returned to the caller. `transient_loading` is recoverable: the artifact declares a bounded wait/retry. `session_expired`, validation/permission errors, unexpected dialogs, ambiguous locators, and checkpoint failures are hard failures. A hard failure emits a redacted HTML snapshot and, when configured, creates an intervention request. UI drift is intentionally secondary: the surface fingerprint and locator diagnostics make it visible and support a controlled re-record/specialization workflow rather than allowing an open-ended model repair in production.

## 4. Heterogeneity & multi-tenant

The capability refers to `ComputerSurface` operations (`navigate`, `type`, `click`, `extract`, `wait`) and portable semantic locators. A modern web adapter may resolve a role/name with the accessibility tree; a hostile web adapter can use label/form/control metadata; a desktop adapter can resolve UI Automation roles or image anchors. Screenshot coordinates are a last-ranked locator with a visual fingerprint and confidence threshold, not the primary identity of a control.

Artifacts are attached to a vendor-family compatibility key, app version/fingerprint, and tenant override layer. A base capability can hold vendor-wide semantics while a tenant overlay adds route aliases, localized labels, or a replacement locator candidate. Replay reports the observed fingerprint and locator diagnostics. A registry can then measure stability by tenant/version, approve a specialization when needed, and refuse unattended execution outside a compatible range. It is safer than silently applying a recording from one credit union to a cosmetically similar tenant.

## 5. Escalation & handoff

The handoff broker is not a new session. On a hard failure it retains the existing surface object, cookie/session state, journal correlation id, redacted snapshot, current step, and reason. It creates an intervention request with `surfaceSessionId`, then transfers an ownership token from `automation` to `human`. The minimal operator facade executes manual actions against that same surface and appends attributed entries to the request. `resume` returns ownership to automation only after the human has taken control; the session id is checked in tests and evidence.

In a production browser deployment, the same broker would mint a time-bound remote-browser/operator URL bound to the existing browser context, authenticate the operator, stream video/input audit events, and use a lease/heartbeat to prevent simultaneous control. The deliberately small console proves the important state-machine seam without pretending to ship co-browsing.

## 6. Safety

Guardrails are enforced before both discovery and replay actions: approved origin/route, permitted action class, and risk tier. Read/navigation/type/click actions used in the member lookup are safe/reversible. `submit` and irreversible state-changing controls are blocked unless a separate explicit approval policy is satisfied; a discoverer cannot self-authorize a risky capability. The demo has no credentials or real customer data. Redaction occurs before JSONL/snapshot persistence, artifacts contain parameter references rather than literal sensitive input, and the OpenAI planner receives only redacted observations. Runtime outputs are returned only through the declared contract, not copied into evidence.

The important limitation is that redaction is defense in depth, not a substitute for a credential vault, least-privilege browser profiles, tenant isolation, encryption/access-controlled evidence storage, DLP, and human approval of capabilities. Those would be mandatory for a financial deployment.

## 7. Cuts

I deliberately excluded persistence, user/operator authentication, a production remote-browser service, a credential vault, distributed leases, visual screenshot targeting, and a capability catalog API. The app uses a local synthetic member UI so it can be safely exercised without credentials. The included fixture planner makes tests/evidence reproducible offline; the OpenAI planner plus optional Playwright surface is the genuine live-discovery path and requires the evaluator's own model key.

Next I would add signed artifact releases with review diffs, a tenant/version compatibility registry and replay-stability score, an authenticated operator console with a browser-context lease, screenshot/AX-tree evidence, per-tenant secrets integration, and a bounded one-step recovery proposal that always requires policy validation and approval before becoming a new artifact revision.
