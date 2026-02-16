# API Integration Guide

This guide provides detailed information on configuring and using each API integration.

## Ollama Configuration

Ollama provides AI text generation capabilities for the bot.

### Model Selection

Ollama models are discovered automatically when you click **Test** in the configurator's API Endpoints section. The model list is fetched from the Ollama `/api/tags` endpoint and populates the dropdown. Select a model and click **Save Changes** to persist it to `.env` as `OLLAMA_MODEL`.

If no model is configured or the selected model becomes unavailable, the bot will return an error to the console and send a rate-limited error message to Discord users.

### System Prompt

Configure the bot's personality and behavior by setting a system prompt in the configurator. The system prompt is sent with every Ollama request.

The configurator includes a reset-to-default button to restore the original system prompt.

### Per-Request Model Override

The `/ask` slash command accepts an optional `model` parameter to override the default model on a per-request basis:

```
/ask question: explain quantum physics model: llama2
```

## ComfyUI Configuration

ComfyUI uses workflow JSON files to define generation pipelines. There are two ways to configure a workflow:

### Option 1: Default Workflow and Sampler Overrides (Recommended)

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

### Option 2: Custom Workflow Upload (Advanced)

Upload a workflow JSON file through the configurator for full control:

1. Export your workflow from ComfyUI as a JSON file (API format)
2. Edit the workflow JSON to replace the positive prompt value with the placeholder `%prompt%`
3. Upload the file via the configurator's **ComfyUI Workflow** upload field
4. The server validates that the file is valid JSON and contains at least one `%prompt%` placeholder

**Important:** The `%prompt%` placeholder is **case-sensitive**. Use exactly `%prompt%` — variations like `%PROMPT%` or `%Prompt%` will not be recognized.

When a Discord user triggers image generation, all occurrences of `%prompt%` in the workflow are replaced with the user's prompt text, and the resulting workflow is submitted to ComfyUI's `/api/prompt` endpoint.

The workflow is stored in `.config/comfyui-workflow.json`.

### KSampler Override

When a custom workflow contains one or more `KSampler` nodes (node `class_type` must be exactly `KSampler`), the bot automatically overrides their `steps`, `cfg`, `sampler_name`, `scheduler`, and `denoise` inputs using the values from the Workflow Settings section. The existing `seed` in the uploaded workflow is preserved. Nodes with other class types (e.g. `KSamplerAdvanced`) are not affected.

### Workflow Precedence

If a custom workflow is uploaded, it always takes priority over the default workflow. Remove the custom workflow via the configurator to revert to default workflow settings.

### Exporting Workflows for Testing

The configurator includes an **Export Current Workflow** button that downloads the currently active workflow (custom or default) as a JSON file in ComfyUI API format. The exported file can be submitted directly to ComfyUI's `/prompt` endpoint for testing outside the bot.

The `%prompt%` placeholder is preserved in the export — replace it manually with your test prompt text before submitting to ComfyUI.

## AccuWeather Configuration

The bot integrates with [AccuWeather](https://developer.accuweather.com) for real-time weather data. A free-tier API key provides 50 calls/day.

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ACCUWEATHER_API_KEY` | Yes | API key from AccuWeather Developer Portal |
| `ACCUWEATHER_DEFAULT_LOCATION` | No | Default location for the `/weather` slash command when no location is specified. Keyword-based weather commands always require a location (e.g. `weather Seattle`). |
| `ACCUWEATHER_ENDPOINT` | No | Base URL override (default: `https://dataservice.accuweather.com`) |

### Location Resolution

The bot supports multiple location input formats:
- **City names**: `Seattle`, `New York City`, `London`
- **US zip codes** (5 digits): `90210`, `98101`
- **AccuWeather location keys** (numeric): `351409`

When a user says "weather in Seattle", the bot extracts "Seattle", resolves it via AccuWeather's location search API, and fetches weather data.

### Weather Keywords

Four default weather keywords are configured in `config/keywords.default.json`. All require a location parameter:

| Keyword | Mode | Behavior |
|---------|------|----------|
| `weather <location>` | full | Direct weather report (current + forecast) |
| `forecast <location>` | forecast | Direct 5-day forecast only |
| `conditions <location>` | current | Direct current conditions only |
| `weather report <location>` | full | Weather data routed through Ollama for AI-powered report |

> **Note:** Unlike the `/weather` slash command which falls back to `ACCUWEATHER_DEFAULT_LOCATION`, keyword-based weather commands require a location. Sending just `weather` with no location will prompt the user to include a query.

### Weather Slash Command

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

## NFL Configuration

The bot integrates with [ESPN's public API](https://site.api.espn.com/apis/site/v2/sports/football/nfl) for NFL game scores and news. No API key is required.

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `NFL_BASE_URL` | No | Base URL override (default: `https://site.api.espn.com/apis/site/v2/sports/football/nfl`) |
| `NFL_ENABLED` | No | Enable/disable NFL features (default: `true`) |

### NFL Keywords

Two NFL keywords are configured in `config/keywords.default.json`:

| Keyword | Behavior |
|---------|----------|
| `nfl scores` | Lists all games for the current week. Supports date lookups: `nfl scores 20260208` or `nfl scores 2026-02-08` |
| `nfl news` | Shows the latest NFL news headlines. Supports keyword filtering: `nfl news chiefs` |

Both keywords have `allowEmptyContent: true`, so they work without additional text.

### Date-Based Score Lookups

Use `YYYYMMDD` or `YYYY-MM-DD` format to look up scores for a specific date:
- `nfl scores 20260208` — scores for games on February 8, 2026
- `nfl scores 2026-02-08` — same, with dashes

When no date is provided, the current week's scoreboard is shown.

### News Filtering

Add a search term after `nfl news` to filter articles by headline or description:
- `nfl news chiefs` — only articles mentioning "chiefs"
- `nfl news trade` — only articles mentioning "trade"

Without a filter, the 5 most recent articles are shown.

### Endpoint Selection

| Query type | ESPN Endpoint | Cache TTL |
|-----------|---------------|----------|
| Current week (no date) | `/scoreboard` | 60s live, 300s final |
| Specific date | `/scoreboard?dates=YYYYMMDD` | 60s live, 300s final |
| News | `/news` | 300s |

## SerpAPI Configuration

The bot integrates with [SerpAPI](https://serpapi.com) for Google Search results, including AI Overview support.

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SERPAPI_API_KEY` | Yes | API key from SerpAPI |
| `SERPAPI_ENDPOINT` | No | Base URL override (default: `https://serpapi.com/search`) |
| `SERPAPI_HL` | No | Language code (e.g. `en`, `es`, `fr`) — affects AI Overview availability |
| `SERPAPI_GL` | No | Country code (e.g. `us`, `uk`, `ca`) — affects AI Overview availability |
| `SERPAPI_LOCATION` | No | Location string (e.g. `United States`) — can improve AI Overview coverage |

### Keywords

Two SerpAPI keywords are configured:

| Keyword | Behavior |
|---------|----------|
| `search <query>` | Full Google Search results (organic results, snippets, etc.) |
| `second opinion <query>` | AI Overview only (Google's AI-generated summary) |

### AI Overview Availability

AI Overview availability is **locale-dependent**. Google's AI Overview is not available in all regions or languages.

**To maximize AI Overview coverage:**
1. Set `SERPAPI_HL` to `en` (English)
2. Set `SERPAPI_GL` to `us` (United States)
3. Optionally set `SERPAPI_LOCATION` to `United States`

See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for AI Overview troubleshooting tips.

### Usage Examples

**Full search**:
```
@BobBot search latest AI news
@BobBot search best restaurants in Seattle
```

**AI Overview only**:
```
@BobBot second opinion on quantum computing
@BobBot second opinion what is machine learning
```

## Testing API Connections

All API endpoints can be tested through the web configurator:

1. Open the configurator at `http://localhost:3000/configurator`
2. Navigate to the API Endpoints section
3. Click **Test** next to any API
4. View the connection status and any error messages

Successful tests will show:
- **Ollama**: List of available models
- **ComfyUI**: Connection confirmed, options discovered
- **AccuWeather**: Location resolution test
- **NFL**: Connection confirmed
- **SerpAPI**: Connection confirmed

## Next Steps

- **[Usage Guide](USAGE.md)** — Learn how to use each API
- **[Advanced Features](ADVANCED.md)** — Context evaluation, ability logging, keyword configuration
- **[Troubleshooting](TROUBLESHOOTING.md)** — Fix API connection issues
