# Bob Bot - Discord AI Integration

A Discord bot that monitors @mentions and DMs, routes keyword-matched requests to ComfyUI, Ollama, AccuWeather, ESPN NFL, SerpAPI (Google Search), and Memegen (meme images) APIs, and returns results as inline replies or ephemeral slash commands with organized file outputs and comprehensive logging.

## Features

### Core Capabilities
- ✅ @mention and DM detection with inline replies
- ✅ **DM conversation context** — DMs automatically include recent message history
- ✅ Slash commands with ephemeral responses
- ✅ ComfyUI integration for AI image generation
- ✅ Ollama integration for AI text generation and conversation
- ✅ **Image-to-text (vision)** — attach images to any @mention or DM and Ollama describes them automatically
- ✅ AccuWeather integration for real-time weather data
- ✅ **NFL game data** — live scores and news via ESPN
- ✅ **Web search** — Google Search via SerpAPI with AI Overview support
- ✅ **Meme generation** — create meme images via memegen.link with cached templates
- ✅ **Web-based configurator** — localhost-only SPA for managing all settings
- ✅ **Two-stage evaluation** — intelligent API routing with automatic ability discovery

**[View Complete Feature List →](docs/FEATURES.md)**

## Quick Start

### Prerequisites

- Node.js 20+
- A Discord Bot Token (configurable via web UI)
- Optional: ComfyUI, Ollama, AccuWeather API key, SerpAPI key

### Installation

```bash
git clone https://github.com/cchamp-msft/bob-bot-discord-app.git
cd bob-bot-discord-app
npm install
cp .env.example .env
npm run dev
```

Open **http://localhost:3000/configurator** to configure your Discord token and API endpoints.

**[Full Installation Guide →](docs/QUICKSTART.md)**

## Project Structure

```
src/
├── index.ts              # Main bot entry point
├── bot/                  # Discord client and message handling
├── commands/             # Slash command definitions
├── api/                  # API clients (ComfyUI, Ollama, AccuWeather, NFL, SerpAPI, Meme)
├── public/               # Web configurator and activity feed
└── utils/                # Config, logging, file handling, routing, queuing

config/
├── tools.default.xml    # Default tool definitions (XML format)
└── tools.xml            # Runtime tools config (gitignored)

docs/                     # Documentation
tests/                    # Unit tests
outputs/                  # Generated files and logs
```

**[Detailed Architecture →](docs/ARCHITECTURE.md)**

## Usage

### Basic Commands

**@mentions:**
```
@BobBot !generate a beautiful sunset landscape
@BobBot what is the meaning of life?
@BobBot !weather Seattle
@BobBot !nfl scores
@BobBot !search latest AI news
@BobBot !meme success kid | finished all my tasks | on a Monday
@BobBot !meme_templates
```

**Slash commands:**
```
/generate prompt: a beautiful sunset landscape
/ask question: what is the meaning of life?
/weather location: Seattle type: full
```

**[Complete Usage Guide →](docs/USAGE.md)**

## Configuration

The bot includes a **localhost-only web configurator** for easy management:

1. Start the bot: `npm run dev`
2. Open: **http://localhost:3000/configurator**
3. Configure Discord token, API endpoints, and keywords
4. Test connections and start the bot

Most settings support hot-reload (no restart required).

**[Configurator Guide →](docs/CONFIGURATOR.md)**  
**[API Integration Guide →](docs/API_INTEGRATION.md)**  
**[Advanced Configuration →](docs/ADVANCED.md)**

## Testing

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch
```

100+ unit tests covering core functionality. No Discord connection or external APIs required.

## Documentation

- **[Quick Start Guide](docs/QUICKSTART.md)** — Get up and running in minutes
- **[Complete Feature List](docs/FEATURES.md)** — All bot capabilities
- **[Usage Guide](docs/USAGE.md)** — How to use the bot with examples
- **[API Integration](docs/API_INTEGRATION.md)** — Configure ComfyUI, Ollama, AccuWeather, NFL, SerpAPI, Meme
- **[Web Configurator](docs/CONFIGURATOR.md)** — Web UI, activity feed, reverse proxy setup
- **[Architecture](docs/ARCHITECTURE.md)** — Technical details, routing, context management
- **[Advanced Features](docs/ADVANCED.md)** — Keyword configuration, context evaluation, debugging
- **[Troubleshooting](docs/TROUBLESHOOTING.md)** — Fix common issues

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

See [LICENSE](LICENSE) for details.

## Security & Privacy

- **[Security Policy](SECURITY.md)** — Security practices and vulnerability reporting
- **[Privacy Policy](PRIVACY_POLICY.md)** — Data handling and privacy guarantees
- **[Terms of Service](TERMS_OF_SERVICE.md)** — Usage terms

## Need Help?

- Check the **[Troubleshooting Guide](docs/TROUBLESHOOTING.md)** for common issues
- Review logs in the configurator's status console
- Enable debug logging: `DEBUG_LOGGING=true` in `.env`
- Report issues via [GitHub Issues](https://github.com/cchamp-msft/bob-bot-discord-app/issues)
