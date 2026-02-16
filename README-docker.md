# Running the bot in Docker

This document covers building and running the Discord bot in a Docker container. The main [README](README.md) describes running without Docker.

## Quickstart

1. **Copy environment template**
   ```bash
   cp .env.example .env
   ```
   Optional: copy Docker-specific overrides as a starting point:
   ```bash
   cp .env.example.docker .env.docker
   ```
   Then merge the values you need into `.env`.

2. **Edit `.env` for Docker**
   - Set `HTTP_HOST=0.0.0.0` so the configurator can accept connections inside the container.
   - Enable remote configurator access and set an allowlist (so your host browser can reach the UI):
     ```env
     CONFIGURATOR_ALLOW_REMOTE=true
     CONFIGURATOR_ALLOWED_IPS=172.17.0.0/16,192.168.0.0/16
     ```
     Use `172.17.0.0/16` for the default Docker bridge; add your LAN subnet if you access from another machine.
   - **Set `ADMIN_TOKEN`** (required when `CONFIGURATOR_ALLOW_REMOTE` is true). Generate a value, e.g.:
     ```bash
     openssl rand -hex 32
     ```
     Put it in `.env` as `ADMIN_TOKEN=<that-value>`. You will enter this token in the configurator UI when prompted.
   - Point the bot at services running on the host (Docker Desktop: use `host.docker.internal`):
     ```env
     OLLAMA_ENDPOINT=http://host.docker.internal:11434
     COMFYUI_ENDPOINT=http://host.docker.internal:8190
     ```
     On Linux (without Docker Desktop), use the host’s IP or `--network host` and `localhost`.

3. **Create directories** (optional; Compose will create them if missing, but having them avoids permission issues):
   ```bash
   mkdir -p outputs .config config
   ```

4. **Build and run**
   ```bash
   docker compose up --build
   ```

5. **Open the configurator**
   - In a browser: `http://localhost:3000/configurator`
   - When prompted, enter your `ADMIN_TOKEN` (the same value as in `.env`). It is stored in the browser session for the rest of the tab’s life.

6. **Register slash commands** (one-time, after the bot is running and `DISCORD_TOKEN` / `DISCORD_CLIENT_ID` are set):
   ```bash
   docker compose exec bot node dist/registerCommands.js
   ```
   Or run `npm run register` once from the host if you have Node and `.env` there.

## Persistence

The Compose file mounts these so that data survives container restarts and configurator “Save” works:

| Mount              | Purpose |
|--------------------|--------|
| `./.env`           | Environment; configurator writes here when you save. |
| `./outputs`        | Generated images and daily log files. |
| `./.config`        | ComfyUI workflow file (when uploaded). |
| `./config`         | `keywords.json` (and `keywords.default.json` is in the image). |

Ensure these paths are writable by the user the container runs as. If `config/keywords.json` does not exist, the app creates it from `keywords.default.json` on first run.

## Ports

- **3000** — Configurator (admin UI). Compose binds it to `127.0.0.1:3000` on the host so it is not exposed to the network.
- **3003** — Outputs server (images, activity page). Bound to `0.0.0.0:3003` so Discord and the host can reach it.

Change via `HTTP_PORT` and `OUTPUTS_PORT` in `.env` (and in `docker-compose.yml` if you change the host mapping).

## Security

- **Configurator**: When `CONFIGURATOR_ALLOW_REMOTE=true`, access is limited to IPs in `CONFIGURATOR_ALLOWED_IPS` (and localhost). Always set a strong `ADMIN_TOKEN` and use it in the browser when prompted. Do not expose port 3000 to the public internet.
- **Outputs server**: Designed to be reachable (e.g. by Discord for image links). If you put it behind a reverse proxy, set `OUTPUTS_TRUST_PROXY` and `OUTPUT_BASE_URL` as in the main README.

## SSL/TLS termination (practical and secure)

This app does not terminate TLS itself. Keep the bot container on plain HTTP internally and terminate HTTPS at a trusted edge proxy (Nginx, Caddy, Traefik, cloud load balancer).

### Recommended pattern

1. **Keep app ports private**
   - Keep `3000` (configurator) private/internal only.
   - Keep `3003` reachable only by your proxy (or localhost if proxy runs on the host).
2. **Terminate TLS at the proxy**
   - Proxy forwards to `http://bot:3003` (same Docker network) or `http://127.0.0.1:3003` (host proxy model).
3. **Set Docker/proxy env correctly**
   - `OUTPUT_BASE_URL=https://your-public-host`
   - `OUTPUTS_TRUST_PROXY=1` (or the exact hop count)
   - `ADMIN_TOKEN=<strong-random-value>`
4. **Do not publish configurator externally**
   - If remote admin is required, keep strict allowlists and require `ADMIN_TOKEN`.

### Minimal Nginx example (activity + outputs)

```nginx
server {
    listen 443 ssl;
    server_name bot.example.com;

    ssl_certificate     /etc/letsencrypt/live/bot.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/bot.example.com/privkey.pem;

    # Outputs server: images + /activity + /api/activity
    location / {
        proxy_pass http://127.0.0.1:3003;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### Quick verification

```bash
# App direct (inside host)
curl http://127.0.0.1:3003/health

# Through TLS proxy
curl https://bot.example.com/health

# Activity page over TLS
curl -I https://bot.example.com/activity

# Activity API without key (expected 401)
curl https://bot.example.com/api/activity
```

Security notes:
- Never expose the configurator/admin surface directly to the public internet.
- Set `OUTPUTS_TRUST_PROXY` only when requests pass through a trusted proxy path.
- Keep certificate management in the proxy layer (e.g., Let's Encrypt automation).

## Common commands

```bash
# Build image
docker compose build

# Start in foreground
docker compose up

# Start in background
docker compose up -d

# View logs
docker compose logs -f bot

# Stop
docker compose down

# Shell in container
docker compose exec bot sh
```

## Troubleshooting

### Configurator shows “Admin token required” or 401
- Ensure `ADMIN_TOKEN` is set in `.env` and you entered the same value in the browser prompt.
- Token is stored per tab (session). Reload the page and enter it again if needed.

### Configurator returns 403 Forbidden
- When `CONFIGURATOR_ALLOW_REMOTE=true`, your client IP must be in `CONFIGURATOR_ALLOWED_IPS`. From the host to a container, the connection often appears as the Docker bridge (e.g. `172.17.x.x`). Add `172.17.0.0/16` to the allowlist. If you use a different network, add that subnet (e.g. `192.168.0.0/16`).

### Bot cannot reach Ollama or ComfyUI
- From inside the container, `localhost` is the container itself. Use `host.docker.internal` (Docker Desktop on Windows/Mac) or your host’s IP on Linux.
- Set in `.env`:
  - `OLLAMA_ENDPOINT=http://host.docker.internal:11434`
  - `COMFYUI_ENDPOINT=http://host.docker.internal:8190`

### Discord cannot load generated images
- The bot uses `OUTPUT_BASE_URL` for image links. If the bot runs in Docker, that URL must be reachable by Discord (and by users opening the link). Use a public URL (e.g. your server’s hostname or a reverse proxy). Do not use `localhost` or `host.docker.internal` for `OUTPUT_BASE_URL` if Discord runs on the internet.

### Health check failing
- The image healthcheck hits `http://127.0.0.1:3003/health` inside the container. If the outputs server is not listening on 3003 or is slow to start, the check may fail. Ensure `OUTPUTS_PORT=3003` (default) and that no other process in the container uses that port.

### Linux: host.docker.internal not defined
- On Docker Engine (Linux) without Docker Desktop, `host.docker.internal` may not exist. Use the host’s IP (e.g. from `ip addr`) for `OLLAMA_ENDPOINT` and `COMFYUI_ENDPOINT`, or run the stack with `network_mode: host` and use `localhost` in `.env` (then bind configurator to a specific IP if you want to limit access).
