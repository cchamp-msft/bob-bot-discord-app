# Plan: Split HTTP Servers — Configurator (localhost) + Outputs (public)

**Status:** Not Started  
**Priority:** Critical (blocking for Plans A, B, C)  
**Estimated Effort:** Medium

## Overview

Resolve the localhost/public binding conflict by separating the configurator (localhost-only, port 3000) and outputs file server (network-accessible, port 3003) into independent HTTP listeners. This eliminates the security tension where configurator endpoints require strict localhost binding while Discord webhooks need public access to image URLs.

## Steps

### 1. Add outputs server configuration
- Add to [src/utils/config.ts](../../src/utils/config.ts):
  - `getOutputsPort(): number` → parses `OUTPUTS_PORT` (default: `3003`)
  - `getOutputsHost(): string` → parses `OUTPUTS_HOST` (default: `0.0.0.0`)
- Update `getOutputBaseUrl()` default: from `http://localhost:3000` → `http://localhost:3003`
- Update [.env.example](../../.env.example):
  - Add `OUTPUTS_PORT=3003`
  - Add `OUTPUTS_HOST=0.0.0.0` with comment: "Bind to all interfaces so Discord can fetch images"
  - Update `OUTPUT_BASE_URL=http://localhost:3003`
  - Add `HTTP_HOST=127.0.0.1` with comment: "Configurator is localhost-only"

### 2. Create OutputsServer class
- Create [src/utils/outputsServer.ts](../../src/utils/outputsServer.ts):
  - Minimal Express app serving static `outputs/` directory
  - Health endpoint: `GET /health`
  - Logs blocking: `GET /logs` → 403
  - Bind to `config.getOutputsHost()` on `config.getOutputsPort()`
  - Include `start()` and `stop()` methods matching httpServer pattern
  - Export singleton: `export const outputsServer = new OutputsServer()`

### 3. Remove outputs routes from configurator server
- Update [src/utils/httpServer.ts](../../src/utils/httpServer.ts):
  - Remove lines 414-421 (`/logs` blocker + `express.static(outputsDir)`)
  - Keep configurator routes, API routes, test-generation endpoint
  - Keep `/health` on configurator for monitoring (both servers have health)
  - Update startup log to clarify: "Configurator (localhost-only)"

### 4. Wire outputs server into bot startup
- Update [src/index.ts](../../src/index.ts):
  - Import `outputsServer` from `./utils/outputsServer`
  - Call `outputsServer.start()` after `httpServer.start()`
  - Add startup log: `Outputs server: http://${host}:${port}` (use displayHost logic)
  - On shutdown (if exists), call `await outputsServer.stop()`

### 5. Update tests
- Create [tests/outputsServer.test.ts](../../tests/outputsServer.test.ts):
  - Test it starts on configured port/host
  - Test it serves files from `outputs/`
  - Test it blocks `/logs` access
  - Test `stop()` shuts down cleanly
- Update [tests/httpServer.test.ts](../../tests/httpServer.test.ts):
  - Remove any tests expecting static file serving
  - Verify configurator routes still work
- Update [tests/fileHandler.test.ts](../../tests/fileHandler.test.ts):
  - Verify `saveFile()` constructs URLs using `OUTPUT_BASE_URL` (now port 3003)

### 6. Update documentation
- Update [README.md](../../README.md) (if deployment section exists):
  - Document two-server architecture
  - Configurator: localhost:3000 (secure, for setup)
  - Outputs: 0.0.0.0:3003 (public, for Discord image fetching)
  - Firewall guidance: only expose 3003, never 3000
- Add security note: "Configurator must never be exposed to public internet"

## Verification

- `npm test` passes with new/updated tests
- Start bot locally:
  - Verify configurator accessible at `http://127.0.0.1:3000/configurator`
  - Verify from another device on LAN: configurator returns 403 or connection refused
  - Verify from another device: `http://<bot-ip>:3003/` serves outputs
- Generate image via Discord, verify Discord can fetch from port 3003
- Check logs confirm both servers started on correct hosts/ports

## Decisions

- **Outputs default to `0.0.0.0`** so Discord webhooks work out-of-box (best practice exception justified)
- **Configurator stays `127.0.0.1`** with no override option (simpler security model)
- **Health endpoints on both** for independent monitoring/load balancing
- **Port 3003** chosen to avoid common conflicts (3001/3002 often used by React/Next.js dev servers)

## Dependencies

None — this is the foundation for Plans A, B, C.

## Risks

- Breaking change: existing `.env` files with `OUTPUT_BASE_URL=http://localhost:3000` will need manual update
- Migration path: document in commit message and README