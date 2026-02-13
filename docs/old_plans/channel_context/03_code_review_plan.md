**Key Findings (Needs Remediation)**

-   Thread context is never treated as primary when there is no reply chain, which conflicts with the plan and results summary. See [messageHandler.ts:424-520].
-   The cumulative depth cap is not computed as [min(keywordMax, globalMax)]; it uses keyword max directly. This diverges from the plan. See [messageHandler.ts:185-216].
-   [collectChannelHistory()] always fetches using the global max depth, even when the keyword max depth is smaller, which is inefficient and breaks the intended depth budget semantics. See [messageHandler.ts:424-470].
-   README contains a contradictory DM note: "DMs automatically include recent channel messages as context," which should be DM channel history. See [README.md:323-338].
-   Tests do not cover thread-primary behavior or the global-vs-keyword max depth enforcement. See [messageHandler.test.ts:1550-1760].

Plan: Remediate Channel Context Prioritization
----------------------------------------------

This plan aligns the pending changes with the supplied Plan and Results Report, fixes correctness gaps, and adds tests to prevent regression. The primary goals are: enforce the global+keyword max depth rule, treat thread history as primary when no reply chain exists, avoid over-fetching channel history, and correct README language. The remediation keeps the existing metadata model and evaluator behavior, but ensures the collection pipeline matches the intended result and best practices.

**Steps**

1.  Update guild context depth computation to honor `maxContextDepth = Math.min(keywordMax, globalMax)` and pass that through to collection/collation. Adjust logic in [messageHandler.ts:178-220].
2.  Allow [collectChannelHistory()] to accept [maxDepth] and [maxTotalChars] parameters, and use the computed max depth rather than the global default. Update [messageHandler.ts:424-470].
3.  Implement thread-primary behavior when there is no reply chain by elevating thread history messages to [contextPriority: 'primary'] in that scenario (either in the collection step or in collation). Update [messageHandler.ts:424-520] and verify the collated ordering.
4.  Fix README DM wording to "DM channel messages" and keep the "no channel-context feature" phrasing intact. Update [README.md:323-338].
5.  Add tests:
    -   Thread message with no reply uses thread history as primary (and appears ahead of secondary in candidate selection). Add to [messageHandler.test.ts:1550-1760].
    -   max depth uses [min(keywordMax, globalMax)]; assert channel fetch limit and collated length respect that. Add to [messageHandler.test.ts:1550-1760].

**Verification**

-   Run [npm test].
-   Spot-check: `npm test -- messageHandler.test.ts`.
-   Optional: `npm test -- contextEvaluator.test.ts` to confirm no regressions in priority tagging.

**Decisions**

-   Use a single max depth derived from [min(keywordMax, globalMax)] for both fetching and collation to avoid over-fetching and ensure the budget matches the plan.
-   Treat thread history as primary only when no reply chain is present, as specified in the plan.