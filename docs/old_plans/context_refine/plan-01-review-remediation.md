Plan: Review Commits Vs Plan-01
-------------------------------

This review validates the three commits against plan-01 with two explicit decisions: single-source histories must remain source-marked and keyword-only invocations must stay supported. The main goal is to preserve uniform, source-labeled context formatting (no primary/secondary) across both prompt building and context evaluation, while keeping runtime behavior intact for keyword-only APIs. The plan below maps each commit to targeted fixups or squashes, with direct file locations for follow-up changes and tests.

**Steps**

1.  **Commit 2a3b2a3 (refactor context)**: enforce source-marked output even for single-source histories by removing the flat-format branch in [promptBuilder.ts:155-162] and updating the test to expect [<context source="...">] in [promptBuilder.test.ts:246-258].
2.  **Commit 2a3b2a3 (refactor context)**: introduce a single shared context-formatting helper used by both [promptBuilder.ts:136-174] and [contextEvaluator.ts:12-47] to prevent drift between prompt formats and evaluator tags.
3.  **Commit 2a3b2a3 (refactor context)**: optionally rename the test describe string to remove "primary" terminology in [messageHandler.test.ts:1937], keeping language aligned with the plan.
4.  **Commit 33bf3e4 (config)**: restore keyword-only support by re-adding [allowEmptyContent: true] to NFL and SerpAPI entries in [keywords.json:68-105], preserving the runtime gating in [messageHandler.ts:158-166] and config support in [config.ts:30-41].
5.  **Commit 8af9da0 (docs)**: no changes needed; keep as-is.

**Verification**

-   Run unit tests for prompt formatting, context evaluation, and message handling (at minimum [promptBuilder.test.ts:216-258], [contextEvaluator.test.ts:421-494], [messageHandler.test.ts:1719-2094]).
-   Manually verify the prompt output contains source markers for single-source histories and that [nfl scores], [nfl news], `search`, and [second opinion] still work with keyword-only input.

**Decisions**

-   Single-source histories must remain uniformly source-marked (no flat formatting).
-   Keyword-only invocations must remain permitted for NFL and SerpAPI keywords.

If you want, I can format this into the exact file content including a title block that matches your other context_refine plans.