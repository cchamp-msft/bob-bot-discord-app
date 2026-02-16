# Complete Feature List

This document contains the comprehensive list of Bob Bot's features and capabilities.

## Core Features

### Discord Integration
- ✅ @mention and DM detection with inline replies
- ✅ **DM conversation context** — DMs automatically include recent message history without requiring explicit replies
- ✅ Slash commands with ephemeral responses (shareable by user)

### AI & Image Generation
- ✅ ComfyUI integration for image generation (WebSocket-based with HTTP polling fallback)
- ✅ Ollama integration for AI text generation
- ✅ **Ollama model discovery** — test connection loads available models for selection
- ✅ **Ollama system prompt** — configurable personality/context sent with every request
- ✅ **ComfyUI workflow upload** — upload JSON workflow with `%prompt%` placeholder substitution

### External APIs
- ✅ AccuWeather integration for real-time weather data (current conditions + 5-day forecast)
- ✅ **NFL game data** — live scores and news via ESPN, with optional date-based lookups and news filtering
- ✅ **Web search** — Google Search via SerpAPI with AI Overview support; `search` returns full results, `second opinion` returns only Google's AI Overview (AI Overview availability is locale-dependent — configure `SERPAPI_HL`/`SERPAPI_GL`; optional `SERPAPI_LOCATION` can further improve coverage)

## Advanced Features

### Request Processing & Routing
- ✅ Serial request processing with max 1 concurrent per API
- ✅ Configurable per-keyword timeouts (default: 300s)
- ✅ **Two-stage evaluation** — Ollama responses are re-evaluated for API keyword triggers, enabling automatic ability routing
- ✅ **Rate-limited error messages** — configurable user-facing error messages with minimum interval

### Context & Conversation Management
- ✅ **Reply chain context** — traverses Discord reply threads to provide conversation history to Ollama
- ✅ **Image prompt cleanup** — routing keywords are stripped from prompts before submission to ComfyUI
- ✅ **Reply-based image generation** — replying to a message with an image keyword combines the quoted content with the user's prompt
- ✅ **Conversational responses** — Ollama replies use plain text instead of embed blocks for a natural feel

### Configuration & Management
- ✅ **Web-based configurator** — localhost-only SPA for managing all settings
- ✅ **Discord start/stop controls** — manage bot connection from the configurator
- ✅ **Hot-reload support** — API endpoints and keywords reload without restart
- ✅ **Graceful shutdown** — cleans up Discord, HTTP server, and WebSocket connections on SIGINT/SIGTERM

## File Handling & Output

- ✅ Smart file handling (attachments for small files, URL links for large)
- ✅ HTTP server for file serving
- ✅ Comprehensive request logging with date/requester/status tracking
- ✅ Organized output directory structure with date formatting
- ✅ **Configurable image response format** — embed block with internal link is optional (disabled by default)

## Weather Features

- ✅ **Weather slash command** — `/weather` command with optional location and report type parameters
- ✅ **Weather→AI routing** — weather data piped through Ollama for AI-powered weather reports via `finalOllamaPass`

## Advanced Configuration

- ✅ **Global final-pass model** — configurable Ollama model for all final-pass refinements
- ✅ **Ability logging** — opt-in detailed logging of abilities context sent to Ollama
- ✅ **NFL commands** — `nfl scores` (current or date-specific) and `nfl news` (with optional keyword filter)

## Monitoring & Privacy

- ✅ **Public activity feed** — privacy-first `/activity` page on the outputs server showing bot decisions as first-person narrative events; no raw message content, user IDs, or API keys are exposed; protected by a rotating access key requested from Discord via the `activity_key` keyword

## Development & Testing

- ✅ **Unit test suite** — 100+ tests covering core functionality
