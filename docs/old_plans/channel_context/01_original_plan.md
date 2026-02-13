Plan: Add Channel Context To Ollama Prompts
-------------------------------------------

Extend guild (non-DM) prompts so they include recent channel/thread messages even when the user isn't replying, while still collecting reply-chain context when present. Collate both into one history stream, tag each entry as **primary** (reply-chain or thread) vs **secondary** (channel context), and bias context selection toward primary when enforcing per-keyword [contextFilterMinDepth]/[contextFilterMaxDepth]. Raise the global max depth default to 30 and set the `chat` keyword max depth to 30; DM behavior stays "DM history only" (no new channel-context feature), but it will inherit the new global max.

**Steps**

1.  Raise global max depth default to 30

    -   Update the default in [config.getReplyChainMaxDepth()] from 10 → 30 in [config.ts:316-338].
    -   Update README env table default `REPLY_CHAIN_MAX_DEPTH` to 30 and adjust behavior notes that currently claim "single messages not replies work exactly as before" for guilds in [README.md:280-340].
2.  Raise `chat` keyword max depth to 30

    -   Change [chat.contextFilterMaxDepth] from 20 → 30 in [keywords.json].
    -   (Keep other keywords unchanged unless explicitly requested.)
3.  Add context metadata to [ChatMessage] so we can tag primary vs secondary

    -   Extend [ChatMessage] in [types.ts] with optional fields (non-breaking for existing callers):
        -   `contextPriority?: 'primary' | 'secondary'`
        -   `contextSource?: 'reply' | 'channel' | 'thread' | 'dm'`
        -   `discordMessageId?: string` (for dedupe)
        -   [createdAtMs?: number] (for stable chronological merge)
4.  Collect guild channel/thread context in addition to reply-chain context

    -   In [messageHandler.ts]:
        -   Add [collectChannelHistory(message, maxDepth, maxTotalChars)] mirroring [collectDmHistory()] but using the guild channel/thread (same [before: message.id], skip "⏳ Processing..." messages, strip bot mentions).
        -   Keep existing [collectReplyChain()] traversal, but have it include `discordMessageId` + `createdAtMs` + `contextPriority:'primary'` + [contextSource:'reply'].
        -   For threaded messages, set channel-history items to `contextSource:'thread'` and treat them as `contextPriority:'primary'` when there is no reply chain (so "thread is primary").
        -   Compute a single cumulative depth budget for guild history using:
            -   [keywordMax = keywordConfig.contextFilterMaxDepth ?? config.getReplyChainMaxDepth()]
            -   [globalMax = config.getReplyChainMaxDepth()] (now default 30)
            -   `maxContextDepth = Math.min(keywordMax, globalMax)`
        -   Apply the "cumulative across both contexts" rule:
            -   Collect primary first (reply chain if present; otherwise thread-history if in thread).
            -   Fill remaining slots (up to `maxContextDepth`) with secondary channel-history.
        -   De-duplicate by `discordMessageId`, then sort by `createdAtMs` to produce one oldest→newest [conversationHistory].
5.  Ensure context evaluation favors primary context when selecting candidates

    -   Update [contextEvaluator.ts]:
        -   Change candidate selection logic so it doesn't accidentally drop primary messages when there's lots of secondary channel context.
        -   Implement a helper (internal) that builds the candidate window up to [maxDepth] by:
            -   taking most-recent primary messages first (newest→oldest),
            -   then filling remaining slots with most-recent secondary messages,
            -   then re-sorting candidates oldest→newest for formatting and final return.
        -   Update [formatHistoryForEval()] to include a subtle marker in each line (e.g. [PRIMARY/reply] vs [SECONDARY/channel]) so the evaluator model can see the priority when choosing indices.
6.  Render subtle primary/secondary markers in the prompt's `<conversation_history>`

    -   Update [formatConversationHistory()] in [promptBuilder.ts] so it prefixes lines based on metadata, for example:
        -   [User (reply): ...], [User (channel): ...], `Bob (thread): ...`
    -   Keep output identical for messages without metadata (backwards compatibility).
7.  Update and extend unit tests

    -   Add/adjust tests in [messageHandler.test.ts] to cover:
        -   Guild mention (not a reply) now includes recent channel context.
        -   Guild reply includes reply-chain (primary) plus channel context (secondary), capped cumulatively.
        -   Thread message uses thread history as primary when not a reply.
    -   Extend [contextEvaluator.test.ts] to verify:
        -   candidate selection prioritizes primary messages when history exceeds [contextFilterMaxDepth].
        -   per-keyword min/max depth still enforced.
    -   Extend [promptBuilder.test.ts] to verify:
        -   conversation history formatting includes the new subtle markers when metadata exists.

**Verification**

-   Run unit tests: [npm test]
-   Spot-check targeted suites: `npm test -- messageHandler.test.ts`, `npm test -- contextEvaluator.test.ts`, `npm test -- promptBuilder.test.ts`
-   Manual sanity check in Discord:
    -   In a guild channel, @mention the bot without replying; confirm it uses recent channel context.
    -   Reply to a bot message; confirm reply-chain context is present and marked primary.

**Decisions**

-   Priority presentation: collated single history stream with explicit `primary/secondary` markers (not separate blocks), to satisfy "collated" while making priority unambiguous.
-   DM behavior: unchanged feature-wise (still DM history only), but it uses the new global max depth of 30 as requested.