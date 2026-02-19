## Plan: Discord Image-to-Text via Ollama (DRAFT)

Add a focused multimodal input path so messages that mention the bot and include image attachments are analyzed by a vision-capable Ollama model, then merged into the existing response pipeline without changing overall routing architecture. This keeps current behavior intact for text-only messages while enabling image-derived context for mention+image messages. Based on your decisions, the flow will process all attached images, combine results into one structured text context, and auto-switch to a configured vision model when the default model is not vision-capable. The design reuses existing message orchestration and API layers, adding only targeted type/config/client extensions plus unit coverage.

**Steps**
1. Define config and capability strategy in [src/utils/config.ts](src/utils/config.ts) and docs in [README.md](README.md) + [docs/API_INTEGRATION.md](docs/API_INTEGRATION.md): add vision model setting, attachment limits policy, and explicit mention+image trigger behavior.
2. Extend request/typing contracts for multimodal messages in [src/types.ts](src/types.ts) and API facade in [src/api/index.ts](src/api/index.ts): support optional image payloads while preserving current text-only callers.
3. Add Ollama multimodal + model capability handling in [src/api/ollamaClient.ts](src/api/ollamaClient.ts): implement model capability check, auto-switch to configured vision model, and chat payload with images array per message.
4. Add incoming attachment preprocessing in [src/bot/messageHandler.ts](src/bot/messageHandler.ts): on bot mention + image attachments, validate type/size, gather all images, invoke multimodal path, and inject combined image-to-text context into existing prompt flow.
5. Reuse existing download/size helpers from [src/utils/fileHandler.ts](src/utils/fileHandler.ts) where needed to normalize attachment intake and prevent oversized payloads.
6. Add/expand unit tests in [tests/messageHandler.test.ts](tests/messageHandler.test.ts), [tests/ollamaClient.test.ts](tests/ollamaClient.test.ts), and [tests/apiManager.test.ts](tests/apiManager.test.ts) for trigger gating, multi-image combine behavior, capability fallback to vision model, and error paths (missing content_type, invalid image, oversized image, Ollama failure).
7. Update architecture notes for the new preprocessing seam in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) so image-to-text is documented as input enrichment, not routing replacement.

**Verification**
- Run targeted tests first: npm test -- tests/ollamaClient.test.ts and npm test -- tests/messageHandler.test.ts
- Run API-layer regression: npm test -- tests/apiManager.test.ts
- Run full suite: npm test
- Build check: npm run build
- Manual check: send a bot-mention message with 2+ images and confirm combined textual analysis appears in bot reasoning/response path.

**Decisions**
- Primary path: Ollama multimodal direct image processing.
- Trigger: only when bot is mentioned and message contains image attachments.
- Multi-image handling: process all images and combine summaries.
- Fallback: auto-switch to configured vision model when active model lacks vision capability.
