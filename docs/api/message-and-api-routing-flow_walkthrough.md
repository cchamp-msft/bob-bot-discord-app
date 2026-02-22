Walkthrough: `@BobBot !weather Seattle`
-------------------------------------------------

### 1\. Discord Event → MessageHandler

File: `discordManager.ts` → `messageHandler.ts`

The Discord.js `messageCreate` event fires and calls `messageHandler.handleMessage(message)`.

### 2\. Content Extraction & Keyword Matching

File: `messageHandler.ts`

-   The `@mention` is stripped → `content = "!weather Seattle"`
-   `findKeyword()` matches `"!weather"` at the start of the message
-   `keywordConfig` = `{ keyword: '!weather', api: 'accuweather', timeout: 60 }`
-   Since `api !== 'ollama'` → `apiKeywordMatched = true` → takes the direct API routing path

### 3\. API Router --- Primary Request

File: `apiRouter.ts`

`executeRoutedRequest()` executes the AccuWeather API via the request queue:

-   `requestQueue.execute('accuweather', ...)` → `apiManager.executeRequest('accuweather', ...)`
-   AccuWeather returns raw weather data for Seattle
-   `extractStageResult()` normalizes the response and pushes it to the `stages` array
-   If the primary request fails and retry is enabled, Ollama refines the parameters and the API is re-attempted (up to `maxRetries` times)

### 4\. API Router --- Final Ollama Pass

Files: `apiRouter.ts` + `promptBuilder.ts`

Since `finalOllamaPass: true` and the primary API was `accuweather` (not `ollama`), the result flows into a second stage:

-   `evaluateContextWindow()` --- filters conversation history for relevance
-   `formatAccuWeatherExternalData()` --- wraps weather data in `<accuweather_data>` XML tags
-   `assembleReprompt()` --- builds the final prompt with:
    -   System: persona only (NO abilities/keyword rules --- prevents infinite loops)
    -   User: `<conversation_history>` + `<external_data>` + `<current_question>`
-   If `finalOllamaPass` is enabled on a keyword, Ollama can refine the API result conversationally

### 5\. Response Dispatch

File: `messageHandler.ts`

The `RoutedResult` returns with `finalApi: 'ollama'`, so `dispatchResponse()` routes to `handleOllamaResponse()`.

### 6\. Discord Reply

File: `messageHandler.ts`

The `⏳ Processing...` message is edited in-place with the final weather response, chunked if necessary for Discord's message limits.

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
| `apiRouter.ts` | `inferAbilityParameters()` | Extracts API params from natural language (two-stage path) |
| `keywordClassifier.ts` | `buildAbilitiesContext()` | Generates abilities context for Ollama |
| `contextEvaluator.ts` | `evaluateContextWindow()` | Filters conversation history for relevance (global toggle via `CONTEXT_EVAL_ENABLED`) |
| `responseTransformer.ts` | `extractStageResult()` | Normalizes API responses for stage tracking |

* * * * *

Example Flows (Summary)
-----------------------

| Scenario | Path |
| --- | --- |
| `!weather Seattle` | Regex match → AccuWeather API → Discord reply |
| `!generate a sunset` | Regex match → ComfyUI API → Discord reply (images) |
| `!weather 45403` | Regex match → AccuWeather API → Discord reply (raw data) |
| `is it going to rain?` | No regex match → Two-stage: Ollama w/ abilities → keyword detected → AccuWeather → Final pass → Discord reply |
| `tell me a joke` | No regex match → Two-stage: Ollama w/ abilities → no keyword → Ollama response returned directly |
| `!nfl scores` | Regex match → NFL API → Final Ollama pass → Discord reply |
| `!search latest news` | Regex match → SerpAPI → Final Ollama pass → Discord reply |
| `!meme surprised pikachu` | Regex match → Meme API → Discord reply (image) |