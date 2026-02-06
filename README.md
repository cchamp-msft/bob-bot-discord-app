# Bob Bot - Discord AI Integration

A Discord bot that monitors @mentions and DMs, routes keyword-matched requests to ComfyUI or Ollama APIs, and returns results as inline replies or ephemeral slash commands with organized file outputs and comprehensive logging.

## Features

- ✅ @mention and DM detection with inline replies
- ✅ Slash commands with ephemeral responses (shareable by user)
- ✅ ComfyUI integration for image generation
- ✅ Ollama integration for AI text generation
- ✅ Serial request processing with max 1 concurrent per API
- ✅ Configurable per-keyword timeouts (default: 300s)
- ✅ Smart file handling (attachments for small files, URL links for large)
- ✅ HTTP server for file serving
- ✅ **Web-based configurator** — localhost-only SPA for managing all settings
- ✅ **Discord start/stop controls** — manage bot connection from the configurator
- ✅ **Hot-reload support** — API endpoints and keywords reload without restart
- ✅ **Ollama model discovery** — test connection loads available models for selection
- ✅ **Ollama system prompt** — configurable personality/context sent with every request
- ✅ **ComfyUI workflow upload** — upload JSON workflow with `%prompt%` placeholder substitution
- ✅ **Rate-limited error messages** — configurable user-facing error messages with minimum interval
- ✅ Comprehensive request logging with date/requester/status tracking
- ✅ Organized output directory structure with date formatting
- ✅ **Unit test suite** — 100+ tests covering core functionality

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
│   ├── comfyuiClient.ts  # ComfyUI API client
│   └── ollamaClient.ts   # Ollama API client
├── public/
│   └── configurator.html # Web-based configurator SPA
└── utils/
    ├── config.ts         # Configuration loader (with hot-reload)
    ├── configWriter.ts   # Configuration persistence layer
    ├── logger.ts         # Request logging system
    ├── fileHandler.ts    # File output management
    ├── requestQueue.ts   # Request queue with API availability tracking
    └── httpServer.ts     # Express HTTP server for file serving + configurator

config/
└── keywords.json         # Keyword to API mapping with timeouts

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
> `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `COMFYUI_ENDPOINT`, `OLLAMA_ENDPOINT`, `OLLAMA_MODEL`, `OLLAMA_SYSTEM_PROMPT`, `HTTP_PORT`, `OUTPUT_BASE_URL`, `FILE_SIZE_THRESHOLD`, `DEFAULT_TIMEOUT`, `MAX_ATTACHMENTS`, `ERROR_MESSAGE`, `ERROR_RATE_LIMIT_MINUTES`

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

### Accessing the Configurator

1. Start the bot (`npm run dev`, `npm run dev:watch`, or `npm start`)
2. Open your browser to: **http://localhost:3000/configurator**
   - The HTTP server starts immediately — no Discord connection required
   - ⚠️ Only accessible from localhost for security
   - Port matches your `HTTP_PORT` setting in `.env` (default: 3000)

### Configurator Features

- **Discord Connection**: Set client ID and bot token, test token validity, start/stop the bot
- **Bot Token**: Write-only field — token is never displayed or logged, only persisted to `.env`
- **Start/Stop Controls**: Connect or disconnect the bot from Discord without restarting the process
- **Connection Status**: Live indicator showing stopped / connecting / running / error
- **API Endpoints**: Configure ComfyUI/Ollama URLs with live connection testing
- **Ollama Model Selection**: Test connection auto-discovers available models; select and save desired model
- **Ollama System Prompt**: Configurable system prompt sets the bot's personality; reset-to-default button included
- **ComfyUI Workflow Upload**: Upload a workflow JSON file with `%prompt%` placeholder validation
- **Error Handling**: Configure user-facing error message and rate limit interval
- **HTTP Server**: Adjust port and output base URL
- **Limits**: Set file size threshold, default timeout, and max attachments per message
- **Keywords Management**: Add/edit/remove keyword→API mappings with custom timeouts
- **Status Console**: Real-time log stream showing config changes, API tests, and bot status

### Hot-Reload vs Restart Required

**Hot-Reload (no restart needed):**
- ComfyUI/Ollama endpoints
- Ollama model selection
- Ollama system prompt
- Error message and rate limit
- Output base URL
- File size threshold
- Default timeout
- Max attachments per message
- Keywords (entire list)
- Discord token and client ID (stop and re-start the bot from configurator)

**Restart Required:**
- HTTP port

## Running Tests

The bot includes a comprehensive unit test suite with 71 tests covering configuration, logging, file handling, request queuing, and config persistence.

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
- **fileHandler.test.ts** — File saving, sanitization, path generation
- **logger.test.ts** — Log formatting, convenience methods
- **requestQueue.test.ts** — API locking, timeouts, concurrency

All tests run without requiring Discord connection or external APIs.

## Usage

### Ollama Model Configuration

Ollama models are discovered automatically when you click **Test** in the configurator's API Endpoints section. The model list is fetched from the Ollama `/api/tags` endpoint and populates the dropdown. Select a model and click **Save Changes** to persist it to `.env` as `OLLAMA_MODEL`.

If no model is configured or the selected model becomes unavailable, the bot will return an error to the console and send a rate-limited error message to Discord users.

The `/ask` slash command also accepts an optional `model` parameter to override the default on a per-request basis.

### ComfyUI Workflow Configuration

ComfyUI uses workflow JSON files to define generation pipelines. Upload a workflow JSON file through the configurator:

1. Export your workflow from ComfyUI as a JSON file (API format)
2. Edit the workflow JSON to replace the positive prompt value with the placeholder `%prompt%`
3. Upload the file via the configurator's **ComfyUI Workflow** upload field
4. The server validates that the file is valid JSON and contains at least one `%prompt%` placeholder

**Important:** The `%prompt%` placeholder is **case-sensitive**. Use exactly `%prompt%` — variations like `%PROMPT%` or `%Prompt%` will not be recognized.

When a Discord user triggers image generation, all occurrences of `%prompt%` in the workflow are replaced with the user's prompt text, and the resulting workflow is submitted to ComfyUI's `/api/prompt` endpoint.

The workflow is stored in `.config/comfyui-workflow.json`.

### @mention Usage
Mention the bot with a keyword and prompt:
```
@BobBot generate a beautiful sunset landscape
@BobBot ask what is the meaning of life?
```

The bot replies inline — the initial "Processing" message is edited in-place with the final response. You can also DM the bot directly without needing an @mention.

### Slash Commands
Use slash commands for ephemeral responses:
```
/generate prompt: a beautiful sunset landscape
/ask question: what is the meaning of life? model: llama2
```

## API Rate Limiting

- **Serial Processing**: Only 1 request per API endpoint at a time
- **Queueing**: Additional requests are queued and processed in order
- **Busy Status**: Users are notified if an API is busy and can retry
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
[2024-02-05T14:30:45.123Z] [success] [username] REQUEST: [generate] create an image
[2024-02-05T14:30:52.456Z] [success] [username] REPLY: ComfyUI response sent: 1 images
```

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

### Cannot access configurator
- Verify you're accessing from `http://localhost:{HTTP_PORT}/configurator`
- Configurator is **localhost-only** — remote access is blocked for security
- The HTTP server starts immediately on `npm run dev` / `npm start` — no Discord connection needed

### Config changes not applying
- **API endpoints & keywords**: Use configurator's "Save Changes" button (hot-reload, no restart)
- **Discord token**: Save, then stop and re-start the bot from the configurator
- **HTTP port**: Requires full process restart
- Check the configurator's status console for reload confirmation

## Contributing

Contributions are welcome! Please submit pull requests with improvements.

## License

MIT
