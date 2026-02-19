# Quick Start Guide

This guide will get you up and running with Bob Bot in just a few minutes.

## Prerequisites

- Node.js 20+
- npm or yarn
- A Discord Bot Token (can be configured after install via the web configurator)
- ComfyUI instance (optional, for image generation)
- Ollama instance (optional, for text generation)
- AccuWeather API key (optional, for weather data — free tier at [developer.accuweather.com](https://developer.accuweather.com))
- SerpAPI key (optional, for web search — free tier at [serpapi.com](https://serpapi.com))
- No API key required for NFL data (ESPN public API)

## Installation

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
> `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `COMFYUI_ENDPOINT`, `OLLAMA_ENDPOINT`, `OLLAMA_MODEL`, `OLLAMA_SYSTEM_PROMPT`, `HTTP_PORT`, `HTTP_HOST`, `OUTPUTS_PORT`, `OUTPUTS_HOST`, `OUTPUTS_TRUST_PROXY`, `OUTPUT_BASE_URL`, `ACTIVITY_KEY_TTL`, `FILE_SIZE_THRESHOLD`, `DEFAULT_TIMEOUT`, `MAX_ATTACHMENTS`, `ERROR_MESSAGE`, `ERROR_RATE_LIMIT_MINUTES`, `REPLY_CHAIN_ENABLED`, `REPLY_CHAIN_MAX_DEPTH`, `REPLY_CHAIN_MAX_TOKENS`, `REPLY_CHAIN_IMAGE_MAX_DEPTH`, `ALLOW_BOT_INTERACTIONS`, `IMAGE_RESPONSE_INCLUDE_EMBED`, `COMFYUI_DEFAULT_MODEL`, `COMFYUI_DEFAULT_WIDTH`, `COMFYUI_DEFAULT_HEIGHT`, `COMFYUI_DEFAULT_STEPS`, `COMFYUI_DEFAULT_CFG`, `COMFYUI_DEFAULT_SAMPLER`, `COMFYUI_DEFAULT_SCHEDULER`, `COMFYUI_DEFAULT_DENOISE`, `ACCUWEATHER_API_KEY`, `ACCUWEATHER_DEFAULT_LOCATION`, `ACCUWEATHER_ENDPOINT`, `NFL_BASE_URL`, `NFL_ENABLED`, `SERPAPI_API_KEY`, `SERPAPI_ENDPOINT`, `SERPAPI_HL`, `SERPAPI_GL`, `SERPAPI_LOCATION`

## Running the Bot

### Quick start:
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

### Development mode (with auto-reload on code changes):
```bash
npm run dev:watch
```

### Production mode:
```bash
npm run build
npm start
```

> If `DISCORD_TOKEN` is set in `.env`, the bot will auto-connect to Discord on startup.
> If not, it starts in configurator-only mode so you can set it up via the web UI.

### Register slash commands:
```bash
npm run register
```
> Requires `DISCORD_TOKEN` and `DISCORD_CLIENT_ID` to be set in `.env`.

## What's Next?

- **[Configure APIs](API_INTEGRATION.md)** — Set up ComfyUI, Ollama, AccuWeather, NFL, and SerpAPI
- **[Web Configurator](CONFIGURATOR.md)** — Learn about the web-based configuration interface
- **[Usage Guide](USAGE.md)** — Learn how to use the bot with examples
- **[Troubleshooting](TROUBLESHOOTING.md)** — Fix common issues
