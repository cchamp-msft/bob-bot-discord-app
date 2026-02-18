# Usage Guide

This guide shows you how to use Bob Bot to interact with AI, generate images, get weather updates, and more.

## Basic Usage

### @mentions

Mention the bot with a keyword and prompt:
```
@BobBot !generate a beautiful sunset landscape
@BobBot !ask what is the meaning of life?
@BobBot !weather in Seattle
@BobBot !forecast for 90210
@BobBot !nfl scores
@BobBot !nfl scores 20260208
@BobBot !nfl news
@BobBot !nfl news chiefs
@BobBot !search what is the weather like today
@BobBot !second opinion on climate change
@BobBot !meme drake | writing docs | generating memes
```

The bot replies inline — the initial "Processing" message is edited in-place with the final response.

### Direct Messages (DMs)

You can DM the bot directly without needing an @mention. DMs automatically include recent message history for context.

### Slash Commands

Use slash commands for ephemeral responses (visible only to you):
```
/generate prompt: a beautiful sunset landscape
/ask question: what is the meaning of life? model: llama2
/weather location: Seattle type: full
/weather location: 90210 type: forecast
```

## Keywords and Routing

The bot uses keywords prefixed with `!` to route requests to different APIs:

| Keyword | API | Example |
|---------|-----|---------|
| `!generate`, `!draw`, `!image` | ComfyUI | `@BobBot !generate a sunset` |
| `!ask`, `!tell me`, `!what` | Ollama | `@BobBot !ask what is recursion?` |
| `!weather`, `!forecast`, `!conditions` | AccuWeather | `@BobBot !weather Seattle` |
| `!nfl scores`, `!nfl news` | ESPN NFL | `@BobBot !nfl scores` |
| `!search` | SerpAPI | `@BobBot !search latest AI news` |
| `!second opinion` | SerpAPI (AI Overview only) | `@BobBot !second opinion on quantum computing` |
| `!meme` | Memegen | `@BobBot !meme drake \| writing docs \| generating memes` |

Keywords are configurable via the web configurator. See [ADVANCED.md](ADVANCED.md) for keyword configuration details.

## Conversation Context

### Reply Chains

When you reply to a message in Discord, the bot automatically includes the conversation history in its context. This works for both server channels and DMs.

### DM History

DMs automatically include recent message history without requiring explicit replies. The bot tracks the conversation naturally.

### Channel Context

In server channels, the bot can include recent channel messages as context when processing your request. This helps the bot understand ongoing conversations and provide more relevant responses.

Context features are configurable. See [ADVANCED.md](ADVANCED.md) for details on context evaluation and depth settings.

## Two-Stage Evaluation

Bob Bot uses a two-stage evaluation system:

1. **First stage**: Your message is sent to Ollama with an abilities context describing available API capabilities
2. **Keyword check**: Ollama's response is checked for a first-line keyword directive (e.g., `weather: Seattle`). If found, the corresponding API is triggered automatically and the result is presented conversationally.

If Ollama does not include a keyword directive, the response is returned as a normal chat reply — no fallback classification is performed.

This enables automatic ability routing. For example:
- You ask: `@BobBot what's the weather like in Seattle?`
- First stage: Ollama recognizes this as a weather question
- The response triggers the weather API automatically
- You get weather details using AccuWeather data

See [ARCHITECTURE.md](ARCHITECTURE.md) for technical details on the two-stage evaluation system.

## API-Specific Usage

### Ollama (AI Text Generation)

The bot uses Ollama for general AI text generation and conversation.

**Model selection**: Configure your preferred model via the web configurator. Models are discovered automatically when you test the connection.

**System prompt**: Customize the bot's personality by setting a system prompt in the configurator.

**Per-request model override**: The `/ask` slash command accepts an optional `model` parameter to override the default on a per-request basis.

See [API_INTEGRATION.md](API_INTEGRATION.md) for detailed Ollama configuration.

### ComfyUI (Image Generation)

The bot uses ComfyUI for AI image generation.

**Basic usage**:
```
@BobBot !generate a beautiful sunset landscape
@BobBot !draw a cyberpunk city at night
```

**Reply-based generation**: Reply to a message with an image keyword to combine the quoted content with your prompt:
```
[Original message: "I love mountains"]
[Your reply]: @BobBot !generate this
[Result: Image of mountains]
```

**Workflow configuration**: Choose between default workflow (simple) or custom workflow (advanced) via the configurator.

See [API_INTEGRATION.md](API_INTEGRATION.md) for detailed ComfyUI configuration including workflow setup.

### AccuWeather (Weather Data)

The bot provides real-time weather data via AccuWeather.

**Keyword-based queries** (require location):
```
@BobBot !weather Seattle
@BobBot !forecast for 90210
@BobBot !conditions in London
```

**Slash command** (supports default location):
```
/weather                          # Default location
/weather location: Chicago        # Specified location
/weather location: 90210          # Zip code
```

**Location formats supported**:
- City names: `Seattle`, `New York City`, `London`
- US zip codes: `90210`, `98101`
- AccuWeather location keys: `351409`

See [API_INTEGRATION.md](API_INTEGRATION.md) for AccuWeather configuration.

### NFL (Game Scores and News)

The bot provides NFL game scores and news via ESPN's public API.

**Scores**:
```
@BobBot !nfl scores                # Current week
@BobBot !nfl scores 20260208       # Specific date (YYYYMMDD)
@BobBot !nfl scores 2026-02-08     # Specific date (YYYY-MM-DD)
```

**News**:
```
@BobBot !nfl news                  # Latest 5 articles
@BobBot !nfl news chiefs           # Filter by keyword
@BobBot !nfl news trade            # Filter by keyword
```

No API key required — ESPN provides public access.

See [API_INTEGRATION.md](API_INTEGRATION.md) for NFL configuration.

### SerpAPI (Web Search)

The bot provides web search via Google Search through SerpAPI.

**Full search results**:
```
@BobBot !search latest AI news
@BobBot !search best restaurants in Seattle
```

**AI Overview only** (Google's AI-generated summary):
```
@BobBot !second opinion on quantum computing
@BobBot !second opinion what is machine learning
```

> **Note**: AI Overview availability is locale-dependent. Configure `SERPAPI_HL` (language) and `SERPAPI_GL` (country) for best results. Optional `SERPAPI_LOCATION` can further improve coverage.

See [API_INTEGRATION.md](API_INTEGRATION.md) for SerpAPI configuration and [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for AI Overview issues.

## Activity Feed

The bot includes a public activity feed showing its decision-making process as first-person narrative events.

**Getting access**:
1. Send `!activity_key` to the bot (DM or @mention)
2. The bot replies with a temporary key and URL
3. Open the URL and enter the key when prompted

**Privacy**: The activity feed never shows raw message content, user IDs, or API keys. Events are sanitized first-person narratives.

See [CONFIGURATOR.md](CONFIGURATOR.md) for details on the activity feed.

## Next Steps

- **[API Integration Guide](API_INTEGRATION.md)** — Detailed API configuration
- **[Advanced Features](ADVANCED.md)** — Context evaluation, ability logging, keyword configuration
- **[Architecture](ARCHITECTURE.md)** — How the bot works internally
- **[Troubleshooting](TROUBLESHOOTING.md)** — Fix common issues
