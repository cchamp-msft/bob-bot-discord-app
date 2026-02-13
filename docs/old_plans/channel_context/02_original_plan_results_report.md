**Config & defaults:**

-   [config.ts] --- [REPLY_CHAIN_MAX_DEPTH] default raised from 10 → **30**
-   [keywords.json] --- [chat.contextFilterMaxDepth] raised from 20 → **30**

**Type extension:**

-   [types.ts] --- [ChatMessage] gained optional fields: [contextPriority] (['primary'|'secondary']), [contextSource] (['reply'|'channel'|'thread'|'dm']), [discordMessageId], [createdAtMs]

**Context collection & collation (core feature):**

-   [messageHandler.ts]:
    -   [collectReplyChain()] --- now tags each message with [contextPriority:'primary'], [contextSource:'reply'], plus message ID and timestamp
    -   New [collectChannelHistory()] --- fetches recent channel/thread messages as [secondary] context, with multi-user attribution and thread detection
    -   New [collateGuildContext()] --- merges primary + secondary, deduplicates by message ID, enforces cumulative depth/character budgets, sorts chronologically
    -   [handleMessage()] --- guild messages now always collect channel context; reply chain fills primary slots first, channel fills remaining

**Context evaluator (priority-aware):**

-   [contextEvaluator.ts]:
    -   Candidate window builder prioritizes primary messages when selecting the top N candidates
    -   [formatHistoryForEval()] includes [[primary/reply]] / [[secondary/channel]] tags
    -   System prompt tells the evaluator to weight primary messages higher

**Prompt rendering:**

-   [promptBuilder.ts] --- [formatConversationHistory()] renders subtle source markers (e.g. [User (reply):], [Bob (channel):]) when metadata is present

**Tests (18 new, 2 updated):**

-   [config.test.ts] --- updated default expectations to 30
-   [messageHandler.test.ts] --- new [collectChannelHistory] (6 tests), [collateGuildContext] (4 tests), updated context-eval integration (2 tests), fixed guild mock factories
-   [contextEvaluator.test.ts] --- new priority-tag tests (2), formatHistoryForEval tag tests (2), buildContextEvalPrompt priority mention (1)
-   [promptBuilder.test.ts] --- new context-source marker tests (2)

**Documentation:**

-   [README.md] --- rewritten "Reply Chain Context, Channel Context & DM History" section describing the three-source model, collation behavior, and updated config defaults