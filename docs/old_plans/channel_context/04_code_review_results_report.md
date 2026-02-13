All 832 tests pass (23 suites). Here's what was implemented:

**[messageHandler.ts]**

-   Guild context depth now computed as [Math.min(keywordMax, globalMax)] --- prevents keyword overrides from exceeding the global cap
-   [collectChannelHistory()] accepts optional [maxDepth] and [maxTotalChars] params, using the computed budget instead of always fetching at the global max
-   Thread history is promoted to [contextPriority: 'primary'] when no reply chain exists (the [isThread()] check runs post-collection)

**[README.md:335]**

-   Fixed misleading DM note: "recent DM channel messages" instead of "recent channel messages"

**[messageHandler.test.ts]** --- 6 new tests:

-   [collectChannelHistory] uses passed [maxDepth] instead of global config
-   [collectChannelHistory] falls back to global when no params passed
-   Collated context capped at [min(keywordMax, globalMax)] with fetch limit verified
-   Thread history promoted to primary when no reply chain
-   Channel history stays secondary in non-thread channels