# Plan: Fix ESPN 401 Errors

## Problem

All ESPN API calls return `401 Unauthorized`, surfacing as "No NFL news available" or "No NFL games found" to users.

## Root Cause

The user's `.env` file still contains the **old SportsData.io values** from before the ESPN migration:

```
NFL_BASE_URL=https://api.sportsdata.io/v3/nfl/scores   ← line 42
NFL_API_KEY=bdccbb45d44e4f6a9bd83504c87e3633            ← line 43
```

`config.getNflEndpoint()` returns `process.env.NFL_BASE_URL`, so requests go to `api.sportsdata.io` instead of `site.api.espn.com`. SportsData.io rejects them with 401 (expired/invalid key or wrong endpoint shape).

The code itself has **no bug** — the ESPN client doesn't send an API key. It's purely a stale `.env` configuration issue.

## Fix Plan

### Step 1: Update `.env` — remove stale SportsData.io values

- Remove or comment out `NFL_BASE_URL` (the default in code is the ESPN URL)
- Remove or comment out `NFL_API_KEY` (unused by ESPN client)

### Step 2: Update `.env.example` — reflect ESPN configuration

Replace the SportsData.io section with ESPN values:

```dotenv
# NFL / ESPN Configuration (free, no API key required)
# NFL_BASE_URL=https://site.api.espn.com/apis/site/v2/sports/football/nfl
# NFL_ENABLED=true
```

Remove the `NFL_API_KEY` example line entirely.

### Step 3: Clean up dead code in `config.ts`

- Remove `getNflApiKey()` method — it is unused by the ESPN client and leaving it suggests an API key is still needed
- Or, at minimum, add a deprecation comment

### Step 4: Add startup validation (defensive)

In `nflClient.ts` constructor (or `refresh()`), log a warning if the configured endpoint doesn't look like ESPN:

```typescript
if (!baseURL.includes('espn.com')) {
  logger.log('warn', 'nfl', `NFL: Endpoint "${baseURL}" is not an ESPN URL — requests may fail`);
}
```

This prevents silent misconfiguration in the future.

### Step 5: Improve error messages

In `fetchScoreboard()` and `fetchNews()` catch blocks, when the error is a 401, append guidance to the log:

```
ERROR: Failed to fetch ESPN scoreboard: 401 Unauthorized — check NFL_BASE_URL in .env (should be ESPN)
```

### Step 6: Update tests & verify

- Add a test asserting the startup warning fires for non-ESPN URLs
- Run full test suite to confirm no regressions
- Manually verify with "nfl scores" and "nfl news" commands

## Commit Strategy

1. **`fix(nfl): update .env for ESPN, remove stale SportsData.io config`** — Steps 1-2 (.env changes)
2. **`refactor(nfl): remove dead getNflApiKey, add ESPN endpoint validation`** — Steps 3-5 (code hardening)
3. **`test(nfl): add endpoint validation tests`** — Step 6
