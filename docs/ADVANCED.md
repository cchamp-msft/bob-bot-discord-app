# Advanced Features

This document covers advanced configuration options and features for power users.

## Tool Configuration

Tools define how the bot routes requests to different APIs. They can be configured via the web configurator or by editing `config/tools.xml`.

### Tool Fields Reference

| XML Element | Type | Description |
|-------------|------|-------------|
| `<name>` | `string` | **Required.** The trigger word or phrase (maps to internal keyword). |
| `<api>` | `string` | **Required.** Target API: `comfyui`, `ollama`, `accuweather`, `nfl`, `serpapi`, or `meme`. |
| `<timeout>` | `number` | **Required.** Request timeout in seconds. |
| `<description>` | `string` | **Required.** Human-readable description (also used as model-facing ability text). |
| `<abilityWhen>` | `string` | Model-facing guidance on when to choose this ability (e.g. "User asks about weather."). |
| `<parameters>` | `element` | OpenAI-style parameter definitions. See sub-fields below. |
| `<finalOllamaPass>` | `boolean` | Pass the API result through Ollama for conversational refinement using the global final-pass model. |
| `<allowEmptyContent>` | `boolean` | When `true`, the keyword works without additional user text (e.g. `!nfl scores` alone). |
| `<enabled>` | `boolean` | Whether the tool is active (default: `true`). |
| `<builtin>` | `boolean` | Built-in tools cannot be edited or deleted — only toggled on/off. |
| `<retry>` | `element` | Per-tool retry override. Child elements: `<enabled>`, `<maxRetries>` (0-10), `<model>`, `<prompt>`. |
| `<contextFilterEnabled>` | `boolean` | Enable Ollama context evaluation for this tool (default: `false`). |
| `<contextFilterMinDepth>` | `number` | Minimum context messages to always include (>= 1). |
| `<contextFilterMaxDepth>` | `number` | Maximum context messages eligible for inclusion (>= 1). |

### Parameters Configuration

The `<parameters>` element provides OpenAI-style structured guidance to the AI about what inputs a tool requires:

| Child Element | Type | Description |
|---------------|------|-------------|
| `<mode>` | `'explicit' \| 'implicit' \| 'mixed'` | **Required.** How inputs are provided: user must state them, inferred from context, or a mix. |
| `<inferFrom>` | `string` | Comma-separated inference sources (e.g. `reply_target, current_message`). |
| `<validation>` | `string` | Plain-language validation constraints for the model. |
| `<examples>` | `element` | Contains `<example>` child elements with 1-2 short usage examples. |

Named parameters are child elements within `<parameters>`, each containing `<type>`, `<description>`, and `<required>`:

```xml
<parameters>
  <mode>explicit</mode>
  <location>
    <type>string</type>
    <description>City name, region, or US postal code</description>
    <required>true</required>
  </location>
  <validation>Location must be a valid worldwide city name, region, or US ZIP code.</validation>
  <examples>
    <example>weather Dallas</example>
    <example>weather 90210</example>
  </examples>
</parameters>
```

### Example Tool Configuration

```xml
<tool>
  <name>weather</name>
  <api>accuweather</api>
  <timeout>60</timeout>
  <description>Get weather details including current conditions and forecast</description>
  <abilityWhen>User asks about weather details for a location.</abilityWhen>
  <parameters>
    <mode>explicit</mode>
    <location>
      <type>string</type>
      <description>City name, region, or US postal code</description>
      <required>true</required>
    </location>
    <validation>Location must be a valid worldwide city name, region, or US postal code.</validation>
    <examples>
      <example>weather Dallas</example>
      <example>weather 90210</example>
    </examples>
  </parameters>
  <contextFilterMaxDepth>1</contextFilterMaxDepth>
</tool>
```

Example with final Ollama pass:

```xml
<tool>
  <name>nfl scores</name>
  <api>nfl</api>
  <timeout>30</timeout>
  <description>Get current NFL game scores</description>
  <abilityWhen>User asks about NFL scores or game results.</abilityWhen>
  <parameters>
    <mode>mixed</mode>
    <date>
      <type>string</type>
      <description>Date in YYYYMMDD or YYYY-MM-DD format</description>
      <required>false</required>
    </date>
    <inferFrom>current_message</inferFrom>
    <validation>Date must be YYYYMMDD or YYYY-MM-DD. If omitted, returns the most recent scoreboard.</validation>
  </parameters>
  <finalOllamaPass>true</finalOllamaPass>
  <allowEmptyContent>true</allowEmptyContent>
</tool>
```

Example with context evaluation enabled:

```xml
<tool>
  <name>chat</name>
  <api>ollama</api>
  <timeout>300</timeout>
  <description>Chat with Ollama AI</description>
  <contextFilterEnabled>true</contextFilterEnabled>
  <contextFilterMinDepth>2</contextFilterMinDepth>
  <contextFilterMaxDepth>8</contextFilterMaxDepth>
</tool>
```

## Global Final-Pass Model

The `OLLAMA_FINAL_PASS_MODEL` environment variable specifies which Ollama model to use for all final-pass refinements. This allows you to use a different model for conversational formatting than for primary API routing.

**Configuration**: Set via the web configurator in the API Endpoints section, or directly in `.env`:

```env
OLLAMA_FINAL_PASS_MODEL=llama2
```

If not set, the default `OLLAMA_MODEL` is used for final-pass refinements.

**Use case**: You might use a lightweight, fast model for primary routing and a more sophisticated model for final-pass conversational responses.

## Ability Logging

The `ABILITY_LOGGING_DETAILED` environment variable enables verbose logging of the abilities context sent to Ollama during two-stage evaluation.

**Configuration**:
```env
ABILITY_LOGGING_DETAILED=true
```

**Behavior**:
- **Disabled (default)**: Only a summary count is logged (e.g., "Sent 5 abilities to Ollama")
- **Enabled**: The full abilities text is logged for debugging routing behavior
- **Automatically enabled** when `DEBUG_LOGGING=true`

**Use case**: Helpful for understanding why the bot chose a particular API or for debugging ability routing issues.

## Context Evaluation

Context evaluation is an advanced feature that uses Ollama to filter conversation history before including it in requests. This improves response quality when conversations shift topics.

### Configuration

Context evaluation is **opt-in per keyword** via the `contextFilterEnabled` field:

```json
{
  "keyword": "!chat",
  "api": "ollama",
  "contextFilterEnabled": true,
  "contextFilterMinDepth": 2,
  "contextFilterMaxDepth": 8
}
```

### How It Works

1. The bot collects reply chain, channel, and/or DM history as usual
2. If `contextFilterEnabled` is `true` for the matched keyword, the context evaluator analyzes the collected history
3. Ollama determines which recent messages are topically relevant
4. The most recent `contextFilterMinDepth` messages are **always included**
5. Up to `contextFilterMaxDepth` messages total may be included if they remain on-topic
6. If topics diverge, Ollama uses the most recent topic and transitions naturally

### Configuration Options

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `contextFilterEnabled` | `boolean` | `false` | Enable context evaluation for this keyword |
| `contextFilterMinDepth` | `integer` | `1` | Minimum recent messages to always include |
| `contextFilterMaxDepth` | `integer` | Global `REPLY_CHAIN_MAX_DEPTH` | Maximum messages eligible for inclusion |

### Best Practices

- **Enable for conversational keywords**: Keywords like `!chat` or `!ask` benefit most from context evaluation
- **Disable for single-turn queries**: Keywords like `!weather` or `!generate` don't need context evaluation
- **Tune depth limits**: Higher `contextFilterMaxDepth` allows more context but adds processing time
- **Consider token budgets**: Context evaluation adds one Ollama call per request

## Debug Logging

Enable comprehensive verbose logging for troubleshooting:

```env
DEBUG_LOGGING=true
```

When enabled, the following are logged in full:

1. **Messages received** — full message content (normally truncated to 100 chars)
2. **Messages sent** — full reply content (normally truncated to 200 chars)
3. **Abilities prompt** — full abilities context sent to Ollama
4. **Context-eval prompt** — full system prompt and conversation history
5. **API requests** — full request payloads for all APIs
6. **API responses** — full response content from all API backends

Debug log lines are tagged with `[debug]` level and `DEBUG:` prefix.

**Hot-reloadable**: No restart required. Save the change in your `.env` and the configurator will reload it.

## Reply Chain and Context Configuration

Fine-tune conversation context collection:

| Variable | Default | Description |
|----------|---------|-------------|
| `REPLY_CHAIN_ENABLED` | `true` | Enable/disable all context features |
| `REPLY_CHAIN_MAX_DEPTH` | `30` | Maximum messages to collect (1–50) |
| `REPLY_CHAIN_MAX_TOKENS` | `16000` | Character budget for context (1,000–128,000) |
| `REPLY_CHAIN_IMAGE_MAX_DEPTH` | `5` | Max reply-chain messages to scan for image attachments (0–50, 0 disables) |
| `ALLOW_BOT_INTERACTIONS` | `false` | Include other bots in context and respond to them |

### Context Collection Behavior

- **Primary context** (reply chain): Traverses Discord reply threads
- **Secondary context** (channel): Recent messages from the channel/thread
- **DM context**: Recent messages from DM channel
- **Reply-chain images**: Within the `REPLY_CHAIN_IMAGE_MAX_DEPTH` window, image attachments on reply-chain messages (both user and bot) are downloaded, base64-encoded, and attached to each history message. Ollama vision models receive these images per-message so they retain their original context.
- Priority: Primary fills first, secondary fills remaining slots up to depth limit
- When limits exceeded: Oldest messages are dropped first (newest kept)

## Image Response Format

Configure how the bot responds with generated images:

```env
IMAGE_RESPONSE_INCLUDE_EMBED=false
```

- `true`: Include an embed block with an internal "View" link
- `false` (default): Plain response without embed block

## Error Message Configuration

Customize the error message shown to users when something goes wrong:

| Variable | Default | Description |
|----------|---------|-------------|
| `ERROR_MESSAGE` | "Oops! Something went wrong..." | User-facing error message |
| `ERROR_RATE_LIMIT_MINUTES` | `5` | Minimum minutes between identical error messages to the same user |

Rate limiting prevents error message spam while still informing users of issues.

## File Handling Configuration

Configure how files are handled and served:

| Variable | Default | Description |
|----------|---------|-------------|
| `FILE_SIZE_THRESHOLD` | `8000000` | Max size (bytes) for Discord attachments; larger files use URL links |
| `MAX_ATTACHMENTS` | `10` | Maximum attachments per message |
| `OUTPUT_BASE_URL` | `http://localhost:3003` | Public URL for generated file links |

## Request Queue Configuration

Configure per-keyword timeouts in `config/tools.xml`:

```xml
<tool>
  <name>generate</name>
  <api>comfyui</api>
  <timeout>300</timeout>
</tool>
```

- Each API processes only 1 request at a time
- Additional requests are queued (FIFO)
- When a request times out, its HTTP call is cancelled
- Default timeout: 300 seconds (configurable via `DEFAULT_TIMEOUT`)

## Activity Feed Configuration

Configure the activity feed rotating key system:

```env
ACTIVITY_KEY_TTL=300
```

- `ACTIVITY_KEY_TTL`: Key expiration time in seconds (default: 300 / 5 minutes)
- Keys are requested by sending `!activity_key` to the bot via Discord
- Keys rotate automatically after expiration

## Testing

The bot includes a comprehensive unit test suite:

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch
```

### Test Coverage

- **config.test.ts** — Environment parsing, public config, keyword routing
- **configWriter.test.ts** — .env persistence, tools.xml validation
- **fileHandler.test.ts** — File saving, sanitization, path generation
- **logger.test.ts** — Log formatting, level mapping, console output
- **requestQueue.test.ts** — API locking, timeouts, concurrency
- **keywordClassifier.test.ts** — AI classification logic, prompt building
- **apiRouter.test.ts** — Multi-stage routing, partial failures, final pass logic
- **responseTransformer.test.ts** — Result extraction, context prompt building
- **accuweatherClient.test.ts** — Location resolution, weather data fetching
- **nflClient.test.ts** — ESPN adapter mapping, game formatting, API fetching

All tests run without requiring Discord connection or external APIs.

## Next Steps

- **[Architecture](ARCHITECTURE.md)** — Technical details on how the bot works
- **[API Integration](API_INTEGRATION.md)** — Configure external APIs
- **[Configurator](CONFIGURATOR.md)** — Web-based configuration interface
- **[Troubleshooting](TROUBLESHOOTING.md)** — Fix common issues
