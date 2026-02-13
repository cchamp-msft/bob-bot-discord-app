Plan: Fix SerpApi "Second Opinion" AI Overview
----------------------------------------------

Second opinion is already wired to SerpApi, and the client already implements SerpApi's documented 2-step AI Overview flow: first [engine=google], then (only if [ai_overview.page_token] is returned) a follow-up [engine=google_ai_overview&page_token=...] call. The likely root cause of "never getting AI Overview" is missing locale parameters: SerpApi notes AI Overview is currently mainly visible for English (`hl=en`) with limited `gl`. This plan makes `hl`/`gl` configurable via env + configurator, injects them into the initial Google search request, and changes the "second opinion" output to return AI Overview only (with a graceful message when unavailable).

**Steps**

1.  Confirm/lock in correct endpoint usage in the SerpApi client

    -   Review the current request flow in [serpApiClient.ts:142-181] ([googleSearch()] + [fetchAIOverview()]).
    -   Optional hardening: switch `'/search'` to ['/search.json'] for both calls to match SerpApi docs (behavior should remain the same).
2.  Add configurable locale settings to config

    -   Add [config.getSerpApiHl()] / [config.getSerpApiGl()] in [config.ts:270-290].
    -   Use "undefined vs empty string" semantics (like [getOllamaSystemPrompt()]): default to `hl=en` and `gl=us` when env vars are unset; allow empty string to mean "don't send this param".
    -   Include these in reload-diff reporting in [config.ts:660-690].
3.  Expose new settings to the configurator (public config + UI)

    -   Extend [PublicConfig.apis] in [types.ts:311-336] with `serpapiHl` and `serpapiGl`.
    -   Return them from [config.getPublicConfig()] in [config.ts:704-736].
    -   Add two inputs in the SerpApi section of [configurator.html:531-570] with [data-env="SERPAPI_HL"] and [data-env="SERPAPI_GL"].
    -   Populate them when loading config in [configurator.html:931-938]. Saving already picks up any [data-env] fields.
4.  Ensure second opinion actually requests AI Overview reliably

    -   Inject `hl`/`gl` into the initial SerpApi Google Search call in [serpApiClient.ts:142-158] (and keep the existing follow-up call in [serpApiClient.ts:163-190]).
    -   Add optional typing support for [ai_overview.error] / [ai_overview.serpapi_link] (documented on SerpApi's AI Overview page) so we can surface useful "not available" messaging.
5.  Change "second opinion" UX to "AI Overview only"

    -   Update formatting in [serpApiClient.ts:196-257]: when [keyword] is "second opinion", return only AI Overview snippets (+ references), and omit Answer Box / Knowledge Graph / Organic Results.
    -   If no AI Overview exists (no [text_blocks] and no successful follow-up), return [success: true] with a clear message like "No AI Overview available for this query (try rephrasing or adjust SERPAPI_HL/SERPAPI_GL)" to avoid the global error path in [messageHandler.ts:822-858].
6.  Update unit tests

    -   Extend mocks + add tests in [serpApiClient.test.ts] to verify:
        -   `SERPAPI_HL`/`SERPAPI_GL` are sent in the initial [engine=google] request params.
        -   "second opinion" output excludes "Top Results" and includes AI Overview when present.
        -   When AI Overview is absent, the response is still [success: true] and contains the "not available" message (and does not trigger the generic error response path).
7.  Update docs

    -   Add `SERPAPI_HL` and `SERPAPI_GL` to the env var list in [README.md:109-130], and briefly note that AI Overview availability is locale-dependent.

**Verification**

-   Run unit tests: [npm test] (or [npm test -- serpApiClient] if you prefer targeted).
-   Manual sanity check via configurator:
    -   Set `SERPAPI_HL=en`, `SERPAPI_GL=us`, then try `second opinion how does ART work in android` (a query SerpApi uses in examples).
    -   Confirm output is AI Overview only, and references appear when returned.

**Decisions**

-   Locale params: configurable via env + configurator; default to `hl=en`, `gl=us` unless explicitly cleared.
-   "second opinion" output: AI Overview only (no organic results), with a graceful "not available" message when Google doesn't provide an AI Overview.