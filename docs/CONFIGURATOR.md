# Web Configurator

The bot includes a **localhost-only web configurator** for easy management without editing config files directly.

## Two-Server Architecture

The bot runs two independent HTTP servers:

| Server | Default Binding | Purpose |
|--------|----------------|---------|
| **Configurator** | `127.0.0.1:3000` | Web UI for setup and management (localhost-only) |
| **Outputs** | `0.0.0.0:3003` | Serves generated images so Discord can fetch them |

> ⚠️ **Security**: The configurator must never be exposed to the public internet. Only expose port 3003 (outputs) through your firewall. The outputs server serves static files, a health endpoint, and the public activity feed.

## Public Activity Feed

The outputs server hosts a privacy-first activity timeline at `/activity` that shows the bot's decision-making as first-person narrative events. Access to the activity data API is protected by a rotating key that must be requested from the bot via Discord.

**Getting access**: Send `!activity_key` to the bot (DM or @mention). The bot replies with a temporary key and the activity page URL. Enter the key when prompted on the activity page. Keys expire after `ACTIVITY_KEY_TTL` seconds (default 300 / 5 minutes, configurable in the HTTP Server section of the configurator).

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

## Accessing the Configurator

1. Start the bot (`npm run dev`, `npm run dev:watch`, or `npm start`)
2. Open your browser to: **http://localhost:3000/configurator**
   - Both HTTP servers start immediately — no Discord connection required
   - ⚠️ Configurator is only accessible from localhost for security
   - Port matches your `HTTP_PORT` setting in `.env` (default: 3000)

## Configurator Features

- **Discord Connection**: Set client ID and bot token, test token validity, start/stop the bot
- **Bot Token**: Write-only field — token is never displayed or logged, only persisted to `.env`
- **Start/Stop Controls**: Connect or disconnect the bot from Discord without restarting the process
- **Connection Status**: Live indicator showing stopped / connecting / running / error
- **ComfyUI**: Endpoint, workflow upload, default workflow builder, discovery, export, test image generation, and image response embed toggle
- **Ollama**: Endpoint, model selection, system prompt, final pass model/prompt, and ability logging
- **AccuWeather**: API key (write-only), default location, endpoint configuration, and test connection with location resolution
- **NFL**: Enabled toggle, endpoint configuration, and test connection (no API key needed — ESPN public API)
- **Error Handling**: Configure user-facing error message and rate limit interval
- **HTTP Server**: Adjust configurator port and output base URL
- **Two-Server Architecture**: Configurator runs on localhost:3000 (secure), outputs server on 0.0.0.0:3003 (public, for Discord image fetching)
- **Limits**: Set file size threshold, default timeout, and max attachments per message
- **Message Flow Overview**: Interactive Mermaid diagram showing the bot's message processing pipeline
- **Keywords Management**: Add/edit/remove keyword→API mappings with custom timeouts
- **Status Console**: Real-time log view tailing today's log file, showing all events (startup, requests, errors, config changes) with color-coded levels

## Hot-Reload vs Restart Required

**Hot-Reload (no restart needed):**
- ComfyUI/Ollama/AccuWeather/NFL endpoints
- Ollama model selection
- Ollama system prompt
- AccuWeather API key and default location
- NFL enabled state
- Default workflow parameters (model, size, steps, sampler, scheduler, denoise, seed)
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
- Outputs port
- Trust proxy settings

## Troubleshooting

### Cannot access configurator
- Verify you're accessing from `http://localhost:{HTTP_PORT}/configurator`
- Configurator is **localhost-only** — remote access is blocked for security
- The HTTP server starts immediately on `npm run dev` / `npm start` — no Discord connection needed
- When `ADMIN_TOKEN` is set, every configurator request must include an `Authorization: Bearer <token>` header

## Remote Access & Security

### ADMIN_TOKEN

If the configurator must be reachable through a reverse proxy (e.g. for remote administration), **set `ADMIN_TOKEN`** to a strong random value (`openssl rand -hex 32`). Without it the only protection is the localhost IP check, which can be bypassed if the proxy forwards traffic from the same host.

Never expose the configurator/admin port directly to the public internet. Keep it private and enforce strict IP filtering + authentication in the proxy layer.

### Reverse Proxy / SSL Termination

- This app does **not** terminate TLS itself. Use a trusted reverse SSL/TLS proxy for public inbound ports
- By default, both servers use `trust proxy = false` — `req.ip` is always the direct socket address and cannot be spoofed via `X-Forwarded-For` headers
- `OUTPUTS_TRUST_PROXY` can be set for outputs-server client IP handling (`false`, `true`, or a hop count like `1`) when running behind a trusted proxy/load balancer
- The outputs server (port 3003) is designed for public access — if placed behind a TLS-terminating proxy, set `OUTPUT_BASE_URL` to the external HTTPS URL so generated image links work correctly (e.g. `OUTPUT_BASE_URL=https://cdn.example.com`). The activity feed (`/activity`) serves static HTML publicly; `GET /api/activity` requires a valid rotating key obtained from the bot via Discord
- The configurator server never enables `trust proxy`. The outputs server enables it only when `OUTPUTS_TRUST_PROXY` is set — HTTPS is assumed to be handled entirely upstream
- Restrict the configurator's upstream proxy route to trusted IP ranges / authentication at the proxy layer as an additional defence in depth

#### Nginx Example — Activity Feed

Below is a minimal Nginx `server` block for proxying the outputs server (including the `/activity` feed). Adjust `server_name` and certificate paths to match your environment.

```nginx
server {
    listen 443 ssl;
    server_name bot.example.com;

    ssl_certificate     /etc/letsencrypt/live/bot.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/bot.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3003;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Required `.env` settings when using the proxy:

| Variable | Example | Purpose |
|----------|---------|---------|
| `OUTPUTS_TRUST_PROXY` | `1` | Trust one proxy hop so `req.ip` reflects the real client IP |
| `OUTPUT_BASE_URL` | `https://bot.example.com` | Public URL used in Discord activity-key messages |

Quick health checks after setup:

```bash
# Direct — should return {"status":"ok", ...}
curl http://127.0.0.1:3003/health

# Via proxy — same response over HTTPS
curl https://bot.example.com/health

# Activity page — should return HTML
curl -I https://bot.example.com/activity

# Activity API without key — should return 401
curl https://bot.example.com/api/activity
```

## Deployment Notes

- The configurator server binds to `127.0.0.1` by default; the outputs server binds to `0.0.0.0`
- Admin/configurator routes are guarded by `ADMIN_TOKEN` + localhost IP check; output files are served publicly
- Changing `HTTP_PORT`, `HTTP_HOST`, `OUTPUTS_PORT`, `OUTPUTS_HOST`, or `OUTPUTS_TRUST_PROXY` requires a full process restart (the configurator will report this)
