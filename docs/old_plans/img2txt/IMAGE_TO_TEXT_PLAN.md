### Plan for Image-to-Text Conversion Feature Using Ollama Model

Based on my exploration of the Bob Bot Discord app codebase and research into Discord and Ollama APIs, here's a comprehensive plan to add image-to-text conversion functionality. This feature will allow users to send images in Discord messages, and the bot will process them using Ollama's LLaVA vision model to generate descriptive text responses.

#### Feature Overview
- **Trigger**: Automatically detect Discord messages containing image attachments (e.g., PNG, JPEG, GIF).
- **Processing**: Download image data, send to Ollama's LLaVA model for analysis, and generate a text description.
- **Response**: Reply in Discord with the generated text description.
- **Integration**: Extend the existing message handler in `src/bot/messageHandler.ts` to add this as a new processing path, parallel to keyword detection and API routing.
- **Fallbacks**: Handle errors gracefully (e.g., invalid images, Ollama failures) with user-friendly messages.

#### Prerequisites
1. **Ollama Setup**: Ensure Ollama is installed and running locally. Pull the LLaVA model:
   ```
   ollama pull llava
   ```
   - LLaVA supports image inputs via base64 encoding and generates text descriptions (e.g., "What's in this image?").
   - API endpoint: `http://localhost:11434/api/generate` (default Ollama port).

2. **Bot Configuration**:
   - Add new config options in `src/utils/config.ts` for image processing (e.g., max image size, enabled/disabled toggle).
   - Ensure the bot has permissions to read message attachments (already handled via Discord intents).

3. **Dependencies**:
   - Use existing `axios` (already in codebase) for HTTP requests to Ollama.
   - Add `node-fetch` or rely on built-in fetch if Node.js version supports it for image downloads.

4. **Security/Performance**:
   - Validate image types (allow only common formats: PNG, JPEG, GIF, WebP).
   - Limit image size (e.g., 5MB max) to prevent abuse.
   - Queue requests to avoid overwhelming Ollama (use existing `requestQueue` in codebase).

#### Implementation Steps
1. **Update Message Handler** (`src/bot/messageHandler.ts`):
   - After initial message validation (e.g., ignoring bot messages, checking DMs), add a check for attachments.
   - If attachments exist and are images, branch to image processing instead of keyword detection.
   - Add a new function `processImageMessage` that:
     - Downloads image data from Discord attachment URLs.
     - Encodes to base64.
     - Sends to Ollama API.

2. **Add Image Download Utility** (`src/utils/imageUtils.ts` - new file):
   - Function to fetch image from URL (use axios).
   - Validate MIME type and size.
   - Convert to base64 for Ollama API.

3. **Integrate Ollama API Call** (extend `src/api/ollamaManager.ts` - assuming it exists based on codebase):
   - Add a method `generateImageDescription(base64Image: string): Promise<string>`.
   - Use `/api/generate` endpoint with `model: "llava"`, `prompt: "Describe this image in detail."`, and `images: [base64Image]`.
   - Parse response for generated text (handle streaming if needed).

4. **Error Handling and Logging**:
   - Log image processing attempts and failures.
   - Reply with error messages (e.g., "Sorry, I couldn't process that image. Try a smaller file.").
   - Use existing logger from `src/utils/logger.ts`.

5. **Configuration and Keywords**:
   - Optionally add a keyword like "!describe" to trigger manual processing, but prioritize automatic detection for UX.
   - Allow users to disable via config.

6. **Testing**:
   - Unit tests: Mock Discord messages with attachments, test image validation and Ollama calls.
   - Integration tests: Send real images in a test Discord channel, verify responses.
   - Edge cases: Multiple images, unsupported formats, large files, Ollama downtime.

#### Discord API Details
- **Message Object**: Messages with images have an `attachments` array. Each attachment includes `url`, `content_type` (e.g., "image/png"), and `size`.
- **Accessing Attachments**: In `messageHandler.ts`, check `message.attachments` for images. Download via the `url` field (requires bot token for auth if needed, but public URLs are accessible).
- **Permissions**: Ensure the bot has `ATTACH_FILES` permission, but since we're reading attachments, no additional perms needed beyond existing message read.

#### Ollama API Details
- **Endpoint**: `POST http://localhost:11434/api/generate`
- **Request Body**:
  ```json
  {
    "model": "llava",
    "prompt": "Describe this image in detail.",
    "images": ["base64_encoded_image_data"],
    "stream": false
  }
  ```
- **Response**: JSON with `response` field containing the generated text.
- **Limitations**: LLaVA models (7b, 13b, 34b) have context windows up to 32K for 7b/13b. Images are processed as base64, so ensure efficient encoding.

#### Potential Challenges and Mitigations
- **Image Size**: Discord attachments can be large; implement size checks to avoid memory issues.
- **Rate Limiting**: Ollama may be slow for large images; use the existing request queue.
- **Multi-Image Messages**: Process only the first image or allow up to N images.
- **Privacy**: Warn users that images are sent to Ollama (local processing).
- **Model Selection**: Default to `llava:7b` for speed; allow config override.

#### Timeline and Scope
- **Phase 1**: Basic implementation (download + Ollama call) - 2-3 days.
- **Phase 2**: Error handling, config, and testing - 1-2 days.
- **Phase 3**: Integration into message flow and deployment - 1 day.

This plan leverages existing bot architecture for seamless integration.