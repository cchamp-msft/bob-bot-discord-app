# Architecture Documentation

This document provides technical details about Bob Bot's internal architecture, request processing, and context management.

## Project Structure

```
src/
├── index.ts              # Main bot entry point
├── bot/
│   ├── discordManager.ts # Discord client lifecycle (start/stop/test)
│   └── messageHandler.ts # @mention / DM detection, image extraction, and inline replies
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
    ├── threadContext.ts  # Per-queue-item thread ID via AsyncLocalStorage
    ├── fileHandler.ts    # File output management
    ├── requestQueue.ts   # Request queue with API availability tracking
    ├── httpServer.ts     # Express HTTP server for configurator (localhost-only)
    ├── outputsServer.ts  # Express HTTP server for output file serving (public)
    ├── activityEvents.ts # Sanitised in-memory event buffer for activity feed
    ├── activityKeyManager.ts # In-memory rotating key for activity monitor access
    ├── keywordClassifier.ts  # AI-based keyword classification & abilities context builder
    ├── toolsSchema.ts    # OpenAI-style tool definitions from keyword config (Ollama native tools)
    ├── apiRouter.ts      # Multi-stage API routing pipeline
    └── responseTransformer.ts # Stage result extraction and context building

config/
├── tools.default.xml      # Default tool definitions (tracked XML template)
└── tools.xml              # Runtime tools config (auto-created from default, gitignored)

.config/
└── comfyui-workflow.json  # ComfyUI workflow template (uploaded via configurator)

tests/
├── config.test.ts        # Config module unit tests
├── configWriter.test.ts  # Config writer unit tests
├── fileHandler.test.ts   # File handler unit tests
├── logger.test.ts        # Logger unit tests
├── threadContext.test.ts  # Thread context / correlation ID tests
└── requestQueue.test.ts  # Request queue unit tests

outputs/
├── logs/                 # Daily log files
└── YYYY/MM/DDTHH:MM/     # Generated files organized by date
```

## Discord Intents & Permissions

### Required Gateway Intents

The bot requires the following **Gateway Intents** configured in the [Discord Developer Portal](https://discord.com/developers/applications) under **Bot → Privileged Gateway Intents**:

| Intent | Required | Purpose |
|--------|----------|--------|
| `Guilds` | Yes | Access guild (server) metadata and channel lists |
| `GuildMessages` | Yes | Receive message events in server channels |
| `DirectMessages` | Yes | Receive DM messages from users |
| `MessageContent` | Yes ⚠️ | Read message text and access reply chain references (`message.reference`) |

> ⚠️ **`MessageContent` is a Privileged Intent.** It must be explicitly enabled in the Developer Portal. For bots in **100+ servers**, Discord requires verification and approval for this intent. Without it, the bot cannot read message content or traverse reply chains.

### Required Partials

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

## Two-Stage Evaluation & API Routing

The bot uses a two-stage evaluation flow to intelligently route requests. Keyword/tool definitions live in the runtime config (e.g. `config/keywords.json` or `config/tools.xml`). **Internal-only** entries (e.g. `help`, `activity_key`) have a tag so they are **not** sent to Ollama as tools; they are used only for direct bypass (e.g. `!help`).

### Native tools path (when tools are available)

When the config yields at least one routable tool (enabled, not builtin, api ≠ ollama, not internal-only):

1. **Tools schema** — `buildOllamaToolsSchema()` converts keyword config into OpenAI-style tool definitions and passes them to Ollama as the `tools` parameter on `/api/chat`.
2. **Ollama response** — The model may return structured `tool_calls` (max **3** per turn, enforced in code). If it returns only text, that is sent as the chat reply.
3. **Tool execution** — Each tool call is resolved to a keyword config; arguments are converted to the single content string each API expects. `executeRoutedRequest()` runs without a per-call final pass.
4. **Single final pass** — All tool results are combined and sent to **one** final Ollama call for conversational refinement, then the reply is sent to the user.

Keywords in `config/tools.xml` may be stored with or without the `!` prefix. The routing engine normalises all keywords to include the prefix before matching, ensuring `!activity_key` matches a config entry stored as `"activity_key"`.

### Legacy path (no tools or tools disabled)

When there are no routable tools:

1. **Regex matching** (fast path) — explicit keywords like `!generate` or `!weather` are matched first.
2. **Direct API routing** — if a non-Ollama keyword is matched by regex, the request goes to the primary API (per-keyword `finalOllamaPass` still applies).
3. **Two-stage with abilities block** — if an Ollama keyword is matched (e.g. "chat") or no keyword matches, the request is sent to Ollama with a text abilities block. `parseFirstLineKeyword()` checks the first line for an API keyword (with optional inline parameters). If matched, `inferAbilityParameters()` may extract parameters before routing.
4. **Final refinement** — model-inferred abilities from step 3 go through a final Ollama call. Direct `!keyword` routing respects the keyword's `finalOllamaPass` setting.

### Keyword prefix normalisation

Keywords in config may be stored with or without the `!` prefix. The routing engine normalises before matching, so `!activity_key` matches a config entry stored as `"activity_key"`.

### Example flows

- **Direct**: `!weather Seattle` → AccuWeather
- **Native tools**: User says "what's the weather in Dallas and generate a sunset image" → Ollama returns two tool_calls → both run → one final pass with combined results
- **Legacy two-stage**: No tools configured → user says "is it going to rain?" → Ollama with abilities block → first line matches `weather` → AccuWeather → final Ollama pass
- **Internal-only**: `!help` → handled directly, never sent to Ollama as a tool

### Error handling

- If the final Ollama pass fails, the raw API result is returned.
- If a tool call or legacy-routed API call fails, an error is reported to the user.

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
| `REPLY_CHAIN_IMAGE_MAX_DEPTH` | `5` | Maximum reply-chain messages to scan for image attachments (0–50). Set to 0 to disable reply-chain image collection. Independent of `REPLY_CHAIN_MAX_DEPTH`. |
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
- Routing keywords (e.g., `!generate`, `!imagine`) are stripped from the prompt before submission to the image model
- Deleted or inaccessible messages in the chain are skipped gracefully
- Circular references are detected and traversal stops
- Bot responses are sent as **plain text** (not embed blocks) for a conversational feel

## Context Evaluation (Per-Keyword Toggle)

The bot includes an **Ollama-powered context evaluator** that determines how much conversation history is relevant before including it. This improves response quality when conversations shift topics.

Context evaluation is **opt-in per keyword** via the `contextFilterEnabled` field (or the **Ctx Eval** checkbox in the configurator). When omitted, it defaults to `false` — context evaluation is skipped and the full collected history is passed through. Built-in keywords are unaffected by this setting.

### How It Works

1. After the reply chain / channel / DM history is collected and collated, the context evaluator sends the messages to Ollama along with the current user prompt — **only when `contextFilterEnabled` is `true` for the matched keyword**.
2. Ollama determines which of the most recent messages are topically relevant. Messages tagged as primary (reply chain / thread) are signaled as higher-importance.
3. The most recent `contextFilterMinDepth` messages are **always included**, even if off-topic — this guarantees a baseline of context.
4. Ollama may include up to `contextFilterMaxDepth` messages total if they remain on-topic.
5. If topics diverge significantly, Ollama is instructed to use the most recent topic and transition naturally.
6. The evaluator uses **only** its own system prompt — the global persona/system prompt is not included in internal evaluation calls.

Depth is counted from the **newest** message (newest = depth 1), matching the "prioritize newest to oldest" design.

### Per-Keyword Depth Overrides

These optional fields in `config/tools.xml` override the global defaults for a specific tool:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `contextFilterEnabled` | `boolean` | `false` | Enable Ollama context evaluation for this keyword |
| `contextFilterMinDepth` | `integer` | `1` | Minimum most-recent messages to always include (>= 1) |
| `contextFilterMaxDepth` | `integer` | Global `REPLY_CHAIN_MAX_DEPTH` | Maximum messages eligible for inclusion (>= 1) |

### Where the Evaluator Applies

- **Direct Ollama chat** (two-stage evaluation, stage 1) — filters history before the initial Ollama call, only when `contextFilterEnabled` is `true`.
- **Final Ollama pass** (for non-Ollama API keywords with `finalOllamaPass: true`) — always filters history before the refinement call (unaffected by per-keyword toggle).
- If the primary API was already Ollama, the final pass is skipped (no double-filtering).

### Notes

- **System messages** (abilities context, system prompts) are excluded from depth counting and always preserved at the front of the history.
- **Persona isolation**: The context evaluator uses its own dedicated system prompt — the global Ollama persona/system prompt is only included in user-facing chat responses, not in internal tool calls.
- **Performance**: Context evaluation adds one Ollama call per request to determine relevance. This is most beneficial for keywords with long reply chains (e.g., `!chat`, discussion-style keywords). For short, single-turn interactions the overhead is minimal.
- **Failure behavior**: If the evaluation call fails or returns an unexpected response, the full unfiltered history is used as a graceful fallback — the bot never drops context silently.

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

## Logging System

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
| `CLASSIFIER:` | keywordClassifier | Abilities context builder |
| `BOT:` | discordManager | Discord bot lifecycle |
| `HTTP-SERVER:` | httpServer | Configurator HTTP server events |
| `OUTPUTS-SERVER:` | outputsServer | Outputs file server events |

### Debug Logging

Set `DEBUG_LOGGING=true` in `.env` to enable comprehensive verbose logging. When enabled, the following are logged in full (hot-reloadable — no restart required):

1. **Messages received** — full message content (normally truncated to 100 chars)
2. **Messages sent** — full reply content (normally truncated to 200 chars)
3. **Abilities prompt** — full abilities context sent to Ollama (overrides `ABILITY_LOGGING_DETAILED`)
4. **Context-eval prompt** — full system prompt and conversation history sent for context evaluation
5. **API requests** — full request payloads for Ollama, AccuWeather, ComfyUI, and NFL
6. **API responses** — full response content from all API backends (overrides `NFL_LOGGING_LEVEL`)

Debug log lines are tagged with `[debug]` level and `DEBUG:` prefix for easy filtering. Reply content is always logged — truncated to 200 chars by default, or in full when debug is active.

## Next Steps

- **[Advanced Features](ADVANCED.md)** — Keyword configuration, ability logging, final-pass model
- **[API Integration](API_INTEGRATION.md)** — Detailed API configuration
- **[Usage Guide](USAGE.md)** — How to use the bot
