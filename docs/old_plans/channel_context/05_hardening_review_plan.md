Plan: Context Handling Remediation
----------------------------------

The implementation appears to satisfy the requirements in [01_original_plan.md] and the remediation items in [03_code_review_plan.md]; the two results reports ([02_original_plan_results_report.md] and [04_code_review_results_report.md]) also claim no remaining gaps and passing tests. This plan focuses on best-practice hardening items found during review plus your decisions: (a) when budgets overflow, keep the newest context; (b) keep prompt markers to "source only" (no primary/secondary in `<conversation_history>`); (c) add a global option to allow/deny responding to other bots (and use it to control whether other bots' messages can enter context).

**Steps**

1.  Confirm baseline behavior stays as-is for [01]/[03] items (no functional regression)

    -   Use the existing reference points in [messageHandler.ts:168-207], [config.ts:317-336], and [messageHandler.test.ts:1845-2099] as "must stay green".
2.  Implement "keep newest under budget" for guild collation (depth-based)

    -   Update `collateGuildContext()` in [messageHandler.ts:540-588] so when the primary (or combined) set exceeds `maxContextDepth`, it keeps the newest messages (then sorts oldest→newest for final output).
    -   Add a regression test in [messageHandler.test.ts] proving that when primary history is longer than the depth cap, the newest primary messages survive.
3.  Implement "keep newest under budget" for DM and channel/thread history (char-based)

    -   Update DM history truncation in [messageHandler.ts:394-418] to drop oldest first when approaching `charLimit`, preserving newest messages.
    -   Update `collectChannelHistory()` truncation in [messageHandler.ts:463-509] similarly (build from newest backwards, then reverse for chronological formatting).
    -   Add/extend tests in [messageHandler.test.ts] that force the char limit and assert newest content is retained.
4.  Add a global "allow bot interactions" toggle (responding to bots + context inclusion)

    -   Add a new config option in [config.ts] (and config docs in [README.md]) for a boolean such as `ALLOW_BOT_INTERACTIONS` (name to follow existing env conventions).
    -   Gate message handling: ignore messages where `message.author.bot === true` and not "self", unless the option is enabled (this satisfies your "respond to other bots" requirement).
    -   Gate context inclusion: in `collectChannelHistory()` (see [messageHandler.ts:494-526]), skip `msg.author.bot` unless it's the current bot OR the option is enabled.
    -   Add tests in [messageHandler.test.ts] for both modes (default deny, optional allow).
5.  Tag DM context with `contextSource: 'dm'` for consistency

    -   The type already supports `'dm'` in [types.ts:1-13], but DM collectors don't currently set it (see [messageHandler.ts:380-424]).
    -   Update DM collection to populate `contextSource: 'dm'` (and optionally `contextPriority: 'primary'` for uniformity).
    -   Extend prompt formatting tests if needed (prompt remains "source only", per your decision), likely in [promptBuilder.test.ts:225-245].
6.  Small hygiene/doc touch-ups (no behavior change)

    -   Fix the misleading DM branch comment in [messageHandler.ts:172-178] to say "DM history" instead of "channel history".
    -   Ensure README references the new bot-interaction option next to existing context behavior docs in [README.md:277-320].

**Verification**

-   Run unit tests: `npm test` (or equivalent Jest command used in this repo).
-   Focused checks:
    -   Context depth: existing suite sections around [messageHandler.test.ts:1845-2099]
    -   Prompt formatting: [promptBuilder.test.ts:225-245]
    -   Config parsing defaults: [config.test.ts]
-   Manual sanity:
    -   Discord guild mention (no reply): verify newest channel context is kept under char cap.
    -   Discord reply-chain: verify newest replies survive when depth is exceeded.
    -   Bot-to-bot: verify default ignores other bots; toggle enables.

**Decisions**

-   Truncation keeps newest messages (then re-sorts oldest→newest for output).
-   `<conversation_history>` stays "source only" (no primary/secondary markers).
-   Add a global toggle to allow responding to other bots; use the same toggle to optionally include other bots in context.