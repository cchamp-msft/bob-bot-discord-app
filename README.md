# Bob Bot - Discord AI Integration

A Discord bot that monitors @mentions and DMs, routes keyword-matched requests to ComfyUI or Ollama APIs, and returns results as inline replies or ephemeral slash commands with organized file outputs and comprehensive logging.

## Features

- ✅ @mention and DM detection with inline replies
- ✅ Slash commands with ephemeral responses (shareable by user)
- ✅ ComfyUI integration for image generation (WebSocket-based with HTTP polling fallback)
- ✅ Ollama integration for AI text generation
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
- ✅ **Conversational responses** — Ollama replies use plain text instead of embed blocks for a natural feel
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
│   ├── comfyuiClient.ts  # ComfyUI API client (workflow execution)
│   ├── comfyuiWebSocket.ts # ComfyUI WebSocket manager (real-time execution tracking)
│   └── ollamaClient.ts   # Ollama API client
├── public/
│   └── configurator.html # Web-based configurator SPA
└── utils/
    ├── config.ts         # Configuration loader (with hot-reload)
    ├── configWriter.ts   # Configuration persistence layer
    ├── logger.ts         # Unified logging system (console + file + configurator tail)
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
> `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `COMFYUI_ENDPOINT`, `OLLAMA_ENDPOINT`, `OLLAMA_MODEL`, `OLLAMA_SYSTEM_PROMPT`, `HTTP_PORT`, `OUTPUT_BASE_URL`, `FILE_SIZE_THRESHOLD`, `DEFAULT_TIMEOUT`, `MAX_ATTACHMENTS`, `ERROR_MESSAGE`, `ERROR_RATE_LIMIT_MINUTES`, `REPLY_CHAIN_ENABLED`, `REPLY_CHAIN_MAX_DEPTH`, `REPLY_CHAIN_MAX_TOKENS`, `COMFYUI_DEFAULT_MODEL`, `COMFYUI_DEFAULT_WIDTH`, `COMFYUI_DEFAULT_HEIGHT`, `COMFYUI_DEFAULT_STEPS`, `COMFYUI_DEFAULT_CFG`, `COMFYUI_DEFAULT_SAMPLER`, `COMFYUI_DEFAULT_SCHEDULER`, `COMFYUI_DEFAULT_DENOISE`

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
- **Default Workflow Builder**: Configure a basic text-to-image workflow with checkpoint model, image size, steps, sampler, scheduler, and denoise — no manual JSON editing required
- **ComfyUI Discovery**: Auto-detect available checkpoints, samplers, and schedulers from the connected ComfyUI instance
- **Error Handling**: Configure user-facing error message and rate limit interval
- **HTTP Server**: Adjust port and output base URL
- **Limits**: Set file size threshold, default timeout, and max attachments per message
- **Keywords Management**: Add/edit/remove keyword→API mappings with custom timeouts
- **Status Console**: Real-time log view tailing today's log file, showing all events (startup, requests, errors, config changes) with color-coded levels

### Hot-Reload vs Restart Required

**Hot-Reload (no restart needed):**
- ComfyUI/Ollama endpoints
- Ollama model selection
- Ollama system prompt
- Default workflow parameters (model, size, steps, sampler, scheduler, denoise)
- Error message and rate limit
- Reply chain settings (enabled, max depth, max tokens)
- Output base URL
- File size threshold
- Default timeout
- Max attachments per message
- Keywords (entire list)
- Discord token and client ID (stop and re-start the bot from configurator)

**Restart Required:**
- HTTP port

## Running Tests

The bot includes a comprehensive unit test suite with 169 tests covering configuration, logging, file handling, request queuing, message handling, API clients, and config persistence.

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
- **logger.test.ts** — Log formatting, level mapping, console output, file tail
- **requestQueue.test.ts** — API locking, timeouts, concurrency

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

### Bot Permissions

When generating an OAuth2 invite link, include these **Bot Permissions**:

- **Send Messages** — reply to users
- **Read Message History** — fetch referenced messages in reply chains
- **Attach Files** — send generated images
- **Embed Links** — send ComfyUI response embeds
- **Use Slash Commands** — register and respond to `/generate` and `/ask`

## Reply Chain Context

When a user replies to a previous message (theirs or the bot's), the bot automatically traverses the Discord reply chain to build conversation history. This context is sent to Ollama using the `/api/chat` endpoint with proper role-based messages (`user` / `assistant`), enabling multi-turn conversations.

### How It Works

1. User sends a message that replies to a previous bot response
2. Bot traverses `message.reference` links up the chain (up to max depth)
3. Each message in the chain is tagged as `user` or `assistant` based on the author
4. The full conversation is sent to Ollama's chat API with the system prompt
5. Ollama responds with awareness of the entire conversation

### Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `REPLY_CHAIN_ENABLED` | `true` | Set to `false` to disable reply chain traversal |
| `REPLY_CHAIN_MAX_DEPTH` | `10` | Maximum messages to traverse (1–50) |
| `REPLY_CHAIN_MAX_TOKENS` | `16000` | Character budget for collected context (1,000–128,000) |

### Behavior Notes

- Only applies to **Ollama** text generation (not ComfyUI image generation)
- Deleted or inaccessible messages in the chain are skipped gracefully
- Circular references are detected and traversal stops
- Single messages (not replies) work exactly as before — no context overhead
- Bot responses are sent as **plain text** (not embed blocks) for a conversational feel

## Usage

### Ollama Model Configuration

Ollama models are discovered automatically when you click **Test** in the configurator's API Endpoints section. The model list is fetched from the Ollama `/api/tags` endpoint and populates the dropdown. Select a model and click **Save Changes** to persist it to `.env` as `OLLAMA_MODEL`.

If no model is configured or the selected model becomes unavailable, the bot will return an error to the console and send a rate-limited error message to Discord users.

The `/ask` slash command also accepts an optional `model` parameter to override the default on a per-request basis.

### ComfyUI Workflow Configuration

ComfyUI uses workflow JSON files to define generation pipelines. There are two ways to configure a workflow:

#### Option 1: Default Workflow (Recommended for Getting Started)

The configurator includes a **Default Workflow Settings** section that generates a basic text-to-image workflow from configurable parameters:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `COMFYUI_DEFAULT_MODEL` | *(none)* | Checkpoint model file (e.g. `sd_xl_base_1.0.safetensors`) |
| `COMFYUI_DEFAULT_WIDTH` | `512` | Latent image width (must be divisible by 8) |
| `COMFYUI_DEFAULT_HEIGHT` | `512` | Latent image height (must be divisible by 8) |
| `COMFYUI_DEFAULT_STEPS` | `20` | Number of sampling steps |
| `COMFYUI_DEFAULT_CFG` | `7.0` | Classifier-free guidance scale |
| `COMFYUI_DEFAULT_SAMPLER` | `euler` | Sampler algorithm |
| `COMFYUI_DEFAULT_SCHEDULER` | `normal` | Noise scheduler |
| `COMFYUI_DEFAULT_DENOISE` | `1.0` | Denoise strength (0–1.0; use 0.88 for partial denoising) |

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

**Workflow Precedence:** If a custom workflow is uploaded, it always takes priority over the default workflow. Remove the custom workflow via the configurator to revert to default workflow settings.

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
- **Not supported behind a reverse proxy** — the configurator checks `req.ip` directly and does not support `X-Forwarded-For` or `trust proxy` headers. If your staging environment uses a reverse proxy, ensure it does *not* forward `/configurator` or `/api/config*` routes from remote clients

### Staging / deployment notes
- The HTTP server binds on all interfaces by default (`0.0.0.0`) — restrict access via firewall rules or network policy if the host is reachable externally
- Configurator and config API routes are localhost-only at the application level; output files under `/` are served publicly to anyone who can reach the port
- Future work: HTTPS / signed-URL support for sharing large output files

### Config changes not applying
- **API endpoints & keywords**: Use configurator's "Save Changes" button (hot-reload, no restart)
- **Discord token**: Save, then stop and re-start the bot from the configurator
- **HTTP port**: Requires full process restart
- Check the configurator's status console for reload confirmation

## Contributing

Contributions are welcome! Please submit pull requests with improvements.

## License

MIT
