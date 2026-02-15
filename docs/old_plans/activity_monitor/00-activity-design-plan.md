Plan: Behind the Scenes Activity Feed
-------------------------------------

A public-facing, privacy-conscious activity view that shows the bot's internal decision-making as first-person narrative events. Hosted on the outputs server at `/activity`, it displays @mentions, DMs, routing decisions, and replies without exposing sensitive API details or raw message content. Events are color-coded, images display inline with native dialog enlargement, and updates via polling (with WebSocket as an optional enhancement).

**Core Design Principles**

-   **Privacy-first**: No raw message content, API keys, endpoints, or user IDs --- only sanitized, narrative-style summaries
-   **Bot perspective**: Events written in first person as "internal thoughts" (e.g., "*I need to look that up*")
-   **Visual clarity**: Color-coded event types, inline proportional images, minimal interaction surface
-   **Public access**: Served from outputsServer (not admin-only configurator), no authentication required

**Steps**

1.  **Create event emission layer** at src/utils/activityEvents.ts

    -   Define `ActivityEvent` interface with fields: [id], [timestamp], [type], `narrative`, `metadata`, `imageUrls`
    -   Event types: `message_received`, `routing_decision`, `bot_reply`, [error], [warning]
    -   Implement in-memory ring buffer (e.g., last 100 events) with thread-safe access
    -   Export singleton `activityEvents` with methods: `emit(event)`, [getRecent(count)], `clear()`
    -   Narrative templates for each event type (first-person phrasing)
2.  **Instrument bot flow to emit events**

    -   [messageHandler.ts:77-84]: Emit `message_received` after [logIncoming()] --- sanitize display name and indicate DM vs @mention
    -   [apiRouter.ts:1-100]: Emit `routing_decision` when keyword matched or during two-stage classification
    -   [messageHandler.ts:939]: Emit `bot_reply` with image URLs when handling ComfyUI responses
    -   Error handlers: Emit [error]/[warning] events for user-visible failures (not raw exceptions)
3.  **Add REST endpoint for polling** at [outputsServer.ts:1-100]

    -   [GET /api/activity?since=<timestamp>] returns events after `since` (defaults to last 50)
    -   Response: `{ events: ActivityEvent[], serverTime: string }`
    -   No authentication (public endpoint) --- events already sanitized by emission layer
4.  **Create activity page HTML** at src/public/activity.html

    -   Single-column timeline layout (similar to configurator console panel styling)
    -   Event card structure: timestamp, colored icon/border, narrative text, inline images
    -   Color scheme: `message_received` (neutral/blue), `routing_decision` (purple), `bot_reply` (green), [error] (red), [warning] (orange)
    -   Header with refresh button and "last updated" indicator
    -   Auto-scroll to bottom when new events arrive
5.  **Implement inline image display with enlargement**

    -   Images render proportionally within event cards (max-width: 300px, max-height: 200px)
    -   Click listener opens native `<dialog>` with full-size image (constrained to viewport)
    -   Dialog includes close button (X) and backdrop click-to-close
    -   Images lazy-load via `loading="lazy"` attribute
6.  **Add polling logic with optional WebSocket path**

    -   JavaScript polls [/api/activity?since=<lastTimestamp>] every 3-5 seconds
    -   Append new events to DOM, animate entrance (fade-in)
    -   Refresh button clears view and re-fetches all recent events
    -   Comment-documented WebSocket upgrade path: connect to [outputsServer] with [ws://] endpoint, emit events via broadcast pattern (reuse [comfyuiWebSocket.ts:50-200] patterns)
7.  **Register activity route in outputsServer** at [outputsServer.ts:30-60]

    -   [app.get('/activity', (req, res) => res.sendFile(activity.html))]
    -   [app.get('/api/activity', activityEventsHandler)]
    -   Serve after health check, before static files (so it overrides `/activity` folder if present)
8.  **Add narrative templates** in src/utils/activityEvents.ts

    -   `message_received`: "*Someone wants my attention in {location}*" (obfuscate username/guild)
    -   `routing_decision`: "*I need to check the weather*" / "*I think I can create that*" / "*Let me search for that*"
    -   `bot_reply`: "*Done! Here's what I found*" / "*I created {count} images for you*"
    -   [error]: "*Oops, something went wrong --- I couldn't complete that*"
    -   [warning]: "*Hmm, that took longer than expected*"

**Verification**

-   Start bot, trigger @mention → see `message_received` event in `/activity`
-   Request weather → see `routing_decision` ("*I need to check the weather*") event
-   Generate image → see `bot_reply` event with inline thumbnail, click to enlarge
-   Test manual refresh button clears and reloads
-   Confirm no sensitive data (API keys, raw content, user IDs) in HTML source or network responses
-   Validate color coding: errors red, routing decisions purple, replies green

**Decisions**

-   **Polling over WebSocket initially**: Simpler implementation, consistent with configurator patterns; WebSocket path documented for future enhancement if needed
-   **Public interface (outputsServer)**: Ensures separation from admin configurator, aligns with image serving infrastructure
-   **Native `<dialog>` for enlargement**: Modern, accessible, zero-dependency solution
-   **Event types limited to user-visible actions**: Excludes internal details like context evaluation or raw API payloads to maintain privacy and clarity