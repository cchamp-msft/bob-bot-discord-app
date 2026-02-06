# Bob Bot - Discord AI Integration

A Discord bot that monitors @mentions and keywords, routes requests to ComfyUI or Ollama APIs, and returns results as threaded replies or ephemeral slash commands with organized file outputs and comprehensive logging.

## Features

- ✅ @mention detection with threaded replies
- ✅ Slash commands with ephemeral responses (shareable by user)
- ✅ ComfyUI integration for image generation
- ✅ Ollama integration for AI text generation
- ✅ Serial request processing with max 1 concurrent per API
- ✅ Configurable per-keyword timeouts (default: 300s)
- ✅ Smart file handling (attachments for small files, URL links for large)
- ✅ HTTP server for file serving
- ✅ Comprehensive request logging with date/requester/status tracking
- ✅ Organized output directory structure with date formatting

## Project Structure

```
src/
├── index.ts              # Main bot entry point
├── bot/
│   └── messageHandler.ts # @mention detection and threading
├── commands/
│   ├── index.ts          # Command handler
│   └── commands.ts       # Slash command definitions
├── api/
│   ├── index.ts          # API manager
│   ├── comfyuiClient.ts  # ComfyUI API client
│   └── ollamaClient.ts   # Ollama API client
└── utils/
    ├── config.ts         # Configuration loader
    ├── logger.ts         # Request logging system
    ├── fileHandler.ts    # File output management
    ├── requestQueue.ts   # Request queue with API availability tracking
    └── httpServer.ts     # Express HTTP server for file serving

config/
└── keywords.json         # Keyword to API mapping with timeouts

outputs/
├── logs/                 # Daily log files
└── YYYY/MM/DDTHH:MM/     # Generated files organized by date
```

## Setup

### Prerequisites
- Node.js 16+
- npm or yarn
- Discord Bot Token
- ComfyUI instance (optional, for image generation)
- Ollama instance (optional, for text generation)

### Installation

1. Clone the repository:
```bash
git clone https://github.com/yourusername/bob-bot-discord-app.git
cd bob-bot-discord-app
```

2. Install dependencies:
```bash
npm install
```

3. Configure environment variables:
```bash
cp .env.example .env
```

Edit `.env` and add your values:
- `DISCORD_TOKEN`: Your Discord bot token
- `DISCORD_CLIENT_ID`: Your Discord bot client ID
- `COMFYUI_ENDPOINT`: ComfyUI API endpoint (e.g., `http://localhost:8188`)
- `OLLAMA_ENDPOINT`: Ollama API endpoint (e.g., `http://localhost:11434`)
- `HTTP_PORT`: Port for output file serving (default: 3000)
- `OUTPUT_BASE_URL`: Base URL for file serving (default: `http://localhost:3000`)
- `FILE_SIZE_THRESHOLD`: Max file size for attachment (bytes, default: 10485760 = 10MB)
- `DEFAULT_TIMEOUT`: Default timeout for requests (seconds, default: 300)

4. Configure keywords:

Edit `config/keywords.json` to map keywords to APIs and set timeout overrides:

```json
{
  "keywords": [
    {
      "keyword": "generate",
      "api": "comfyui",
      "timeout": 300,
      "description": "Generate image"
    },
    {
      "keyword": "ask",
      "api": "ollama",
      "timeout": 60,
      "description": "Ask AI"
    }
  ]
}
```

### Running the Bot

#### Development mode (with auto-reload):
```bash
npm run dev:watch
```

#### Production mode:
```bash
npm run build
npm start
```

## Usage

### @mention Usage
Mention the bot with a keyword and prompt:
```
@BobBot generate a beautiful sunset landscape
@BobBot ask what is the meaning of life?
```

The bot will create a thread for the response.

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

### "API Busy" message appears frequently
- Check if ComfyUI/Ollama is running
- Increase timeout values if requests are taking longer than expected
- Check API health at configured endpoints

### Files not accessible via URL
- Verify `OUTPUT_BASE_URL` is correct
- Ensure HTTP server is running on configured port
- Check firewall/network settings

## Contributing

Contributions are welcome! Please submit pull requests with improvements.

## License

MIT
