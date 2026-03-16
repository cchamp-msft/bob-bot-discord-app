# Model Selection Guide

## Overview

Why model choice matters for this bot: consistency of tool-call formatting, response quality, memory footprint for local models, and cost for cloud APIs. This guide reflects hands-on testing by the maintainer — your mileage may vary.

## Ollama Models (Local)

### Recommended
- **qwen3.5 (27B dense / 35B MoE)** — Best overall local model tested. Punches well above its weight class for tool calling and conversational quality. The 27B dense variant offers the best balance of quality and VRAM usage; the 35B MoE variant is slightly better but requires more memory.
- **qwen3-vl** — Best for combined tools + vision tasks. Fast inference, reliable tool-call formatting.
- **gemma3** — Excellent tool compatibility and good conversational output. A solid alternative if qwen3.5 doesn't fit your hardware.

### Abliterated / Uncensored Models
Uncensored or "abliterated" model variants (e.g., dolphin, abliterated finetunes) are interesting for experimentation but tend to lose tool-call compatibility first. In testing, qwen3.5's reliability with structured tool output outweighed the novelty of uncensored responses. Use these if you value unrestricted output and can tolerate occasional tool-call failures.

### Models Without Tool Support
Some models (older llama2 variants, smaller phi models, specialized code models) lack reliable tool-call support. The bot's pipeline depends on structured tool responses — models that can't produce them will fail silently or return garbled routing. These are insufficient for this bot's architecture.

## xAI API Models (Cloud)

- **grok-4-1-reasoning** — Near qwen3.5 quality with strong tool-use support. Good for tool eval and final pass stages. Reasoning tokens add latency but improve accuracy.
- **grok-4-1-nonreasoning** — Best used for final-pass only. Struggles with multi-tool routing but produces good conversational output.
- **grok-4-2 beta** — Promising quality improvements but significantly more expensive. Worth monitoring as it matures.
- xAI models excel at video generation — competitive cost and strong prompt adherence compared to alternatives.

## ComfyUI Models (Image Generation)

- **SDXL (Stable Diffusion XL)** — Best output-to-VRAM ratio in testing. Produces high-quality images with reasonable generation times on consumer GPUs.
- **Flux1.dev / Flux2.dev** — Competitive with xAI image generation quality. Higher VRAM requirements than SDXL but excellent detail and prompt adherence.
- Model choice depends on your GPU — SDXL runs well on 8GB VRAM, Flux models prefer 12GB+.

## Recommendations by Pipeline Stage

| Pipeline Stage | Recommended (Local) | Recommended (Cloud) | Notes |
|---------------|---------------------|---------------------|-------|
| **Tool Eval** | qwen3.5 | grok-4-1-reasoning | Must produce reliable structured tool calls |
| **Final Pass** | qwen3.5 or gemma3 | grok-4-1-nonreasoning | Conversational quality matters most here |
| **Context Eval** | qwen3.5 (smaller ctx) | grok-4-1-reasoning | Lightweight task; use a smaller context window |
| **Image Gen** | SDXL (via ComfyUI) | xAI image API | Local gives more control; cloud is simpler |

## Mixing Providers

The bot supports per-stage provider selection (`PROVIDER_TOOL_EVAL`, `PROVIDER_FINAL_PASS`, `PROVIDER_CONTEXT_EVAL`). A common setup:
- **Tool eval**: Ollama (qwen3.5) — fast, free, reliable tool routing
- **Final pass**: xAI (grok) — higher quality conversational output
- **Context eval**: Ollama (qwen3.5) — lightweight local processing

See [API Integration Guide](API_INTEGRATION.md) for provider configuration details.
