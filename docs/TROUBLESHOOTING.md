# Troubleshooting Guide

This guide helps you resolve common issues with Bob Bot.

## Table of Contents

- [Discord Connection Issues](#discord-connection-issues)
- [API Connection Issues](#api-connection-issues)
- [File Access Issues](#file-access-issues)
- [ComfyUI Issues](#comfyui-issues)
- [Configurator Access Issues](#configurator-access-issues)
- [Configuration Issues](#configuration-issues)
- [SerpAPI / AI Overview Issues](#serpapi--ai-overview-issues)
- [Reverse Proxy / SSL Issues](#reverse-proxy--ssl-issues)

## Discord Connection Issues

### Bot doesn't respond to mentions

**Symptoms**: The bot doesn't reply when mentioned or sent a DM.

**Solutions**:
- Check `DISCORD_TOKEN` is correct in your `.env` file
- Ensure bot has permission to read messages in the channel
- Verify `DISCORD_CLIENT_ID` matches your bot's client ID
- Run `npm run register` to register slash commands
- Check the configurator's connection status indicator
- Review logs in the configurator's status console for error messages

## API Connection Issues

### "API Busy" message appears frequently

**Symptoms**: Users receive "API Busy" messages often.

**Solutions**:
- Check if ComfyUI/Ollama is running
- Use the **configurator** to test API connectivity
- Increase timeout values if requests are taking longer than expected
- Check API health at configured endpoints
- Review request queue status in logs

## File Access Issues

### Files not accessible via URL

**Symptoms**: Discord shows broken image links or file URLs don't work.

**Solutions**:
- Verify `OUTPUT_BASE_URL` is correct in your `.env` file
- Ensure HTTP server is running on configured port (default: 3003)
- Check firewall/network settings allow access to the outputs port
- Test direct access: `curl http://localhost:3003/health`
- If behind a proxy, ensure `OUTPUTS_TRUST_PROXY` is configured correctly

## ComfyUI Issues

### WebSocket connection issues

**Symptoms**: Errors mentioning "WebSocket connection failed" in logs.

**How it works**:
- The bot uses WebSockets (`ws://`) for real-time progress tracking with ComfyUI
- If WebSocket connection fails, the bot automatically falls back to HTTP polling
- The WebSocket URL is derived from the HTTP endpoint (e.g., `http://localhost:8190` → `ws://localhost:8190/ws`)

**Solutions**:
- Verify ComfyUI is accessible at the configured endpoint
- Ensure ComfyUI is not behind a proxy that blocks WebSocket connections
- The bot will automatically reconnect with retry logic if the connection drops
- Check ComfyUI logs for connection issues

### ComfyUI logging error causing workflow failures

**Symptoms**: No output is returned, ComfyUI logs show exceptions referencing `tqdm`.

**Solution**: Use port 8190 instead of 8188 so the progress meter does not result in an exception while running the sampler node.

## Configurator Access Issues

### Cannot access configurator

**Symptoms**: Browser can't connect to the configurator.

**Solutions**:
- Verify you're accessing from `http://localhost:{HTTP_PORT}/configurator`
- Configurator is **localhost-only** — remote access is blocked for security
- The HTTP server starts immediately on `npm run dev` / `npm start` — no Discord connection needed
- Check your `HTTP_PORT` setting (default: 3000)
- If `ADMIN_TOKEN` is set, every configurator request must include an `Authorization: Bearer <token>` header

## Configuration Issues

### Config changes not applying

**Symptoms**: Changes made in configurator or `.env` don't take effect.

**Solutions**:

**Hot-reload (no restart needed)**:
- API endpoints & keywords: Use configurator's "Save Changes" button
- Discord token: Save, then stop and re-start the bot from the configurator
- Check the configurator's status console for reload confirmation

**Restart required**:
- HTTP port (`HTTP_PORT`)
- Outputs port (`OUTPUTS_PORT`)
- Host bindings (`HTTP_HOST`, `OUTPUTS_HOST`)
- Trust proxy settings (`OUTPUTS_TRUST_PROXY`)

After changing any restart-required setting, stop the process and run `npm run dev` or `npm start` again.

## SerpAPI / AI Overview Issues

### AI Overview ("!second opinion") not working

**Symptoms**: `!second opinion` queries don't return AI Overview summaries.

**Enable debug logging**:

Set `DEBUG_LOGGING=true` in your `.env` file to see detailed request/response diagnostics.

**Debug log markers**:
- `SERPAPI REQUEST:` — Shows request parameters (`engine`, `q`, `hl`, `gl`, `location`)
- `SERPAPI RESPONSE:` — Shows response classification (`page_token`, `inline(N blocks)`, `error`, `empty`, or `absent`)
- `AIO-FOLLOWUP REQUEST:` — Second request for AI Overview when `page_token` is present
- `AIO-FOLLOWUP RESPONSE:` — AI Overview follow-up response

**Common causes of missing AI Overviews**:

1. **Locale mismatch** — AI Overview is mainly available for English with certain countries
   - **Solution**: Set `SERPAPI_HL=en` and `SERPAPI_GL=us` in your `.env`
   - Optional: Set `SERPAPI_LOCATION=United States` to improve coverage

2. **Niche or policy-restricted queries** — Google may not generate AI Overview for certain topics
   - This is expected upstream behavior, not a configuration issue

3. **Token expiry** — The `page_token` expires within ~1 minute
   - If the bot or SerpAPI is slow, the follow-up may return no data

**Distinguishing upstream unavailability from config issues**:
- If `ai_overview=absent` consistently across many common queries (`"what is TypeScript"`, `"weather in New York"`), the issue is likely locale configuration
- If only niche or ambiguous queries return `absent`, that is expected upstream behavior
- If logs show `ai_overview=error: …`, the error message indicates a policy or rate-limit issue

## Reverse Proxy / SSL Issues

### Setting up a reverse proxy

**Important notes**:
- This app does **not** terminate TLS itself. Use a trusted reverse SSL/TLS proxy for public inbound ports
- By default, both servers use `trust proxy = false`
- `OUTPUTS_TRUST_PROXY` can be set for outputs-server client IP handling when behind a proxy

**Security considerations**:
- If the configurator must be reachable through a reverse proxy, **set `ADMIN_TOKEN`** to a strong random value:
  ```bash
  openssl rand -hex 32
  ```
- Never expose the configurator/admin port directly to the public internet
- Keep it private and enforce strict IP filtering + authentication in the proxy layer
- The outputs server (port 3003) is designed for public access

**Configuration**:
- If behind a TLS-terminating proxy, set `OUTPUT_BASE_URL` to the external HTTPS URL:
  ```
  OUTPUT_BASE_URL=https://cdn.example.com
  ```
- Set `OUTPUTS_TRUST_PROXY=1` (or higher) when behind a proxy
- The configurator server never enables `trust proxy`
- The outputs server enables it only when `OUTPUTS_TRUST_PROXY` is set

### Nginx example

Below is a minimal Nginx `server` block for proxying the outputs server (including the `/activity` feed):

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

Required `.env` settings:

| Variable | Example | Purpose |
|----------|---------|---------|
| `OUTPUTS_TRUST_PROXY` | `1` | Trust one proxy hop so `req.ip` reflects the real client IP |
| `OUTPUT_BASE_URL` | `https://bot.example.com` | Public URL used in Discord activity-key messages |

### Health checks

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

## Getting Help

If you're still experiencing issues:

1. Check the **configurator's status console** for real-time logs
2. Review log files in `outputs/logs/`
3. Enable `DEBUG_LOGGING=true` for detailed diagnostics
4. Test API connections via the configurator's test buttons
5. Verify all environment variables in `.env`
6. Check [CONTRIBUTING.md](../CONTRIBUTING.md) for how to report issues
