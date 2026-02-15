# Bob Bot - Discord AI Integration

A Discord bot that monitors @mentions and DMs, routes keyword-matched requests to ComfyUI, Ollama, AccuWeather, ESPN NFL, and SerpAPI (Google Search) APIs, and returns results as inline replies or ephemeral slash commands with organized file outputs and comprehensive logging.

## Features

- ✅ @mention and DM detection with inline replies
- ✅ **DM conversation context** — DMs automatically include recent message history without requiring explicit replies
- ✅ Slash commands with ephemeral responses (shareable by user)
- ✅ ComfyUI integration for image generation (WebSocket-based with HTTP polling fallback)
- ✅ Ollama integration for AI text generation
- ✅ AccuWeather integration for real-time weather data (current conditions + 5-day forecast)
- ✅ **NFL game data** — live scores and news via ESPN, with optional date-based lookups and news filtering
- ✅ Serial request processing with max 1 concurrent per API
- ✅ Configurable per-keyword timeouts (default: 300s)
- ✅ Smart file handling (attachments for small files, URL links for large)
- ✅ HTTP server for file serving
- ✅ **Web-based configurator** — localhost-only SPA for managing all settings
- ✅ **Discord start/stop controls** — manage bot connection from the configurator
- ✅ **Hot-reload support** — API endpoints and keywords reload without restart
- ✅ **Graceful shutdown** — cleans up Discord, HTTP server, and WebSocket connections on SIGINT/SIGTERM
- ✅ **Ollama model discovery** — test connection loads available models for selection
- ✅ **Ollama system prompt** — configurable personality/context sent with every request
- ✅ **ComfyUI workflow upload** — upload JSON workflow with `%prompt%` placeholder substitution
- ✅ **Rate-limited error messages** — configurable user-facing error messages with minimum interval
- ✅ **Reply chain context** — traverses Discord reply threads to provide conversation history to Ollama
- ✅ **Image prompt cleanup** — routing keywords are stripped from prompts before submission to ComfyUI
- ✅ **Reply-based image generation** — replying to a message with an image keyword combines the quoted content with the user's prompt
- ✅ **Configurable image response format** — embed block with internal link is optional (disabled by default)
- ✅ **Conversational responses** — Ollama replies use plain text instead of embed blocks for a natural feel
- ✅ Comprehensive request logging with date/requester/status tracking
- ✅ Organized output directory structure with date formatting
- ✅ **Unit test suite** — 100+ tests covering core functionality
- ✅ **Two-stage evaluation** — Ollama responses are re-evaluated for API keyword triggers, enabling automatic ability routing
- ✅ **Weather slash command** — `/weather` command with optional location and report type parameters
- ✅ **Weather→AI routing** — weather data piped through Ollama for AI-powered weather reports via `finalOllamaPass`
- ✅ **Global final-pass model** — configurable Ollama model for all final-pass refinements
- ✅ **Ability logging** — opt-in detailed logging of abilities context sent to Ollama
- ✅ **NFL commands** — `nfl scores` (current or date-specific) and `nfl news` (with optional keyword filter)
- ✅ **Web search** — Google Search via SerpAPI with AI Overview support; `search` returns full results, `second opinion` returns only Google's AI Overview (AI Overview availability is locale-dependent — configure `SERPAPI_HL`/`SERPAPI_GL`; optional `SERPAPI_LOCATION` can further improve coverage)
- ✅ **Public activity feed** — privacy-first `/activity` page on the outputs server showing bot decisions as first-person narrative events; no raw message content, user IDs, or API keys are exposed; protected by a rotating access key requested from Discord via the `activity_key` keyword

## Project Structure

```
src/
├── index.ts              # Main bot entry point
├── bot/
│   ├── discordManager.ts # Discord client lifecycle (start/stop/test)
│   └── messageHandler.ts # @mention / DM detection and inline replies
├── commands/
│   ├── index.ts          # Command handler
│   └── commands.ts       # Slash command definitions
├── api/
│   ├── index.ts          # API manager
│   ├── accuweatherClient.ts # AccuWeather API client (weather data)
│   ├── nflClient.ts      # ESPN NFL API client (scores, schedules, news)
│   ├── serpApiClient.ts   # SerpAPI client (Google Search + AI Overview)
│   ├── comfyuiClient.ts  # ComfyUI API client (workflow execution)
│   ├── comfyuiWebSocket.ts # ComfyUI WebSocket manager (real-time execution tracking)
│   └── ollamaClient.ts   # Ollama API client
├── public/
│   ├── configurator.html # Web-based configurator SPA
│   └── activity.html     # Activity timeline page (key-protected)
└── utils/
    ├── config.ts         # Configuration loader (with hot-reload)
    ├── configWriter.ts   # Configuration persistence layer
    ├── logger.ts         # Unified logging system (console + file + configurator tail)
    ├── fileHandler.ts    # File output management
    ├── requestQueue.ts   # Request queue with API availability tracking
    ├── httpServer.ts     # Express HTTP server for configurator (localhost-only)
    ├── outputsServer.ts  # Express HTTP server for output file serving (public)
    ├── activityEvents.ts # Sanitised in-memory event buffer for activity feed
    ├── activityKeyManager.ts # In-memory rotating key for activity monitor access
    ├── keywordClassifier.ts  # AI-based keyword classification (Ollama fallback)
    ├── apiRouter.ts      # Multi-stage API routing pipeline
    └── responseTransformer.ts # Stage result extraction and context building

config/
├── keywords.default.json  # Default keyword definitions (tracked template)
└── keywords.json          # Runtime keyword config (auto-created from default, gitignored)

.config/
└── comfyui-workflow.json  # ComfyUI workflow template (uploaded via configurator)

tests/
├── config.test.ts        # Config module unit tests
├── configWriter.test.ts  # Config writer unit tests
├── fileHandler.test.ts   # File handler unit tests
├── logger.test.ts        # Logger unit tests
└── requestQueue.test.ts  # Request queue unit tests

outputs/
├── logs/                 # Daily log files
└── YYYY/MM/DDTHH:MM/     # Generated files organized by date
```

## Setup

### Prerequisites
- Node.js 16+
- npm or yarn
- A Discord Bot Token (can be configured after install via the web configurator)
- ComfyUI instance (optional, for image generation)
- Ollama instance (optional, for text generation)
- AccuWeather API key (optional, for weather data — free tier at [developer.accuweather.com](https://developer.accuweather.com))
- SerpAPI key (optional, for web search — free tier at [serpapi.com](https://serpapi.com))
- No API key required for NFL data (ESPN public API)

### Installation

1. Clone the repository:
```bash
git clone https://github.com/cchamp-msft/bob-bot-discord-app.git
cd bob-bot-discord-app
```

2. Install dependencies:
```bash
npm install
```

3. Create a `.env` file (can be empty — everything is configurable via the web UI):
```bash
cp .env.example .env
```

> All settings can be configured through the web configurator after starting the bot.
> If you prefer, you can pre-fill `.env` values before starting:
> `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `COMFYUI_ENDPOINT`, `OLLAMA_ENDPOINT`, `OLLAMA_MODEL`, `OLLAMA_SYSTEM_PROMPT`, `HTTP_PORT`, `HTTP_HOST`, `OUTPUTS_PORT`, `OUTPUTS_HOST`, `OUTPUTS_TRUST_PROXY`, `OUTPUT_BASE_URL`, `ACTIVITY_KEY_TTL`, `FILE_SIZE_THRESHOLD`, `DEFAULT_TIMEOUT`, `MAX_ATTACHMENTS`, `ERROR_MESSAGE`, `ERROR_RATE_LIMIT_MINUTES`, `REPLY_CHAIN_ENABLED`, `REPLY_CHAIN_MAX_DEPTH`, `REPLY_CHAIN_MAX_TOKENS`, `ALLOW_BOT_INTERACTIONS`, `IMAGE_RESPONSE_INCLUDE_EMBED`, `COMFYUI_DEFAULT_MODEL`, `COMFYUI_DEFAULT_WIDTH`, `COMFYUI_DEFAULT_HEIGHT`, `COMFYUI_DEFAULT_STEPS`, `COMFYUI_DEFAULT_CFG`, `COMFYUI_DEFAULT_SAMPLER`, `COMFYUI_DEFAULT_SCHEDULER`, `COMFYUI_DEFAULT_DENOISE`, `ACCUWEATHER_API_KEY`, `ACCUWEATHER_DEFAULT_LOCATION`, `ACCUWEATHER_ENDPOINT`, `NFL_BASE_URL`, `NFL_ENABLED`, `SERPAPI_API_KEY`, `SERPAPI_ENDPOINT`, `SERPAPI_HL`, `SERPAPI_GL`, `SERPAPI_LOCATION`

### Running the Bot

#### Quick start:
```bash
npm install
cp .env.example .env
npm run dev
```

The HTTP server starts immediately. Open **http://localhost:3000/configurator** to:
1. Enter your Discord bot **token** and **client ID**
2. Click **Test** to verify the token works
3. Click **Save Changes** to persist to `.env`
4. Click **▶ Start** to connect the bot to Discord

No restart needed — the bot connects on demand from the configurator.

#### Development mode (with auto-reload on code changes):
```bash
npm run dev:watch
```

#### Production mode:
```bash
npm run build
npm start
```

> If `DISCORD_TOKEN` is set in `.env`, the bot will auto-connect to Discord on startup.
> If not, it starts in configurator-only mode so you can set it up via the web UI.

#### Register slash commands:
```bash
npm run register
```
> Requires `DISCORD_TOKEN` and `DISCORD_CLIENT_ID` to be set in `.env`.

## Web Configurator

The bot includes a **localhost-only web configurator** for easy management without editing config files directly.

### Two-Server Architecture

The bot runs two independent HTTP servers:

| Server | Default Binding | Purpose |
|--------|----------------|---------|
| **Configurator** | `127.0.0.1:3000` | Web UI for setup and management (localhost-only) |
| **Outputs** | `0.0.0.0:3003` | Serves generated images so Discord can fetch them |

> ⚠️ **Security**: The configurator must never be exposed to the public internet. Only expose port 3003 (outputs) through your firewall. The outputs server serves static files, a health endpoint, and the public activity feed.

#### Public Activity Feed

The outputs server hosts a privacy-first activity timeline at `/activity` that shows the bot's decision-making as first-person narrative events. Access to the activity data API is protected by a rotating key that must be requested from the bot via Discord.

**Getting access**: Send `activity_key` to the bot (DM or @mention). The bot replies with a temporary key and the activity page URL. Enter the key when prompted on the activity page. Keys expire after `ACTIVITY_KEY_TTL` seconds (default 300 / 5 minutes, configurable in the HTTP Server section of the configurator).

| Endpoint | Description |
|----------|------------|
| `GET /activity` | HTML timeline page with auto-polling and image enlargement |
| `GET /api/activity` | JSON API returning `{ events, serverTime }` — requires `?key=<key>` or `x-activity-key` header |
| `GET /api/activity?since=<ISO>` | Incremental — only events after the given timestamp |
| `GET /api/activity?count=<n>` | Limit result count (default 50, max 100) |
| `GET /api/privacy-policy` | Returns `PRIVACY_POLICY.md` as plain text (lazy-loaded on link click) |

**Privacy guarantees** — activity events never contain:
- Raw message content or user prompts
- Discord user IDs, guild IDs, or guild/channel names
- API keys, endpoint URLs, or internal error details

Events are written as sanitized first-person narratives (e.g. *"Someone wants my attention in a server channel"*, *"I need to check the weather"*, *"I created 2 images for you"*) and are color-coded by type on the timeline page.

### Accessing the Configurator

1. Start the bot (`npm run dev`, `npm run dev:watch`, or `npm start`)
2. Open your browser to: **http://localhost:3000/configurator**
   - Both HTTP servers start immediately — no Discord connection required
   - ⚠️ Configurator is only accessible from localhost for security
   - Port matches your `HTTP_PORT` setting in `.env` (default: 3000)

### Configurator Features

- **Discord Connection**: Set client ID and bot token, test token validity, start/stop the bot
- **Bot Token**: Write-only field — token is never displayed or logged, only persisted to `.env`
- **Start/Stop Controls**: Connect or disconnect the bot from Discord without restarting the process
- **Connection Status**: Live indicator showing stopped / connecting / running / error
- **API Endpoints**: Configure ComfyUI/Ollama/AccuWeather/NFL URLs with live connection testing
- **AccuWeather**: API key (write-only), default location, endpoint configuration, and test connection with location resolution
- **NFL**: Enabled toggle, endpoint configuration, and test connection (no API key needed — ESPN public API)
- **Ollama Model Selection**: Test connection auto-discovers available models; select and save desired model
- **Ollama System Prompt**: Configurable system prompt sets the bot's personality; reset-to-default button included
- **ComfyUI Workflow Upload**: Upload a workflow JSON file with `%prompt%` placeholder validation
- **Default Workflow Builder**: Configure a basic text-to-image workflow with checkpoint model, image size, steps, sampler, scheduler, and denoise — no manual JSON editing required
- **ComfyUI Discovery**: Auto-detect available checkpoints, samplers, and schedulers from the connected ComfyUI instance
- **Workflow Export**: Download the currently active workflow as ComfyUI API format JSON for external testing
- **Error Handling**: Configure user-facing error message and rate limit interval
- **HTTP Server**: Adjust configurator port and output base URL
- **Two-Server Architecture**: Configurator runs on localhost:3000 (secure), outputs server on 0.0.0.0:3003 (public, for Discord image fetching)
- **Limits**: Set file size threshold, default timeout, and max attachments per message
- **Image Response**: Toggle whether image responses include the embed block with internal View link (off by default)
- **Keywords Management**: Add/edit/remove keyword→API mappings with custom timeouts
- **Status Console**: Real-time log view tailing today's log file, showing all events (startup, requests, errors, config changes) with color-coded levels

### Hot-Reload vs Restart Required

**Hot-Reload (no restart needed):**
- ComfyUI/Ollama/AccuWeather/NFL endpoints
- Ollama model selection
- Ollama system prompt
- AccuWeather API key and default location
- NFL enabled state
- Default workflow parameters (model, size, steps, sampler, scheduler, denoise)
- Error message and rate limit
- Reply chain settings (enabled, max depth, max tokens)
- Image response embed toggle
- Output base URL
- File size threshold
- Default timeout
- Max attachments per message
- Keywords (entire list)
- Discord token and client ID (stop and re-start the bot from configurator)

**Restart Required:**
- HTTP port

## Running Tests

The bot includes a comprehensive unit test suite covering configuration, logging, file handling, request queuing, message handling, API clients, and config persistence.

### Run all tests:
```bash
npm test
```

### Run tests in watch mode (auto-rerun on file changes):
```bash
npm run test:watch
```

### Test Coverage:
- **config.test.ts** — Environment parsing, public config, keyword routing
- **configWriter.test.ts** — .env persistence, keywords.json validation
- **config.test.ts** also covers keywords.default.json → keywords.json copy-on-startup
- **fileHandler.test.ts** — File saving, sanitization, path generation
- **logger.test.ts** — Log formatting, level mapping, console output, file tail
- **requestQueue.test.ts** — API locking, timeouts, concurrency
- **keywordClassifier.test.ts** — AI classification logic, prompt building, fallback handling
- **apiRouter.test.ts** — Multi-stage routing, partial failures, final pass logic, NFL routing
- **responseTransformer.test.ts** — Result extraction, context prompt building
- **accuweatherClient.test.ts** — Location resolution, weather data fetching, formatting, health checks
- **nflClient.test.ts** — ESPN adapter mapping, team resolution, game formatting, news methods, API fetching, health checks, request dispatching, season/week parsing

All tests run without requiring Discord connection or external APIs.

## Discord Intents & Permissions

The bot requires the following **Gateway Intents** configured in the [Discord Developer Portal](https://discord.com/developers/applications) under **Bot → Privileged Gateway Intents**:

| Intent | Required | Purpose |
|--------|----------|--------|
| `Guilds` | Yes | Access guild (server) metadata and channel lists |
| `GuildMessages` | Yes | Receive message events in server channels |
| `DirectMessages` | Yes | Receive DM messages from users |
| `MessageContent` | Yes ⚠️ | Read message text and access reply chain references (`message.reference`) |

> ⚠️ **`MessageContent` is a Privileged Intent.** It must be explicitly enabled in the Developer Portal. For bots in **100+ servers**, Discord requires verification and approval for this intent. Without it, the bot cannot read message content or traverse reply chains.

The bot also requires the following **Partials** (configured automatically in code):

| Partial | Purpose |
|---------|--------|
| `Channel` | Required for receiving DM messages (DM channels are not cached by default) |
| `Message` | Allows receiving uncached DM messages |

### Bot Permissions

When generating an OAuth2 invite link, include these **Bot Permissions**:

- **Send Messages** — reply to users
- **Read Message History** — fetch referenced messages in reply chains
- **Attach Files** — send generated images
- **Embed Links** — send ComfyUI response embeds
- **Use Slash Commands** — register and respond to `/generate` and `/ask`

## Reply Chain Context, Channel Context & DM History

The bot provides conversation context to Ollama in three ways:

- **Server (guild) messages — reply chain**: When a user replies to a previous message, the bot traverses the Discord reply chain to build **primary** conversation history.
- **Server (guild) messages — channel context**: Recent channel (or thread) messages are always collected as **secondary** context for guild interactions, even without a reply chain.
- **DMs**: Recent DM channel messages are included automatically as context — no explicit replies are needed. DM conversations flow naturally.

Primary (reply chain) and secondary (channel) context are collated into one chronological history. Reply-chain messages are de-duplicated from channel context and tagged with priority metadata so the model can weight them more heavily. The cumulative depth budget applies across both sources — primary messages fill first, then secondary fills remaining slots.

In all cases, context is sent to Ollama using the `/api/chat` endpoint with proper role-based messages (`user` / `assistant`), enabling multi-turn conversations.

### How It Works

**Server (reply chain + channel context)**:
1. User sends a message that @mentions the bot or replies to a previous bot response
2. If replying, the bot traverses `message.reference` links up the chain (primary context)
3. The bot also fetches recent messages from the channel/thread (secondary context)
4. Both sources are collated: de-duplicated by message ID and sorted chronologically
5. Each message is tagged as `user` or `assistant` based on the author, with a context-source marker (reply, channel, thread)
6. The collated conversation is sent to Ollama's chat API with the system prompt

**DMs (automatic history)**:
1. User sends a DM to the bot
2. Bot fetches recent messages from the DM channel (up to max depth)
3. Messages are tagged as `user` or `assistant` and sent as conversation context
4. No explicit reply chains are needed — DMs always include recent history

### Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `REPLY_CHAIN_ENABLED` | `true` | Set to `false` to disable reply chain traversal, channel context, and DM history |
| `REPLY_CHAIN_MAX_DEPTH` | `30` | Maximum messages to collect across all context sources (1–50) |
| `REPLY_CHAIN_MAX_TOKENS` | `16000` | Character budget for collected context (1,000–128,000) |
| `ALLOW_BOT_INTERACTIONS` | `false` | When `true`, the bot responds to messages from other bots and includes their messages in context history |

### Behavior Notes

- Reply chain traversal for **Ollama** builds multi-turn conversation history (primary context)
- **Channel context** is always collected for guild interactions — @mentions without replies still receive recent channel history
- Primary (reply chain) messages fill the depth budget first; secondary (channel) messages fill remaining slots
- When context exceeds depth or character budgets, the **newest** messages are kept (oldest context is dropped first)
- Messages are tagged with context source (`reply`, `channel`, `thread`, `dm`) in the prompt so the model understands their origin
- **DMs** automatically include recent DM channel messages as context (same depth/token limits apply, tagged as `dm`, no guild channel-context feature)
- **Other bots** are excluded from context history by default — set `ALLOW_BOT_INTERACTIONS=true` to include them and allow the bot to respond to other bots' messages
- **ComfyUI** image generation uses single-level reply context — the replied-to message content is prepended to the prompt
- Routing keywords (e.g., "generate", "imagine") are stripped from the prompt before submission to the image model
- Deleted or inaccessible messages in the chain are skipped gracefully
- Circular references are detected and traversal stops
- Bot responses are sent as **plain text** (not embed blocks) for a conversational feel

### Context Evaluation (Always Active)

The bot includes an **Ollama-powered context evaluator** that automatically determines how much reply-chain history is relevant before including it. This improves response quality when conversations shift topics.

Context evaluation runs whenever there is reply-chain, channel, or DM history — no per-keyword toggle is needed. Individual keywords may optionally override the default depth settings.

#### How It Works

1. After the reply chain / channel / DM history is collected and collated, the context evaluator sends the messages to Ollama along with the current user prompt.
2. Ollama determines which of the most recent messages are topically relevant. Messages tagged as primary (reply chain / thread) are signaled as higher-importance.
3. The most recent `contextFilterMinDepth` messages are **always included**, even if off-topic — this guarantees a baseline of context.
4. Ollama may include up to `contextFilterMaxDepth` messages total if they remain on-topic.
5. If topics diverge significantly, Ollama is instructed to use the most recent topic and transition naturally.
6. The evaluator uses **only** its own system prompt — the global persona/system prompt is not included in internal evaluation calls.

Depth is counted from the **newest** message (newest = depth 1), matching the "prioritize newest to oldest" design.

#### Per-Keyword Depth Overrides

These optional fields in `config/keywords.json` (runtime, or `config/keywords.default.json` for defaults) override the global defaults for a specific keyword:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `contextFilterMinDepth` | `integer` | `1` | Minimum most-recent messages to always include (>= 1) |
| `contextFilterMaxDepth` | `integer` | Global `REPLY_CHAIN_MAX_DEPTH` | Maximum messages eligible for inclusion (>= 1) |

Example keyword entry with depth overrides:
```json
{
  "keyword": "chat",
  "api": "ollama",
  "timeout": 300,
  "description": "Chat with Ollama AI",
  "contextFilterMinDepth": 2,
  "contextFilterMaxDepth": 8
}
```

#### Where the Evaluator Applies

- **Direct Ollama chat** (two-stage evaluation, stage 1) — filters history before the initial Ollama call.
- **Final Ollama pass** (for non-Ollama API keywords with `finalOllamaPass: true`) — filters history before the refinement call.
- If the primary API was already Ollama, the final pass is skipped (no double-filtering).

#### Notes

- **System messages** (abilities context, system prompts) are excluded from depth counting and always preserved at the front of the history.
- **Persona isolation**: The context evaluator and keyword classifier use their own dedicated system prompts — the global Ollama persona/system prompt is only included in user-facing chat responses, not in internal tool calls.
- **Performance**: Context evaluation adds one Ollama call per request to determine relevance. This is most beneficial for keywords with long reply chains (e.g., `chat`, discussion-style keywords). For short, single-turn interactions the overhead is minimal.
- **Failure behavior**: If the evaluation call fails or returns an unexpected response, the full unfiltered history is used as a graceful fallback — the bot never drops context silently.

## Two-Stage Evaluation & API Routing

The bot uses a two-stage evaluation flow to intelligently route requests. Keywords define available abilities that Ollama can discover and trigger during conversation.

### How It Works

1. **Regex matching** (fast path) — checked first for explicit keywords like "generate" or "weather"
2. **AI classification** (fallback) — if no regex match, Ollama analyzes the message intent and maps it to a registered keyword
3. **Direct API routing** — if a non-Ollama keyword is matched (regex or AI), the request is sent directly to the primary API
4. **Two-stage evaluation** — if an Ollama keyword is matched (e.g., "chat", "ask") or no keyword is matched, the request is sent to Ollama with an abilities context describing available API capabilities. Ollama's response is then re-evaluated via `classifyIntent()` — if it references an API keyword, that API is executed automatically
5. **Final refinement** (optional) — if a keyword has `finalOllamaPass: true`, the API result is sent through Ollama for a conversational response

### Keyword Configuration

Extended fields in `config/keywords.json` (or `config/keywords.default.json`):

```json
{
  "keywords": [
    {
      "keyword": "weather",
      "api": "accuweather",
      "timeout": 60,
      "description": "Get current weather conditions and 5-day forecast",
      "abilityText": "Get current weather conditions and 5-day forecast",
      "abilityWhen": "User asks about weather or current conditions for a location.",
      "abilityInputs": {
        "mode": "explicit",
        "required": ["location"],
        "validation": "Location must be a valid worldwide city name, region, or US postal code.",
        "examples": ["weather Dallas", "weather 90210"]
      }
    },
    {
      "keyword": "nfl scores",
      "api": "nfl",
      "timeout": 30,
      "description": "Get current NFL game scores",
      "abilityText": "Get current NFL game scores",
      "abilityWhen": "User asks about NFL scores or game results.",
      "abilityInputs": {
        "mode": "mixed",
        "optional": ["date"],
        "inferFrom": ["current_message"],
        "validation": "Date must be YYYYMMDD or YYYY-MM-DD. If omitted, returns the most recent scoreboard."
      },
      "finalOllamaPass": true,
      "allowEmptyContent": true
    }
  ]
}
```

#### Keyword Fields Reference

| Field | Type | Description |
|-------|------|-------------|
| `keyword` | `string` | **Required.** The trigger word or phrase. |
| `api` | `string` | **Required.** Target API: `comfyui`, `ollama`, `accuweather`, `nfl`, or `serpapi`. |
| `timeout` | `number` | **Required.** Request timeout in seconds. |
| `description` | `string` | **Required.** Human-readable description shown in the configurator. |
| `abilityText` | `string` | Model-facing description of the ability. Falls back to `description` if omitted. Editable in the configurator detail row. |
| `abilityWhen` | `string` | Model-facing guidance on when to choose this ability (e.g. "User asks about weather."). |
| `abilityInputs` | `object` | Structured input guidance for the model. See sub-fields below. |
| `finalOllamaPass` | `boolean` | Pass the API result through Ollama for conversational refinement using the global final-pass model. |
| `allowEmptyContent` | `boolean` | When `true`, the keyword works without additional user text (e.g. `nfl scores` alone). When `false` or absent, the bot prompts the user to include content after the keyword. |
| `accuweatherMode` | `'current' \| 'forecast' \| 'full'` | AccuWeather data scope (default: `full`). Only used when `api` is `accuweather`. |
| `enabled` | `boolean` | Whether the keyword is active (default: `true`). |
| `retry` | `object` | Per-keyword retry override. Sub-fields: `enabled` (bool), `maxRetries` (0-10), `model` (string), `prompt` (string). |
| `contextFilterMinDepth` | `number` | Minimum context messages to always include (>= 1). |
| `contextFilterMaxDepth` | `number` | Maximum context messages eligible for inclusion (>= 1). |

**`abilityInputs` sub-fields:**

| Sub-field | Type | Description |
|-----------|------|-------------|
| `mode` | `'explicit' \| 'implicit' \| 'mixed'` | **Required.** How inputs are provided: user must state them, inferred from context, or a mix. |
| `required` | `string[]` | Required input names (e.g. `["location"]`). |
| `optional` | `string[]` | Optional input names (e.g. `["date"]`). |
| `inferFrom` | `string[]` | Sources to infer inputs from (e.g. `["current_message", "reply_target"]`). |
| `validation` | `string` | Plain-language validation constraints for the model. |
| `examples` | `string[]` | 1-2 short usage examples. |

All keyword fields are surfaced in the configurator via an expandable detail row per keyword. Fields that already have data are auto-expanded on load.

### Global Final-Pass Model

The `OLLAMA_FINAL_PASS_MODEL` environment variable (configurable in the configurator) specifies which Ollama model to use for all final-pass refinements. If not set, the default `OLLAMA_MODEL` is used.

### Ability Logging

The `ABILITY_LOGGING_DETAILED` environment variable (configurable in the configurator) enables verbose logging of the abilities context sent to Ollama during two-stage evaluation. When disabled (default), only a summary count is logged. When enabled, the full abilities text is logged to help debug routing behavior. This is also automatically enabled when `DEBUG_LOGGING` is active.

### Debug Logging

Set `DEBUG_LOGGING=true` in `.env` to enable comprehensive verbose logging. When enabled, the following are logged in full (hot-reloadable — no restart required):

1. **Messages received** — full message content (normally truncated to 100 chars)
2. **Messages sent** — full reply content (normally truncated to 200 chars)
3. **Abilities prompt** — full abilities context sent to Ollama (overrides `ABILITY_LOGGING_DETAILED`)
4. **Context-eval prompt** — full system prompt and conversation history sent for context evaluation
5. **API requests** — full request payloads for Ollama, AccuWeather, ComfyUI, and NFL
6. **API responses** — full response content from all API backends (overrides `NFL_LOGGING_LEVEL`)

Debug log lines are tagged with `[debug]` level and `DEBUG:` prefix for easy filtering. Reply content is always logged — truncated to 200 chars by default, or in full when debug is active.

### Log Prefixes

System logs use consistent prefixes to identify their source:

| Prefix | Source | Description |
|--------|--------|-------------|
| `KEYWORD:` | messageHandler | Keyword matching results |
| `TWO-STAGE:` | messageHandler | Two-stage Ollama evaluation flow |
| `REPLY-CHAIN:` | messageHandler | Reply chain traversal |
| `DM-HISTORY:` | messageHandler | DM history collection |
| `CONTEXT-EVAL:` | contextEvaluator | Context relevance filtering |
| `API-ROUTING:` | apiRouter | API routing pipeline |
| `CLASSIFIER:` | keywordClassifier | AI-based keyword classification |
| `BOT:` | discordManager | Discord bot lifecycle |
| `HTTP-SERVER:` | httpServer | Configurator HTTP server events |
| `OUTPUTS-SERVER:` | outputsServer | Outputs file server events |

### Example Flows

- **Simple**: `generate` → ComfyUI (direct API call)
- **Weather→AI**: `weather report` (AccuWeather) → `finalOllamaPass: true` → Ollama formats the weather data
- **Two-stage**: User says "is it going to rain?" → no keyword match → Ollama with abilities → response mentions weather → AccuWeather triggered → Ollama formats result
- **AI-classified**: User says "can you draw a sunset?" → AI identifies intent as "generate" → routes to ComfyUI
- **No API match**: User says "tell me a joke" → Ollama with abilities → response has no API keywords → Ollama response returned directly

### Error Handling

- If the final Ollama pass fails, the raw API result is returned
- If two-stage evaluation finds an API keyword but the API call fails, an error is reported to the user
- If AI classification fails or returns no match, the request goes through two-stage evaluation

## Usage

### Ollama Model Configuration

Ollama models are discovered automatically when you click **Test** in the configurator's API Endpoints section. The model list is fetched from the Ollama `/api/tags` endpoint and populates the dropdown. Select a model and click **Save Changes** to persist it to `.env` as `OLLAMA_MODEL`.

If no model is configured or the selected model becomes unavailable, the bot will return an error to the console and send a rate-limited error message to Discord users.

The `/ask` slash command also accepts an optional `model` parameter to override the default on a per-request basis.

### ComfyUI Workflow Configuration

ComfyUI uses workflow JSON files to define generation pipelines. There are two ways to configure a workflow:

#### Option 1: Default Workflow and Sampler Overrides (Recommended for Getting Started)

The configurator includes a **Workflow Settings** section that generates a basic text-to-image workflow from configurable parameters. The sampler parameters also act as overrides when a custom workflow is used (see Option 2).

| Parameter | Default | Description |
|-----------|---------|-------------|
| `COMFYUI_DEFAULT_MODEL` | *(none)* | Checkpoint model file (e.g. `sd_xl_base_1.0.safetensors`) |
| `COMFYUI_DEFAULT_WIDTH` | `512` | Latent image width (must be divisible by 8) |
| `COMFYUI_DEFAULT_HEIGHT` | `512` | Latent image height (must be divisible by 8) |
| `COMFYUI_DEFAULT_STEPS` | `20` | Number of sampling steps |
| `COMFYUI_DEFAULT_CFG` | `7.0` | Classifier-free guidance scale |
| `COMFYUI_DEFAULT_SAMPLER` | `euler_ancestral` | Sampler algorithm |
| `COMFYUI_DEFAULT_SCHEDULER` | `beta` | Noise scheduler |
| `COMFYUI_DEFAULT_DENOISE` | `0.88` | Denoise strength (0–1.0) |

> **Scope:** `COMFYUI_DEFAULT_MODEL`, `COMFYUI_DEFAULT_WIDTH`, and `COMFYUI_DEFAULT_HEIGHT` apply only to the default workflow (they configure `CheckpointLoaderSimple` and `EmptyLatentImage` nodes). The remaining five parameters are also applied as sampler overrides to custom uploaded workflows (see below).

Click **Discover Options** in the configurator to populate dropdowns with available checkpoints, samplers, and schedulers from your connected ComfyUI instance.

The generated workflow uses `CheckpointLoaderSimple` (providing MODEL, CLIP, and VAE), two `CLIPTextEncode` nodes (positive/negative), `EmptyLatentImage`, `KSampler`, `VAEDecode`, and `SaveImage`.

#### Option 2: Custom Workflow Upload (Advanced)

Upload a workflow JSON file through the configurator for full control:

1. Export your workflow from ComfyUI as a JSON file (API format)
2. Edit the workflow JSON to replace the positive prompt value with the placeholder `%prompt%`
3. Upload the file via the configurator's **ComfyUI Workflow** upload field
4. The server validates that the file is valid JSON and contains at least one `%prompt%` placeholder

**Important:** The `%prompt%` placeholder is **case-sensitive**. Use exactly `%prompt%` — variations like `%PROMPT%` or `%Prompt%` will not be recognized.

When a Discord user triggers image generation, all occurrences of `%prompt%` in the workflow are replaced with the user's prompt text, and the resulting workflow is submitted to ComfyUI's `/api/prompt` endpoint.

The workflow is stored in `.config/comfyui-workflow.json`.

**KSampler Override:** When a custom workflow contains one or more `KSampler` nodes (node `class_type` must be exactly `KSampler`), the bot automatically overrides their `steps`, `cfg`, `sampler_name`, `scheduler`, and `denoise` inputs using the values from the Workflow Settings section. The existing `seed` in the uploaded workflow is preserved. Nodes with other class types (e.g. `KSamplerAdvanced`) are not affected.

**Workflow Precedence:** If a custom workflow is uploaded, it always takes priority over the default workflow. Remove the custom workflow via the configurator to revert to default workflow settings.

#### Exporting Workflows for ComfyUI Testing

The configurator includes an **Export Current Workflow** button that downloads the currently active workflow (custom or default) as a JSON file in ComfyUI API format. The exported file can be submitted directly to ComfyUI's `/prompt` endpoint for testing outside the bot.

The `%prompt%` placeholder is preserved in the export — replace it manually with your test prompt text before submitting to ComfyUI.

### AccuWeather Configuration

The bot integrates with [AccuWeather](https://developer.accuweather.com) for real-time weather data. A free-tier API key provides 50 calls/day.

#### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ACCUWEATHER_API_KEY` | Yes | API key from AccuWeather Developer Portal |
| `ACCUWEATHER_DEFAULT_LOCATION` | No | Default location for the `/weather` slash command when no location is specified. Keyword-based weather commands always require a location (e.g. `weather Seattle`). |
| `ACCUWEATHER_ENDPOINT` | No | Base URL override (default: `https://dataservice.accuweather.com`) |

#### Location Resolution

The bot supports multiple location input formats:
- **City names**: `Seattle`, `New York City`, `London`
- **US zip codes** (5 digits): `90210`, `98101`
- **AccuWeather location keys** (numeric): `351409`

When a user says "weather in Seattle", the bot extracts "Seattle", resolves it via AccuWeather's location search API, and fetches weather data.

#### Weather Keywords

Four default weather keywords are configured in `config/keywords.default.json`. All require a location parameter:

| Keyword | Mode | Behavior |
|---------|------|----------|
| `weather <location>` | full | Direct weather report (current + forecast) |
| `forecast <location>` | forecast | Direct 5-day forecast only |
| `conditions <location>` | current | Direct current conditions only |
| `weather report <location>` | full | Weather data routed through Ollama for AI-powered report |

> **Note:** Unlike the `/weather` slash command which falls back to `ACCUWEATHER_DEFAULT_LOCATION`, keyword-based weather commands require a location. Sending just `weather` with no location will prompt the user to include a query.

#### Weather Slash Command

The `/weather` slash command supports two optional parameters. When no location is specified, it falls back to `ACCUWEATHER_DEFAULT_LOCATION`:

```
/weather                          # Default location, full report
/weather location: Chicago        # Specified location, full report
/weather location: 90210 type: forecast   # Zip code, forecast only
/weather type: current            # Default location, current conditions
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `location` | string (optional) | City name, zip code, or location key |
| `type` | choice (optional) | `current`, `forecast`, or `full` (default: `full`) |

### NFL Game Data

The bot integrates with [ESPN's public API](https://site.api.espn.com/apis/site/v2/sports/football/nfl) for NFL game scores and news. No API key is required.

#### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `NFL_BASE_URL` | No | Base URL override (default: `https://site.api.espn.com/apis/site/v2/sports/football/nfl`) |
| `NFL_ENABLED` | No | Enable/disable NFL features (default: `true`) |

#### NFL Keywords

Two NFL keywords are configured in `config/keywords.default.json`:

| Keyword | Behavior |
|---------|----------|
| `nfl scores` | Lists all games for the current week. Supports date lookups: `nfl scores 20260208` or `nfl scores 2026-02-08` |
| `nfl news` | Shows the latest NFL news headlines. Supports keyword filtering: `nfl news chiefs` |

Both keywords have `allowEmptyContent: true`, so they work without additional text.

#### Date-Based Score Lookups

Use `YYYYMMDD` or `YYYY-MM-DD` format to look up scores for a specific date:
- `nfl scores 20260208` — scores for games on February 8, 2026
- `nfl scores 2026-02-08` — same, with dashes

When no date is provided, the current week's scoreboard is shown.

#### News Filtering

Add a search term after `nfl news` to filter articles by headline or description:
- `nfl news chiefs` — only articles mentioning "chiefs"
- `nfl news trade` — only articles mentioning "trade"

Without a filter, the 5 most recent articles are shown.

#### Endpoint Selection

| Query type | ESPN Endpoint | Cache TTL |
|-----------|---------------|----------|
| Current week (no date) | `/scoreboard` | 60s live, 300s final |
| Specific date | `/scoreboard?dates=YYYYMMDD` | 60s live, 300s final |
| News | `/news` | 300s |

### @mention Usage

Mention the bot with a keyword and prompt:
```
@BobBot generate a beautiful sunset landscape
@BobBot ask what is the meaning of life?
@BobBot weather in Seattle
@BobBot forecast for 90210
@BobBot nfl scores
@BobBot nfl scores 20260208
@BobBot nfl news
@BobBot nfl news chiefs
```

The bot replies inline — the initial "Processing" message is edited in-place with the final response. You can also DM the bot directly without needing an @mention.

### Slash Commands
Use slash commands for ephemeral responses:
```
/generate prompt: a beautiful sunset landscape
/ask question: what is the meaning of life? model: llama2
/weather location: Seattle type: full
/weather location: 90210 type: forecast
```

## API Rate Limiting

- **Serial Processing**: Only 1 request per API endpoint at a time
- **FIFO Queueing**: Additional requests are queued and processed in order
- **Timeout + Abort**: When a request times out, its `AbortSignal` is triggered, cancelling the underlying HTTP call so it doesn't overlap with subsequent work. Timeout covers active execution time only (not time waiting in the queue)
- **Discord Rate Limits**: Respects Discord API rate limits

## Output Organization

Files are organized in the `outputs/` directory:

```
outputs/
├── logs/
│   └── 2024-02-05.log
└── 2024/02/05T14:30/
    ├── username-generated_image.png
    └── username-response_text.txt
```

Log format:
```
[2024-02-05T14:30:45.123Z] [info] [success] [username] REQUEST: [generate] create an image
[2024-02-05T14:30:52.456Z] [info] [success] [username] REPLY: ComfyUI response sent: 1 images
[2024-02-05T14:30:55.789Z] [error] [error] [system] ERROR: Connection refused
```

Every log line is written identically to:
1. **Console** (`stdout`/`stderr`) — visible when running `npm start` or `npm run dev`
2. **Log file** — daily files in `outputs/logs/YYYY-MM-DD.log`
3. **Configurator status console** — tails today's log file in real time

Log levels (`info`, `warn`, `error`) are derived from the status tag and control console output method (`console.log`, `console.warn`, `console.error`) as well as color coding in the configurator.

## Troubleshooting

### Bot doesn't respond to mentions
- Check `DISCORD_TOKEN` is correct
- Ensure bot has permission to read messages in the channel
- Verify `DISCORD_CLIENT_ID` matches your bot's client ID
- Run `npm run register` to register slash commands

### "API Busy" message appears frequently
- Check if ComfyUI/Ollama is running
- Use the **configurator** to test API connectivity
- Increase timeout values if requests are taking longer than expected
- Check API health at configured endpoints

### Files not accessible via URL
- Verify `OUTPUT_BASE_URL` is correct
- Ensure HTTP server is running on configured port
- Check firewall/network settings

### ComfyUI WebSocket connection issues
- The bot uses WebSockets (`ws://`) for real-time progress tracking with ComfyUI
- If WebSocket connection fails, the bot automatically falls back to HTTP polling
- If you see "WebSocket connection failed" errors, verify ComfyUI is accessible at the configured endpoint
- The WebSocket URL is derived from the HTTP endpoint (e.g., `http://localhost:8190` → `ws://localhost:8190/ws`)
- Ensure ComfyUI is not behind a proxy that blocks WebSocket connections
- The bot will automatically reconnect with retry logic if the connection drops

### ComfyUI logging error causing workflow failures
If no output is being returned and upon checking ComfyUI logs you see an exceptions referencing `tqdm`, then use port 8190 instead 8188 so the progress meter does not result in an exception while running the sampler node.

### Cannot access configurator
- Verify you're accessing from `http://localhost:{HTTP_PORT}/configurator`
- Configurator is **localhost-only** — remote access is blocked for security
- The HTTP server starts immediately on `npm run dev` / `npm start` — no Discord connection needed
- When `ADMIN_TOKEN` is set, every configurator request must include an `Authorization: Bearer <token>` header

### Reverse proxy / SSL termination
- This app does **not** terminate TLS itself. Use a trusted reverse SSL/TLS proxy for public inbound ports
- By default, both servers use `trust proxy = false` — `req.ip` is always the direct socket address and cannot be spoofed via `X-Forwarded-For` headers
- `OUTPUTS_TRUST_PROXY` can be set for outputs-server client IP handling (`false`, `true`, or a hop count like `1`) when running behind a trusted proxy/load balancer
- If the configurator must be reachable through a reverse proxy (e.g. for remote administration), **set `ADMIN_TOKEN`** to a strong random value (`openssl rand -hex 32`). Without it the only protection is the localhost IP check, which can be bypassed if the proxy forwards traffic from the same host
- Never expose the configurator/admin port directly to the public internet. Keep it private and enforce strict IP filtering + authentication in the proxy layer
- The outputs server (port 3003) is designed for public access — if placed behind a TLS-terminating proxy, set `OUTPUT_BASE_URL` to the external HTTPS URL so generated image links work correctly (e.g. `OUTPUT_BASE_URL=https://cdn.example.com`). The activity feed (`/activity`) serves static HTML publicly; `GET /api/activity` requires a valid rotating key obtained from the bot via Discord
- The configurator server never enables `trust proxy`. The outputs server enables it only when `OUTPUTS_TRUST_PROXY` is set — HTTPS is assumed to be handled entirely upstream
- Restrict the configurator's upstream proxy route to trusted IP ranges / authentication at the proxy layer as an additional defence in depth

### Staging / deployment notes
- The configurator server binds to `127.0.0.1` by default; the outputs server binds to `0.0.0.0`
- Admin/configurator routes are guarded by `ADMIN_TOKEN` + localhost IP check; output files are served publicly
- Changing `HTTP_PORT`, `HTTP_HOST`, `OUTPUTS_PORT`, `OUTPUTS_HOST`, or `OUTPUTS_TRUST_PROXY` requires a full process restart (the configurator will report this)

### Config changes not applying
- **API endpoints & keywords**: Use configurator's "Save Changes" button (hot-reload, no restart)
- **Discord token**: Save, then stop and re-start the bot from the configurator
- **HTTP port**: Requires full process restart
- Check the configurator's status console for reload confirmation

### SerpAPI / AI Overview ("second opinion") issues
- **Enable debug logging** (`DEBUG_LOGGING=true`) to see request/response diagnostics tagged `[serpapi]`
- **Request shape** — look for `SERPAPI REQUEST:` lines showing `engine`, `q`, `hl`, `gl`, `location`, and redacted `api_key` (`***`)
- **Response markers** — look for `SERPAPI RESPONSE:` lines showing `status`, `ai_overview` classification (`page_token`, `inline(N blocks)`, `error: …`, `empty`, or `absent`), and organic result count
- **AIO follow-up** — when a `page_token` is present, the bot issues a second request using `engine=google_ai_overview`. Look for `AIO-FOLLOWUP REQUEST:` and `AIO-FOLLOWUP RESPONSE:` debug lines
- **Common causes of missing AI Overviews:**
  - **Locale mismatch** — AI Overview is mainly available for `hl=en` with certain `gl` values (e.g. `us`). Set `SERPAPI_HL` and `SERPAPI_GL` in your `.env`
  - `SERPAPI_LOCATION` can improve AIO eligibility on the initial search, but it is **not sent** on the AI Overview follow-up call (the follow-up inherits locale from the original search)
  - **Niche or policy-restricted queries** — Google may simply not generate an AI Overview; this is upstream unavailability, not a configuration problem
  - **Token expiry** — the `page_token` for AIO follow-up expires within ~1 minute; if the bot or SerpAPI is slow, the follow-up may silently return no data
- **Distinguishing upstream unavailability from config issues:**
  - If debug logs show `ai_overview=absent` consistently across many queries including common factual ones (`"what is TypeScript"`, `"weather in New York"`), the issue is likely locale configuration
  - If only niche or ambiguous queries return `absent`, that is expected upstream behavior
  - If logs show `ai_overview=error: …`, the error message from Google/SerpAPI indicates a policy or rate-limit issue

## Contributing

Contributions are welcome! Please submit pull requests with improvements.

## License

MIT
