**Issue ordering (by stability first, then conflict minimization)**

IMPL006) Chore #6 — Unified JSON configuration system (chosen: do first)  
https://github.com/cchamp-msft/bob-bot-discord-app/issues/6  
Why here: this is the biggest “foundational” change and will otherwise cause constant rework for every feature (#7/#1/#2). Put it before features to minimize downstream conflicts.  
Likely touch points: src/utils/config.ts, config writer + configurator UI, plus any code reading env vars.  
Suggested commit order:
- Commit A: Introduce schema + loader (keep legacy env/keywords working temporarily).
- Commit B: Migrate config writes (configurator save path) to the unified JSON.
- Commit C: Migrate reads (API endpoints, feature flags, defaults, etc.), with tests updates.
- Commit D: Docs updates (README + config examples).

IMPL003) Chore #3 — Maintainability/style/dangling code review  
https://github.com/cchamp-msft/bob-bot-discord-app/issues/3  
Why after #6: otherwise you’ll refactor the same areas twice and create avoidable merge conflicts. Also, running broad formatting changes earlier will make bugfix diffs harder to review.  
Suggested commit order:
- Commit A: Mechanical/static cleanup (unused code, dead branches), minimal behavior changes.
- Commit B: Optional formatter/linter adoption (if desired), ideally isolated in its own commit/PR.

IMPL007) Enhancement #7 — SerpApi integration  
https://github.com/cchamp-msft/bob-bot-discord-app/issues/7  
Why before summaries: it can be implemented mostly as a new API client + command, with less invasive changes to message handling than #1. Doing it first reduces conflict risk.  
Likely touch points: new client under src/api, updates to src/commands/commands.ts, config additions (now via unified JSON).  
Suggested commit order: config key + validation → new api client → command wiring → tests → docs.

IMPL001) Enhancement #1 — Conversation summaries  
https://github.com/cchamp-msft/bob-bot-discord-app/issues/1  
Why here: larger cross-cutting changes (message pipeline, storage, prompt construction, new command). Best done after config system stabilizes.  
Likely touch points: src/bot/messageHandler.ts, commands, storage utility, config, tests.  
Suggested commit order: storage abstraction → summarization trigger logic → prompt integration → /summary command → tests/docs.

IMPL002) Enhancement #2 — User opinion dictionary  
https://github.com/cchamp-msft/bob-bot-discord-app/issues/2  
Why last among features: it depends on the “summary” capability described in #1 (or you’ll end up inventing a second summarization pipeline).  
Suggested commit order: persistence model → update rules → retrieval command/API → tests → docs.

**Standalone / equal priority (docs-only or external assets needed)**

- IMPL008) Doc #8 — Clarify project license and add correct LICENSE wording  
  https://github.com/cchamp-msft/bob-bot-discord-app/issues/8  
  Standalone. Note: repo already claims MIT in README and package.json has "license": "MIT", but there’s no LICENSE file in the workspace root, so this is a clean, low-conflict doc/legal PR.

- Doc #9 — Screenshot collage of bot in action  
  https://github.com/cchamp-msft/bob-bot-discord-app/issues/9  
  Standalone but blocked on real screenshots. Best left as bottom/equal priority since it needs manual capture; the markdown wiring is easy once assets exist.


**Completed Issues**

IMPL005) Bug #5 — API connectivity tests behave incorrectly  

IMPL004) Bug #4 — ComfyUI image generation does not work