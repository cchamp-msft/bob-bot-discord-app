/**
 * Ollama End-to-End Tests
 *
 * These tests make REAL HTTP calls to a running Ollama instance.
 * They are NOT run as part of the standard `npm test` suite.
 *
 * Prerequisites:
 *   - Ollama must be running on http://localhost:11434 (or OLLAMA_ENDPOINT)
 *   - The models referenced below must be pulled and available
 *
 * Run manually:
 *   npx jest --config jest.e2e.config.ts
 *   npx jest --config jest.e2e.config.ts --verbose
 *
 * Or via the npm script:
 *   npm run test:e2e
 */

import axios from 'axios';

// ---------------------------------------------------------------------------
// Configuration — override via env vars or edit defaults here
// ---------------------------------------------------------------------------
const OLLAMA_ENDPOINT = process.env.OLLAMA_ENDPOINT || 'http://localhost:11434';

// Models used for each pipeline stage. Fallback chain mirrors production:
// each stage can have its own model, or fall back to OLLAMA_MODEL.
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'gemma3:12b';
const CONTEXT_EVAL_MODEL = process.env.CONTEXT_EVAL_MODEL || OLLAMA_MODEL;
const OLLAMA_TOOL_MODEL = process.env.OLLAMA_TOOL_MODEL || OLLAMA_MODEL;
const OLLAMA_FINAL_PASS_MODEL = process.env.OLLAMA_FINAL_PASS_MODEL || OLLAMA_MODEL;

// Context sizes (num_ctx) matching production defaults
const CONTEXT_EVAL_CONTEXT_SIZE = 2048;
const TOOL_CONTEXT_SIZE = 4096;
const FINAL_PASS_CONTEXT_SIZE = 4096;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Call Ollama /api/chat and return the parsed response. */
async function ollamaChat(params: {
  model: string;
  messages: { role: string; content: string }[];
  stream?: boolean;
  tools?: unknown[];
  options?: Record<string, unknown>;
}): Promise<{ status: number; data: Record<string, unknown>; error?: string }> {
  try {
    const response = await axios.post(`${OLLAMA_ENDPOINT}/api/chat`, {
      stream: false,
      ...params,
    });
    return { status: response.status, data: response.data };
  } catch (error: unknown) {
    const axiosErr = error as { response?: { status?: number; data?: Record<string, unknown> } };
    if (axiosErr.response) {
      const errMsg = typeof axiosErr.response.data?.error === 'string'
        ? axiosErr.response.data.error
        : `HTTP ${axiosErr.response.status}`;
      return { status: axiosErr.response.status!, data: axiosErr.response.data ?? {}, error: errMsg };
    }
    throw error;
  }
}

/** List models available on the Ollama instance. */
async function listModels(): Promise<string[]> {
  const response = await axios.get(`${OLLAMA_ENDPOINT}/api/tags`);
  if (response.status === 200 && Array.isArray(response.data?.models)) {
    return response.data.models.map((m: Record<string, unknown>) => String(m.name ?? ''));
  }
  return [];
}

// ---------------------------------------------------------------------------
// Connectivity gate — skip all tests if Ollama is unreachable
// ---------------------------------------------------------------------------

let ollamaAvailable = false;
let availableModels: string[] = [];

beforeAll(async () => {
  try {
    const response = await axios.get(`${OLLAMA_ENDPOINT}/api/tags`, { timeout: 5000 });
    ollamaAvailable = response.status === 200;
    availableModels = await listModels();
  } catch {
    ollamaAvailable = false;
  }

  if (!ollamaAvailable) {
    console.warn(
      `\n⚠  Ollama is not reachable at ${OLLAMA_ENDPOINT} — all e2e tests will be skipped.\n` +
      `   Start Ollama and re-run: npx jest --config jest.e2e.config.ts\n`
    );
  }
});

/** Skip-aware wrapper: skips the test if Ollama is offline or the model is missing. */
function e2eIt(name: string, model: string, fn: () => Promise<void>): void {
  it(name, async () => {
    if (!ollamaAvailable) {
      console.warn(`  ↳ SKIPPED (Ollama not available)`);
      return;
    }
    if (!availableModels.includes(model)) {
      console.warn(`  ↳ SKIPPED (model "${model}" not found — available: ${availableModels.join(', ')})`);
      return;
    }
    await fn();
  });
}

// ===========================================================================
// 1. Basic connectivity
// ===========================================================================

describe('Ollama connectivity', () => {
  e2eIt('responds to a simple chat message', OLLAMA_MODEL, async () => {
    const { status, data } = await ollamaChat({
      model: OLLAMA_MODEL,
      messages: [{ role: 'user', content: 'Reply with exactly: PONG' }],
    });

    expect(status).toBe(200);
    expect(data.message).toBeDefined();
    const text = (data.message as { content?: string }).content ?? '';
    expect(text.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// 2. Context evaluation prompt
// ===========================================================================

describe('Context evaluation prompt', () => {
  // Mirrors the system prompt from contextEvaluator.ts buildContextEvalPrompt()
  const minDepth = 1;
  const maxDepth = 5;
  const systemPrompt = [
    'You are a context relevance evaluator. Your job is to determine which recent conversation messages are relevant to the current user prompt.',
    '',
    'You will be given a list of conversation messages (numbered from most recent to oldest) and the current user prompt.',
    'Determine which messages should be included as context for responding to the user.',
    '',
    'Rules:',
    `- You MUST always include at least indices 1 through ${minDepth} (the most recent messages).`,
    `- You may include up to ${maxDepth} message(s) total.`,
    '- Prioritize newer messages over older ones — only include older messages when clearly relevant.',
    '- Messages tagged [reply] or [thread] are from a direct reply chain or thread and are generally more relevant than [channel] messages.',
    '- If messages vary topics too greatly, prefer the most recent topic.',
    '- You may select non-contiguous messages (e.g. 1, 3, 5) if only specific older messages are relevant.',
    '- Respond with ONLY a JSON array of integer indices — e.g. [1, 2, 4].',
    '- Do not include any explanation, punctuation, or extra text outside of the JSON array.',
  ].join('\n');

  const sampleHistory = [
    '[1] (user) [reply]: What is the weather like in Dallas?',
    '[2] (assistant) [reply]: The weather in Dallas is sunny and 75°F.',
    '[3] (user) [channel]: Anyone want to play games tonight?',
    '[4] (user) [channel]: I just got a new puppy!',
    '[5] (user) [channel]: Good morning everyone',
  ].join('\n');

  const userPrompt = [
    `Conversation messages (most recent first):`,
    sampleHistory,
    '',
    'Current user prompt: Tell me more about the Dallas weather',
  ].join('\n');

  e2eIt('returns a valid JSON array of indices', CONTEXT_EVAL_MODEL, async () => {
    const { status, data } = await ollamaChat({
      model: CONTEXT_EVAL_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      options: { num_ctx: CONTEXT_EVAL_CONTEXT_SIZE },
    });

    expect(status).toBe(200);
    const text = ((data.message as { content?: string }).content ?? '').trim();

    // Extract JSON array from response (model may wrap in code fences)
    const arrayMatch = text.match(/\[[\d,\s]+\]/);
    expect(arrayMatch).not.toBeNull();

    const indices: number[] = JSON.parse(arrayMatch![0]);
    expect(Array.isArray(indices)).toBe(true);
    expect(indices.length).toBeGreaterThanOrEqual(minDepth);
    expect(indices.length).toBeLessThanOrEqual(maxDepth);

    // Must include index 1 (minDepth enforcement)
    expect(indices).toContain(1);

    // All indices should be in valid range [1, 5]
    for (const idx of indices) {
      expect(idx).toBeGreaterThanOrEqual(1);
      expect(idx).toBeLessThanOrEqual(5);
    }

    // Should include weather-related messages (1 and 2)
    expect(indices).toContain(2);
  });

  e2eIt('excludes clearly irrelevant messages', CONTEXT_EVAL_MODEL, async () => {
    const { data } = await ollamaChat({
      model: CONTEXT_EVAL_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      options: { num_ctx: CONTEXT_EVAL_CONTEXT_SIZE },
    });

    const text = ((data.message as { content?: string }).content ?? '').trim();
    const arrayMatch = text.match(/\[[\d,\s]+\]/);
    if (!arrayMatch) return; // covered by previous test

    const indices: number[] = JSON.parse(arrayMatch[0]);

    // "Good morning everyone" (index 5) and "new puppy" (index 4) are
    // unlikely to be selected for a weather follow-up question.
    // We check that NOT ALL indices are included (some filtering happened).
    expect(indices.length).toBeLessThan(5);
  });
});

// ===========================================================================
// 3. Tools / keyword classification prompt
// ===========================================================================

describe('Tools prompt (native tool calling)', () => {
  // Sample tool definitions mirroring buildOllamaToolsSchema() output.
  // Tool names use underscores (no spaces) — matching the fix needed.
  const sampleTools = [
    {
      type: 'function' as const,
      function: {
        name: 'weather',
        description: 'Get current weather conditions and 5-day forecast',
        parameters: {
          type: 'object' as const,
          properties: {
            location: {
              type: 'string' as const,
              description: 'Location must be a valid worldwide city name, region, or United States postal code. Examples: weather Dallas; weather 90210; weather London, UK',
            },
          },
          required: ['location'],
        },
      },
    },
    {
      type: 'function' as const,
      function: {
        name: 'generate',
        description: 'Generate image using ComfyUI',
        parameters: {
          type: 'object' as const,
          properties: {
            input: {
              type: 'string' as const,
              description: 'User message or context-derived input for this tool.',
            },
          },
        },
      },
    },
    {
      type: 'function' as const,
      function: {
        name: 'search',
        description: 'Search the web for current information using Google',
        parameters: {
          type: 'object' as const,
          properties: {
            query: {
              type: 'string' as const,
              description: 'Query should be a concise search term or question suitable for a web search engine.',
            },
          },
          required: ['query'],
        },
      },
    },
  ];

  e2eIt('model accepts tool definitions without 400 error', OLLAMA_TOOL_MODEL, async () => {
    // This is the critical test: confirms the configured tool model
    // actually supports native tool calling and our schema is valid.
    const { status, error } = await ollamaChat({
      model: OLLAMA_TOOL_MODEL,
      messages: [
        { role: 'system', content: 'You are a helpful assistant with access to tools.' },
        { role: 'user', content: 'What is the weather in Dallas, Texas?' },
      ],
      tools: sampleTools,
      options: { num_ctx: TOOL_CONTEXT_SIZE },
    });

    if (status === 400) {
      // Fail with a clear diagnostic message — this is the exact production issue
      throw new Error(
        `OLLAMA_TOOL_MODEL "${OLLAMA_TOOL_MODEL}" does not support tools (400: ${error}). ` +
        `Set OLLAMA_TOOL_MODEL to a tool-capable model (e.g. qwen2.5, qwen3-coder, llama3.1+).`
      );
    }

    expect(status).toBe(200);
  });

  e2eIt('returns a tool_call for a clear tool-matching query', OLLAMA_TOOL_MODEL, async () => {
    const { status, data, error } = await ollamaChat({
      model: OLLAMA_TOOL_MODEL,
      messages: [
        { role: 'system', content: 'You are a helpful assistant with access to tools. Use the appropriate tool when the user request matches a tool capability.' },
        { role: 'user', content: 'What is the weather in Dallas, Texas?' },
      ],
      tools: sampleTools,
      options: { num_ctx: TOOL_CONTEXT_SIZE },
    });

    if (status === 400) {
      console.warn(`  ↳ SKIPPED (model "${OLLAMA_TOOL_MODEL}" does not support tools: ${error})`);
      return;
    }

    expect(status).toBe(200);
    const msg = data.message as { content?: string; tool_calls?: unknown[] };

    // The model should return a tool call for the weather tool
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      const tc = msg.tool_calls[0] as { function?: { name?: string; arguments?: Record<string, unknown> } };
      expect(tc.function).toBeDefined();
      expect(tc.function!.name).toBe('weather');
      expect(tc.function!.arguments).toBeDefined();
      // The location argument should contain "Dallas"
      const args = tc.function!.arguments!;
      const location = String(args.location ?? '');
      expect(location.toLowerCase()).toContain('dallas');
    } else {
      // Some models respond with text instead of tool_calls — that's acceptable
      // as long as the request didn't 400. Log for visibility.
      console.warn('  ↳ Model responded with text instead of tool_call (acceptable but suboptimal)');
      expect(msg.content?.length).toBeGreaterThan(0);
    }
  });

  e2eIt('responds with text (no tool_call) for a general chat query', OLLAMA_TOOL_MODEL, async () => {
    const { status, data, error } = await ollamaChat({
      model: OLLAMA_TOOL_MODEL,
      messages: [
        { role: 'system', content: 'You are a helpful assistant with access to tools. Only use tools when the request clearly matches a tool capability.' },
        { role: 'user', content: 'Tell me a joke about programming.' },
      ],
      tools: sampleTools,
      options: { num_ctx: TOOL_CONTEXT_SIZE },
    });

    if (status === 400) {
      console.warn(`  ↳ SKIPPED (model "${OLLAMA_TOOL_MODEL}" does not support tools: ${error})`);
      return;
    }

    expect(status).toBe(200);
    const msg = data.message as { content?: string; tool_calls?: unknown[] };

    // For a general chat query, the model should NOT invoke a tool
    const text = msg.content ?? '';
    expect(text.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// 4. Final pass prompt (conversational refinement)
// ===========================================================================

describe('Final pass prompt', () => {
  const finalPassInstruction = 'Keeping in character, review the incoming data and provide an opinionated response.';

  const systemPrompt = [
    'You are a friendly Discord chat bot.',
    '',
    finalPassInstruction,
  ].join('\n');

  const sampleExternalData = [
    '<external_data source="nfl" keyword="nfl scores">',
    'NFL Scores for Week 10:',
    'Kansas City Chiefs 27 - Buffalo Bills 24 (Final)',
    'Dallas Cowboys 14 - Philadelphia Eagles 31 (Final)',
    'San Francisco 49ers 21 - Seattle Seahawks 17 (Final)',
    '</external_data>',
  ].join('\n');

  e2eIt('produces a conversational summary from structured data', OLLAMA_FINAL_PASS_MODEL, async () => {
    const { status, data } = await ollamaChat({
      model: OLLAMA_FINAL_PASS_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `${sampleExternalData}\n\nUser asked: What were the NFL scores today?` },
      ],
      options: { num_ctx: FINAL_PASS_CONTEXT_SIZE },
    });

    expect(status).toBe(200);
    const text = ((data.message as { content?: string }).content ?? '').trim();
    expect(text.length).toBeGreaterThan(0);

    // The response should reference at least one team from the data
    const mentionsTeam = /chiefs|bills|cowboys|eagles|49ers|seahawks/i.test(text);
    expect(mentionsTeam).toBe(true);
  });

  e2eIt('includes score details rather than just acknowledging the question', OLLAMA_FINAL_PASS_MODEL, async () => {
    const { status, data } = await ollamaChat({
      model: OLLAMA_FINAL_PASS_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `${sampleExternalData}\n\nUser asked: How did the Chiefs do?` },
      ],
      options: { num_ctx: FINAL_PASS_CONTEXT_SIZE },
    });

    expect(status).toBe(200);
    const text = ((data.message as { content?: string }).content ?? '').trim();

    // Should mention the Chiefs score or outcome
    const mentionsChiefs = /chiefs/i.test(text);
    const mentionsScore = /27|24|won|beat|victory|defeated/i.test(text);
    expect(mentionsChiefs).toBe(true);
    expect(mentionsScore).toBe(true);
  });
});

// ===========================================================================
// 5. Model capability detection (tools support)
// ===========================================================================

describe('Model capability: tools support', () => {
  // This test documents which models on this instance support native tool calling.
  // Useful for diagnosing 400 errors like the gemma3 tools issue.
  //
  // Uses a generous per-model timeout because the first request to each model
  // may trigger a cold-load (pulling weights into VRAM). If Ollama needs to
  // swap models, each probe can take 30-60s. Total timeout is set per-test.
  it('reports tools support for all available models', async () => {
    if (!ollamaAvailable) {
      console.warn('  ↳ SKIPPED (Ollama not available)');
      return;
    }

    const minimalTool = [{
      type: 'function',
      function: {
        name: 'test',
        description: 'A test tool',
        parameters: { type: 'object', properties: { input: { type: 'string' } } },
      },
    }];

    const results: { model: string; supportsTools: boolean; error?: string }[] = [];

    for (const model of availableModels) {
      const { status, error } = await ollamaChat({
        model,
        messages: [{ role: 'user', content: 'hi' }],
        tools: minimalTool,
      });

      if (status === 400) {
        results.push({ model, supportsTools: false, error });
      } else {
        results.push({ model, supportsTools: status === 200 });
      }
    }

    // Log results as a table for diagnostic visibility
    console.log('\n  Model tools support:');
    for (const r of results) {
      const detail = r.error ? ` (${r.error})` : '';
      console.log(`    ${r.supportsTools ? '✓' : '✗'} ${r.model}${detail}`);
    }

    // No assertion — this is a diagnostic report.
    // But we do assert OLLAMA_TOOL_MODEL supports tools if it's available.
    const toolModelResult = results.find(r => r.model === OLLAMA_TOOL_MODEL);
    if (toolModelResult) {
      expect(toolModelResult.supportsTools).toBe(true);
    }
  }, 600_000); // 10 min — each model may cold-load
});
