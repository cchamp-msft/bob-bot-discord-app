# Plan: Replace SportsData.io with ESPN API + Add NFL News

## TL;DR

Replace the paid sportsdata.io backend with ESPN's free public JSON API. The ESPN scoreboard endpoint provides richer real-time data (scores, quarter-by-quarter lines, possession, broadcast, leaders, records) with no API key. The `NFLGameScore` interface is retained as the internal model, with an adapter mapping ESPN fields onto it. NFL news is added via two new keywords: `nfl news` (5-item direct summary) and `nfl news report` (11-item Ollama-enhanced). This eliminates the `NFL_API_KEY` requirement entirely. Live polling is deferred to a follow-up plan.

## Steps

1. **Define ESPN response types** in [src/types.ts](../../src/types.ts)
   - Add `ESPNScoreboardResponse`, `ESPNEvent`, `ESPNCompetition`, `ESPNCompetitor`, `ESPNTeam`, `ESPNStatus`, `ESPNVenue`, `ESPNOdds` interfaces matching the real API shape (typed from the live endpoint we fetched). These are internal — all downstream code continues to consume `NFLGameScore`.
   - Add `NFLNewsArticle` type: `id`, `headline`, `description`, `published`, `images`, `categories`, `links`, `byline`.
   - Add `NFLNewsResponse` extending the existing response pattern (`success`, `data.text`, `data.articles`).
   - Keep `NFLGameScore` **unchanged** — it's the stable contract between the data layer and all formatting/routing code. ESPN fields map onto it 1:1.

2. **Create ESPN-to-NFLGameScore adapter** in [src/api/nflClient.ts](../../src/api/nflClient.ts)
   - Add `mapESPNEventToGame(event: ESPNEvent): NFLGameScore` function handling the field mapping:
     - `GameKey` ← `event.id`
     - `Season` ← `event.season.year`
     - `SeasonType` ← `event.season.type` (ESPN uses same 1/2/3 convention)
     - `Week` ← `event.week.number`
     - `Date` ← `event.date`
     - `AwayTeam`/`HomeTeam` ← `competitor.team.abbreviation` (filtered by `homeAway`)
     - `AwayScore`/`HomeScore` ← `parseInt(competitor.score)` (ESPN returns string)
     - `Channel` ← `competition.broadcast`
     - `Quarter` ← derived from `status.period` (0→null, 1-4→string, 5→"OT") and `status.type.name` ("STATUS_HALFTIME"→"Half")
     - `TimeRemaining` ← `status.displayClock`
     - `Status` ← mapped from `status.type.state`+`status.type.name`: pre→"Scheduled", in→"InProgress", post→"Final" (period>4→"F/OT")
     - `StadiumDetails` ← `competition.venue` (fullName, address.city/state/country)
     - `IsClosed` ← `status.type.completed`
     - `PointSpread`/`OverUnder` ← `competition.odds[0]` if present
     - `AwayTeamMoneyLine`/`HomeTeamMoneyLine` ← odds data if available
   - Add `mapESPNScoreboard(response: ESPNScoreboardResponse): NFLGameScore[]` that maps the full events array.

3. **Refactor NFLClient API methods** in [src/api/nflClient.ts](../../src/api/nflClient.ts)
   - Change `NFL_BASE_URL` to `https://site.api.espn.com/apis/site/v2/sports/football/nfl`
   - **Remove** API key dependency — ESPN requires no auth. Remove `config.getNflApiKey()` checks from all methods.
   - **Remove** `getCurrentWeek()` and `getCurrentSeason()` as standalone API calls. ESPN's scoreboard response includes `season` and `week` at the top level — extract them inline.
   - **Replace** `fetchScores()` — single call to `/scoreboard` with params `?dates=YYYYMMDD` or `?week=N&seasontype=T&season=Y`. Map response through the adapter. No more `ScoresBasic` vs `ScoresByWeek` distinction.
   - **Replace** `getSuperBowlGame()` — fetch `/scoreboard` and filter by `competition.notes[].headline` containing "Super Bowl", or by season type 3 + single-game week. Much simpler than the current week-22/21/23 probing.
   - **Replace** `testConnection()` — simple GET to `/scoreboard` (no key), check for 200 + valid `events` array.
   - **Remove** `validateScoresData()` — no sandbox/trial key concerns with ESPN.
   - **Update** `handleRequest()` — remove API key guard. Add routing for `nfl news` and `nfl news report` keywords.
   - **Update** `refresh()` — still rebuilds axios instance and clears cache, but no key logging.
   - Cache TTLs remain the same logic (60s live, 300s final), key structure updated for ESPN params.

4. **Enhance Super Bowl formatting** in [src/api/nflClient.ts](../../src/api/nflClient.ts)
   - `formatSuperBowl()` — add team records (from `competitor.records[]`), broadcast info, and Super Bowl headline (from `notes[].headline` e.g., "Super Bowl LX") to the output.
   - During live games, if ESPN's `situation` object is present, add possession indicator, down & distance, yard line, and red zone flag to the live display.

5. **Add NFL news methods** in [src/api/nflClient.ts](../../src/api/nflClient.ts)
   - Add `fetchNews(limit: number, signal?: AbortSignal): Promise<NFLNewsArticle[]>` — calls `/news`, caches 5 minutes, returns parsed articles.
   - Add `formatNews(articles: NFLNewsArticle[], limit: number): string` — formats headlines with descriptions, numbered list, publish times.
   - Add `formatNewsContextForAI(articles: NFLNewsArticle[]): string` — plain-text context block for Ollama final pass.
   - Add `handleNews(content: string, signal?: AbortSignal): Promise<NFLResponse>` — fetches 5 articles, formats directly.
   - Add `handleNewsReport(content: string, signal?: AbortSignal): Promise<NFLResponse>` — fetches 11 articles, returns for Ollama final pass.
   - Update `handleRequest()` to route `nfl news` → `handleNews()` and `nfl news report` → `handleNewsReport()`.
   - Update `static allowsEmptyContent()` to include `nfl news` and `nfl news report`.

6. **Add news keywords** in [config/keywords.json](../../config/keywords.json)
   - Add `nfl news report` keyword: `{ api: "nfl", timeout: 60, finalOllamaPass: true, description: "Get an AI-enhanced NFL news report" }` — **must come before** `nfl news` (longest-first matching).
   - Add `nfl news` keyword: `{ api: "nfl", timeout: 30, description: "Get latest NFL news headlines" }`.

7. **Update configuration** in [src/utils/config.ts](../../src/utils/config.ts) and related files
   - Make `NFL_API_KEY` optional — no longer required for ESPN. Keep the getter but return empty string gracefully.
   - **Keep** `NFL_ENABLED` toggle (still useful for disabling NFL features entirely).
   - **Keep** `NFL_LOGGING_LEVEL` (still useful for debugging).
   - **Keep** `NFL_BASE_URL` as an optional override (defaults to ESPN) for testability.
   - Update [src/utils/apiRouter.ts](../../src/utils/apiRouter.ts) `buildFinalPassPrompt()` if needed for news data markers (e.g., `[NFL News Data]...[End NFL News Data]`).
   - Update the configurator UI in [src/public/configurator.html](../../src/public/configurator.html) — remove NFL API key as a required field, mark it optional/legacy, update labels.
   - Update `PublicConfig` in [src/types.ts](../../src/types.ts) — `nflApiKeyConfigured` becomes optional/removed, add `nflDataSource: 'espn'`.

8. **Update response transformer** in [src/utils/responseTransformer.ts](../../src/utils/responseTransformer.ts)
   - Ensure `extractFromNFL()` handles news responses (extracts `data.text` — should work as-is).
   - Update `buildFinalPassPrompt()` to use `[NFL News Data]` markers when the source is a news request (distinct from game data markers).

9. **Rewrite tests** in [tests/nflClient.test.ts](../../tests/nflClient.test.ts)
   - Replace all sportsdata.io mock responses with ESPN-shaped JSON fixtures.
   - Update `makeGame()` factory to produce `ESPNEvent` fixtures; add `makeESPNResponse()` wrapper.
   - Keep `NFLGameScore`-based assertion patterns — the adapter output should match existing expectations.
   - Add tests for:
     - `mapESPNEventToGame()` — all status transitions (scheduled/live/halftime/final/OT/postponed)
     - `mapESPNScoreboard()` — multi-game mapping
     - `fetchNews()` — mock ESPN news endpoint, caching, error handling
     - `handleNews()` / `handleNewsReport()` — keyword dispatch, article count limits
     - `formatNews()` — output formatting
     - `allowsEmptyContent()` — updated for new keywords
     - Super Bowl detection via notes filtering
     - No API key required — removed guard tests
   - Update [tests/apiRouter.test.ts](../../tests/apiRouter.test.ts) if news keywords affect final pass routing.
   - Update [tests/config.test.ts](../../tests/config.test.ts) for optional API key.

10. **Update documentation**
    - Update [README.md](../../README.md) — remove sportsdata.io API key setup instructions, document ESPN as the data source, note no API key needed, add `nfl news` / `nfl news report` keyword documentation.
    - Update [docs/plans/plan-nflGameAwareness.md](plan-nflGameAwareness.md) — add a section noting the ESPN migration and rationale.

## Commit Strategy

1. `refactor(nfl): add ESPN types and adapter function` — types + mapping, no behavior change
2. `refactor(nfl): replace sportsdata.io with ESPN scoreboard API` — swap the data layer, update config
3. `feat(nfl): enhance Super Bowl display with records and broadcast` — formatting improvements
4. `feat(nfl): add nfl news and nfl news report keywords` — news feature + keywords
5. `test(nfl): rewrite tests for ESPN API backend` — updated test suite
6. `docs(nfl): update README and plan for ESPN migration` — documentation

## Verification

- Run `npx jest tests/nflClient.test.ts` — all tests pass with ESPN mock data
- Run `npx jest tests/apiRouter.test.ts` — routing still works for all NFL keywords including new news keywords
- Run `npx jest` — full suite passes, no regressions
- Manual test: send `nfl scores` to bot → returns live ESPN scoreboard data (no API key needed)
- Manual test: send `superbowl` → returns Super Bowl details with records/broadcast
- Manual test: send `nfl news` → returns 5 headline summaries
- Manual test: send `nfl news report` → returns Ollama-enhanced 11-item news digest
- Manual test: send `nfl` with no API key configured → still works (ESPN is free)
- Verify configurator page no longer shows NFL API key as required

## Decisions

- **ESPN over sportsdata.io**: Free, richer data (leaders, records, broadcast, venue, quarter-by-quarter), no API key, no sandbox data quality issues. Trade-off: undocumented API, but it's been stable for years and powers ESPN's own frontend.
- **Keep `NFLGameScore` as internal model**: Minimizes blast radius — all formatting, routing, and response code stays untouched. Only the data-fetching layer changes.
- **No RSS parser needed**: ESPN's `/news` endpoint returns structured JSON that's richer than any RSS feed.
- **Polling deferred**: Phase 2 will add `setInterval`-based polling with configurator toggle and channel selection.

## ESPN API Reference

### Endpoints Used

| Endpoint | Purpose | Auth |
|---|---|---|
| `/scoreboard` | Live/current scores | None |
| `/scoreboard?dates=YYYYMMDD` | Scores for a specific date | None |
| `/scoreboard?week=N&seasontype=T&season=Y` | Scores by week/season | None |
| `/news` | NFL news headlines | None |
| `/teams` | Team directory | None |
| `/teams/{id}` | Team detail + record | None |
| `/teams/{id}/schedule` | Team season schedule | None |

### Key Field Mappings (ESPN → NFLGameScore)

| NFLGameScore Field | ESPN Source Path |
|---|---|
| `GameKey` | `event.id` |
| `Season` | `event.season.year` |
| `SeasonType` | `event.season.type` |
| `Week` | `event.week.number` |
| `Date` | `event.date` |
| `AwayTeam` | `competitor[homeAway="away"].team.abbreviation` |
| `HomeTeam` | `competitor[homeAway="home"].team.abbreviation` |
| `AwayScore` | `parseInt(competitor[homeAway="away"].score)` |
| `HomeScore` | `parseInt(competitor[homeAway="home"].score)` |
| `Channel` | `competition.broadcast` |
| `Quarter` | `status.period` (0→null, 1-4→string, 5→"OT", halftime→"Half") |
| `TimeRemaining` | `status.displayClock` |
| `Status` | `status.type.state` + `status.type.name` → mapped |
| `StadiumDetails` | `competition.venue` |
| `IsClosed` | `status.type.completed` |
| `PointSpread` | `competition.odds[0]` |
| `OverUnder` | `competition.odds[0]` |

### Status Mapping

| ESPN `state` | ESPN `name` | → `NFLGameScore.Status` |
|---|---|---|
| `pre` | `STATUS_SCHEDULED` | `Scheduled` |
| `in` | `STATUS_IN_PROGRESS` | `InProgress` |
| `in` | `STATUS_HALFTIME` | `InProgress` (Quarter="Half") |
| `post` | `STATUS_FINAL` | `Final` or `F/OT` (if period > 4) |
| `post` | `STATUS_POSTPONED` | `Postponed` |
| `in` | `STATUS_DELAYED` | `Delayed` |
| `post` | `STATUS_CANCELED` | `Canceled` |