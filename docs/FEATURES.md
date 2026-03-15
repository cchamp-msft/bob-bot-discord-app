# Complete Feature List

This document contains the comprehensive list of Bob Bot's features and capabilities.

## Core Features

### Discord Integration
- ✅ @mention and DM detection with inline replies
- ✅ **DM conversation context** — DMs automatically include recent message history without requiring explicit replies
- ✅ Configurable slash command with ephemeral responses — single `/bot` command for all interactions
- ✅ **Message deletion** — `delete_discord_message` tool lets users ask the bot to delete its own messages by reply, channel, DM username, or message ID

### AI & Image Generation
- ✅ ComfyUI integration for image generation (WebSocket-based with HTTP polling fallback)
- ✅ Ollama integration for AI text generation
- ✅ **xAI (Grok) integration** — alternative LLM provider with per-stage selection (tool eval, final pass, context eval)
- ✅ **Ollama model discovery** — test connection loads available models for selection
- ✅ **Ollama system prompt** — configurable personality/context sent with every request
- ✅ **Cross-provider tools** — `consult_grok` (Ollama→xAI) and `delegate_to_local` (xAI→Ollama final pass)
- ✅ **xAI image generation** — `generate_image_grok` tool for image generation via xAI's `/images/generations` endpoint with configurable model
- ✅ **xAI video generation** — `generate_video_grok` tool for video generation via xAI's `/videos/generations` endpoint with async polling
- ✅ **Tool batch policy** — prevents SerpAPI+xAI mixing with prompt hints and runtime enforcement
- ✅ **Image-to-text (vision)** — attach images to any @mention or DM; the bot downloads them, base64-encodes, and sends to a vision-capable Ollama model. Auto-switches to `OLLAMA_VISION_MODEL` when the default model lacks vision capability. Supports PNG, JPEG, GIF, and WebP up to configurable size and count limits.
- ✅ **ComfyUI workflow upload** — upload JSON workflow with `%prompt%` placeholder substitution

### External APIs
- ✅ AccuWeather integration for real-time weather data (current conditions + 10-day forecast)
- ✅ **NFL game data** — live scores and news via ESPN, with optional date-based lookups and news filtering
- ✅ **Web search** — Google Search via SerpAPI with AI Overview support; `!web_search` returns Google search results with AI Overview summaries (AI Overview availability is locale-dependent — configure `SERPAPI_HL`/`SERPAPI_GL`; optional `SERPAPI_LOCATION` can further improve coverage)
- ✅ **Web fetch** — `fetch_webpage` tool retrieves web pages and images by URL for LLM analysis; includes SSRF protection (blocks private/reserved IPs, validates DNS, checks redirect hops), robots.txt support, captcha detection with SerpAPI fallback, and configurable size limits
- ✅ **Meme generation** — create meme images from popular templates via [memegen.link](https://memegen.link); `!meme` with template name and text lines, and `!meme_templates` to list template IDs; templates cached locally and refreshed every 7 days

## Advanced Features

### Request Processing & Routing
- ✅ Serial request processing with max 1 concurrent per API
- ✅ Configurable per-tool timeouts (default: 300s)
- ✅ **Two-stage evaluation** — Ollama responses are checked for first-line tool directives, enabling automatic ability routing without a fallback classifier
- ✅ **Ollama fixup layer** — recovers tool calls from models that return them as text instead of native `tool_calls` format; extracts XML/JSON tool blocks, repairs malformed URLs, and strips preamble text
- ✅ **Ability retry** — when an API call fails (e.g., location not found), the bot can re-prompt Ollama to refine parameters and retry; configurable globally and per-tool with custom model and prompt overrides
- ✅ **Rate-limited error messages** — configurable user-facing error messages with minimum interval

### Context & Conversation Management
- ✅ **Reply chain context** — traverses Discord reply threads to provide conversation history to Ollama
- ✅ **Image prompt cleanup** — routing tool names are stripped from prompts before submission to ComfyUI
- ✅ **Reply-based image generation** — replying to a message with an image tool combines the quoted content with the user's prompt
- ✅ **Conversational responses** — Ollama replies use plain text instead of embed blocks for a natural feel

### Configuration & Management
- ✅ **Web-based configurator** — localhost-only SPA for managing all settings
- ✅ **Discord start/stop controls** — manage bot connection from the configurator
- ✅ **Hot-reload support** — API endpoints and tools reload without restart
- ✅ **Graceful shutdown** — cleans up Discord, HTTP server, and WebSocket connections on SIGINT/SIGTERM

## File Handling & Output

- ✅ Smart file handling (attachments for small files, URL links for large)
- ✅ HTTP server for file serving
- ✅ Comprehensive request logging with date/requester/status tracking
- ✅ **Thread ID correlation** — each request-queue execution gets a 4-character hex thread ID (`[a1b2]`) in log lines, enabling easy correlation of related log entries across classify → route → API execution chains
- ✅ Organized output directory structure with date formatting
- ✅ **Configurable image response format** — embed block with internal link is optional (disabled by default)

## Weather Features

- ✅ **Weather via slash command** — `!weather` prefix through the `/bot` command with optional location
- ✅ **Unified weather routing** — weather keywords route through AccuWeather via the shared API routing path

## Advanced Configuration

- ✅ **Global final-pass model** — configurable Ollama model for all final-pass refinements
- ✅ **Optional final pass** — model infers from user intent whether a final synthesis pass is needed; requests for raw/formatted data skip the pass, while opinionated/interpreted requests always run it
- ✅ **Ability logging** — opt-in detailed logging of abilities context sent to Ollama
- ✅ **Ability parameter inference** — when two-stage evaluation detects an API keyword with required inputs, Ollama infers concrete parameters from user context before routing (e.g., resolving "capital of Thailand" → "Bangkok" for weather)
- ✅ **NFL commands** — `!nfl_scores` (current or date-specific) and `!nfl_news` (with optional search term filter)

## Monitoring & Privacy

- ✅ **Public activity feed** — privacy-first `/activity` page on the outputs server showing bot decisions as first-person narrative events; no raw message content, user IDs, or API keys are exposed; protected by a rotating access key requested from Discord via the `!activity_key` keyword

## Development & Testing

- ✅ **Unit test suite** — 1,894 tests across 41 suites covering core functionality
