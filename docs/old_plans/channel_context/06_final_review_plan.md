Plan: DM Bot Filtering Review
-----------------------------

This plan focuses on the best-practices findings from the pending changes: DM context currently includes other bots regardless of [ALLOW_BOT_INTERACTIONS], and there is an unused `chain` variable. We will align DM behavior with guild/channel filtering and ensure discoverability in config docs/examples. Tests will be updated to cover DM history behavior so the change is locked in.

**Steps**

1.  Adjust DM context collection to honor [ALLOW_BOT_INTERACTIONS] by filtering other bot messages in `collectDmHistory()` while still allowing this bot's messages; remove the unused `chain` variable in [messageHandler.ts] (`collectDmHistory`).
2.  Extend or add DM-focused tests to validate the new DM filtering behavior, mirroring existing bot-gating coverage, in [messageHandler.test.ts].
3.  Add [ALLOW_BOT_INTERACTIONS] to the example env file for discoverability in [.env.example] and confirm README stays accurate in [README.md].

**Verification**

-   Run relevant tests: `npm test -- messageHandler` (or the existing test runner) and ensure DM-related cases pass.

**Decisions**

-   DM history should apply the same [ALLOW_BOT_INTERACTIONS] filtering rules as guild/channel history.