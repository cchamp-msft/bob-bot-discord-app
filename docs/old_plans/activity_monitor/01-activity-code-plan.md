Plan: Public Activity Feed (Privacy-First)
------------------------------------------

This revision keeps your original intent (public "behind-the-scenes" narrative, no sensitive leakage, bot-first voice) but restructures execution into small, reviewable, change-focused commits. The key adjustment is to treat privacy as a first-class contract in the event layer, then wire emission points, then expose via outputs server, then add UI. This aligns with existing separation between admin endpoints and public outputs while avoiding accidental exposure from current logger behavior. The plan also narrows "optional WebSocket" to documented future work so the first release stays low-risk and testable.

**Steps**

1.  Commit 1 --- `feat(activity-core): add sanitized activity event store`

-   Add src/utils/activityEvents.ts with `ActivityEvent` model, event types, in-memory ring buffer, `emit/getRecent/clear`, `since` filtering, and narrative template generation.
-   Centralize sanitization helpers here (no raw message text, no user IDs, no guild IDs, no API internals/endpoints/keys).
-   Add unit tests in tests/activityEvents.test.ts for cap/order/filtering and privacy-safe payload shaping.

1.  Commit 2 --- `feat(activity-bot): emit events in message and routing flow`

-   Instrument [messageHandler.ts] at intake, route decision branches, reply dispatch (including image URLs), and user-visible failure paths.
-   Instrument [apiRouter.ts] at routed execution points to capture actual route selection and fallback/retry transitions.
-   Add/extend tests in [messageHandler.test.ts] and [apiRouter.test.ts] to assert event emission and redaction behavior.

1.  Commit 3 --- `feat(outputs): expose public activity page and api`

-   Add route handlers in [outputsServer.ts] for `/activity` and `/api/activity`, ensuring route registration happens before static middleware.
-   API contract: `{ events, serverTime }`, with default recent window and optional `since`.
-   Extend [outputsServer.test.ts] to verify route availability, schema, filtering behavior, and no regressions to existing health/static behavior.

1.  Commit 4 --- `feat(activity-ui): add timeline page with polling and dialog`

-   Add src/public/activity.html with single-column feed, event color-coding, refresh control, last-updated text, auto-scroll behavior, and lazy-loaded inline images.
-   Implement polling against `/api/activity?since=...` (3--5s interval), incremental append, and native `<dialog>` image enlargement with close controls/backdrop-close.
-   Keep JS/CSS style consistent with existing lightweight inline pattern in [configurator.html].

1.  Commit 5 --- `docs(activity): document public endpoint and privacy model`

-   Update [README.md] with new `/activity` and `/api/activity` public behavior, explicit exclusions (raw content/IDs/secrets), and operational notes.
-   If needed, add a short note in [README.md] on event schema and polling usage.

**Verification**

-   Run targeted tests first: `npm test -- activityEvents`, `npm test -- outputsServer`, `npm test -- messageHandler`, `npm test -- apiRouter`.
-   Run full suite: `npm test`.
-   Manual checks:
-   `/activity` renders timeline and updates via polling.
-   Message, routing, reply, warning/error events appear with narrative text and correct color class.
-   Image events show inline thumbnail and open/close in native dialog.
-   Network/DOM inspection confirms no raw user message content, IDs, API endpoints, or secrets.

**Decisions**

-   Public hosting remains on outputs server ([outputsServer.ts]), not admin server, to match feature intent.
-   Polling is release scope; WebSocket is documented as future enhancement only.
-   Privacy enforcement is centralized in event creation/sanitization, not left to each call site.
-   Commit slicing follows Conventional Commits and keeps each review focused on one behavioral concern.