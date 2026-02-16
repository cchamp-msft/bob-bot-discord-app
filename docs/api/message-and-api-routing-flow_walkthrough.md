Walkthrough: `@BobBot weather report for Seattle`
-------------------------------------------------

### 1\. Discord Event → MessageHandler

File: `discordManager.ts` → `messageHandler.ts`

The Discord.js `messageCreate` event fires and calls `messageHandler.handleMessage(message)`.

### 2\. Content Extraction & Keyword Matching

File: `messageHandler.ts`

-   The `@mention` is stripped → `content = "weather report for Seattle"`
-   `findKeyword()` sorts keywords longest-first, so `"weather report"** (15 chars) matches before **`"weather" (7 chars)
-   `keywordConfig` = `{ keyword: 'weather report', api: 'accuweather', finalOllamaPass: true, timeout: 360 }`
-   Since `api !== 'ollama'` → `apiKeywordMatched = true` → takes the direct API routing path

### 3\. API Router --- Primary Request

File: `apiRouter.ts`

`executeRoutedRequest()` executes the AccuWeather API via the request queue:

-   `requestQueue.execute('accuweather', ...)` → `apiManager.executeRequest('accuweather', ...)`
-   AccuWeather returns raw weather data for Seattle
-   `extractStageResult()` normalizes the response and pushes it to the `stages` array

### 4\. API Router --- Final Ollama Pass

Files: `apiRouter.ts` + `promptBuilder.ts`

Since `finalOllamaPass: true` and the primary API was `accuweather` (not `ollama`), the result flows into a second stage:

-   `evaluateContextWindow()` --- filters conversation history for relevance
-   `formatAccuWeatherExternalData()` --- wraps weather data in `<accuweather_data>` XML tags
-   `assembleReprompt()` --- builds the final prompt with:
    -   System: persona only (NO abilities/keyword rules --- prevents infinite loops)
    -   User: `<conversation_history>` + `<external_data>` + `<current_question>`
-   Ollama generates a conversational weather report using the real data

### 5\. Response Dispatch

File: `messageHandler.ts`

The `RoutedResult` returns with `finalApi: 'ollama'`, so `dispatchResponse()` routes to `handleOllamaResponse()`.

### 6\. Discord Reply

File: `messageHandler.ts`

The `⏳ Processing...` message is edited in-place with the final AI-generated weather report, chunked if necessary for Discord's message limits.

* * * * *

Key Functions by File
---------------------

| File | Function | Role |
| --- | --- | --- |
| `discordManager.ts` | `client.on('messageCreate')` | Entry point --- Discord event listener |
| `messageHandler.ts` | `handleMessage()` | Orchestrator --- routing decision |
| `messageHandler.ts` | `findKeyword()` | Regex keyword matching (longest-first) |
| `messageHandler.ts` | `executeWithTwoStageEvaluation()` | Fallback path when no keyword matches |
| `messageHandler.ts` | `dispatchResponse()` | Routes final result to correct handler |
| `apiRouter.ts` | `executeRoutedRequest()` | Executes primary API + optional final pass |
| `promptBuilder.ts` | `assemblePrompt()` | Builds XML prompt WITH abilities context |
| `promptBuilder.ts` | `assembleReprompt()` | Builds XML prompt WITHOUT abilities (final pass) |
| `promptBuilder.ts` | `parseFirstLineKeyword()` | Parses Ollama output for keyword trigger |
| `keywordClassifier.ts` | `classifyIntent()` | AI fallback classifier (two-stage path) |
| `keywordClassifier.ts` | `buildAbilitiesContext()` | Generates abilities context for Ollama |
| `contextEvaluator.ts` | `evaluateContextWindow()` | Filters conversation history for relevance (per-keyword opt-in via `contextFilterEnabled`) |
| `responseTransformer.ts` | `extractStageResult()` | Normalizes API responses for stage tracking |

* * * * *

Example Flows (Summary)
-----------------------

| Scenario | Path |
| --- | --- |
| `weather report for Seattle` | Regex match → AccuWeather API → Final Ollama pass → Discord reply |
| `generate a sunset` | Regex match → ComfyUI API → Discord reply (images) |
| `weather 45403` | Regex match → AccuWeather API → Discord reply (raw data) |
| `is it going to rain?` | No regex match → Two-stage: Ollama w/ abilities → keyword detected → AccuWeather → Final pass → Discord reply |
| `tell me a joke` | No regex match → Two-stage: Ollama w/ abilities → no keyword → Ollama response returned directly |
| `nfl scores` | Regex match → NFL API → Final Ollama pass → Discord reply |