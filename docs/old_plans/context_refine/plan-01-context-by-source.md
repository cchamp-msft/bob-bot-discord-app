# Plan 01 — Context by source (uniform), remove primary/secondary

## Goal
1) **Present message context uniformly by source** (reply, thread, channel, dm) in prompts.
2) **Stop using primary/secondary classifications** as they relate to reply chains; simplify the data model and prompt instructions accordingly.

## Non-goals
- Changing which messages are collected (depth/token limits) beyond what’s needed to remove primary/secondary.
- Adding new UX or admin surfaces.

## Current behavior (as implemented)
- `ChatMessage` carries both `contextPriority` (primary/secondary) and `contextSource` (reply/channel/thread/dm) in `src/types.ts`.
- `src/utils/contextEvaluator.ts`:
  - instructs the model to prioritize `[primary/reply]` and `[primary/thread]` vs `[secondary/channel]`
  - builds candidate windows preferring `contextPriority === 'primary'`
  - formats candidates with tags like ` [primary/reply]`
- `src/utils/promptBuilder.ts` formats `<conversation_history>` as lines like `User (reply): ...` but does not group by source.
- `src/bot/messageHandler.ts` in guilds collects reply chain + channel history, then collates them with priority semantics.

## Proposed end state
### Data model
- Deprecate and remove `contextPriority` from `ChatMessage`.
- Use only `contextSource` to express provenance.

### Uniform context presentation
- Standardize one representation used everywhere we show history to the model:
  - always include a `source` marker
  - preserve chronological order within each source
  - do not use the primary/secondary terminology anywhere in prompts

Two viable formats (pick one; keep it consistent across context-eval + main prompts):
1) **Line format** (minimal change):
   - `User [reply]: ...`
   - `Bob [channel]: ...`
2) **Grouped blocks** (stronger “presented by source”):
   - `<context source="reply">…</context>`
   - `<context source="channel">…</context>`

Default direction: **Grouped blocks**, because it makes “presented by source” explicit and avoids subtlety.

### Context selection behavior (replacing primary/secondary)
- Keep selection heuristics, but describe them in terms of source, not priority:
  - reply/thread context is *usually* more relevant than ambient channel scrollback
  - dm is the only source in DMs
- Candidate window construction in `evaluateContextWindow()`:
  - Build candidates from most-recent messages, but optionally cap per source so one source doesn’t crowd out others.
  - Example default heuristic:
    - If there is any `reply`/`thread` context, ensure at least `minDepth` newest across all, then allow additional from `reply`/`thread` up to `maxDepth`.

## Implementation steps
1) **Introduce a single “context formatting” helper**
   - New util (or extend `promptBuilder`) that formats an array of `ChatMessage` into either grouped-by-source blocks or standardized line labels.
   - Use it in:
     - `promptBuilder.formatConversationHistory()`
     - `contextEvaluator.formatHistoryForEval()`

2) **Remove primary/secondary plumbing**
   - Remove `contextPriority` from `src/types.ts`.
   - Update guild context collation in `src/bot/messageHandler.ts` (and any helper like `collateGuildContext`) to stop writing priority.
   - Update `contextEvaluator.evaluateContextWindow()` candidate selection to use `contextSource` rather than priority.

3) **Update prompts**
   - `buildContextEvalPrompt()` rules: remove primary/secondary wording; replace with source-based guidance.

4) **Update tests**
   - Update/extend tests that assert context tags or selection behavior:
     - `tests/contextEvaluator.test.ts`
     - `tests/messageHandler.test.ts` (if it checks context metadata)
     - `tests/promptBuilder.test.ts`

5) **Docs (optional but low-cost)**
   - Add a short note to `docs/api/message-and-api-routing-flow_walkthrough.md` if it references primary/secondary.

## Acceptance criteria
- No prompt emitted by the bot contains `primary` / `secondary` tags.
- `<conversation_history>` (and context-eval history) is consistently presented by source.
- All tests pass, and context-eval parsing continues to work unchanged.

## Risks / mitigations
- **Behavioral drift**: removing priority may change which messages are included.
  - Mitigate by keeping heuristics source-aware and adding snapshot tests.
- **Token cost**: grouped blocks add a few tags.
  - Mitigate by keeping formatting minimal and relying on existing maxDepth/maxTokens.
