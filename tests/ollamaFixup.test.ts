import type { ToolConfig } from '../src/utils/config';
import type { OllamaToolCall } from '../src/api/ollamaClient';

// ── Mocks ────────────────────────────────────────────────────

jest.mock('../src/utils/config', () => ({
  config: {
    getOllamaFixupEnabled: jest.fn(() => true),
    getOllamaFixupExtractXmlTools: jest.fn(() => true),
    getOllamaFixupExtractJsonTools: jest.fn(() => true),
    getOllamaFixupRepairUrls: jest.fn(() => true),
    getOllamaFixupStripToolPreamble: jest.fn(() => true),
    getOllamaFixupFixTables: jest.fn(() => true),
  },
}));

jest.mock('../src/utils/logger', () => ({
  logger: { log: jest.fn(), logError: jest.fn(), logWarn: jest.fn(), logDebug: jest.fn() },
}));

jest.mock('../src/utils/toolsSchema', () => ({
  resolveToolNameToTool: jest.fn((name: string, tools: ToolConfig[]) =>
    tools.find(t => t.name.replace(/^!/, '').toLowerCase() === name.toLowerCase())
  ),
}));

import { config } from '../src/utils/config';
import {
  extractXmlToolCalls,
  extractJsonToolCalls,
  repairUrls,
  stripToolPreamble,
  fixTables,
  applyFixups,
  type FixupContext,
} from '../src/utils/ollamaFixup';

// ── Helpers ──────────────────────────────────────────────────

const mockTools: ToolConfig[] = [
  { name: '!generate_image', api: 'comfyui', enabled: true } as ToolConfig,
  { name: '!get_weather', api: 'accuweather', enabled: true } as ToolConfig,
  { name: '!search', api: 'serpapi', enabled: true } as ToolConfig,
];

function makeCtx(text: string, toolCalls: OllamaToolCall[] = []): FixupContext {
  return { text, toolCalls: [...toolCalls], log: [] };
}

// ── extractXmlToolCalls ──────────────────────────────────────

describe('extractXmlToolCalls', () => {
  it('extracts <function_call> blocks', () => {
    const ctx = makeCtx(
      'Sure! <function_call>{"name":"generate_image","arguments":{"prompt":"a cat"}}</function_call>'
    );
    extractXmlToolCalls(ctx, mockTools);
    expect(ctx.toolCalls).toHaveLength(1);
    expect(ctx.toolCalls[0].function.name).toBe('generate_image');
    expect(ctx.toolCalls[0].function.arguments).toEqual({ prompt: 'a cat' });
    expect(ctx.text).toBe('Sure! ');
    expect(ctx.log).toHaveLength(1);
  });

  it('extracts <tool_call> blocks', () => {
    const ctx = makeCtx(
      '<tool_call>{"name":"get_weather","arguments":{"location":"Seattle"}}</tool_call>'
    );
    extractXmlToolCalls(ctx, mockTools);
    expect(ctx.toolCalls).toHaveLength(1);
    expect(ctx.toolCalls[0].function.name).toBe('get_weather');
  });

  it('extracts <tool_use> blocks', () => {
    const ctx = makeCtx(
      '<tool_use>{"name":"search","arguments":{"query":"test"}}</tool_use>'
    );
    extractXmlToolCalls(ctx, mockTools);
    expect(ctx.toolCalls).toHaveLength(1);
    expect(ctx.toolCalls[0].function.name).toBe('search');
  });

  it('skips when native tool_calls already present', () => {
    const existingTc: OllamaToolCall = {
      type: 'function',
      function: { name: 'generate_image', arguments: {} },
    };
    const ctx = makeCtx(
      '<function_call>{"name":"get_weather","arguments":{}}</function_call>',
      [existingTc]
    );
    extractXmlToolCalls(ctx, mockTools);
    expect(ctx.toolCalls).toHaveLength(1);
    expect(ctx.toolCalls[0].function.name).toBe('generate_image');
  });

  it('ignores unrecognized tool names', () => {
    const ctx = makeCtx(
      '<function_call>{"name":"unknown_tool","arguments":{}}</function_call>'
    );
    extractXmlToolCalls(ctx, mockTools);
    expect(ctx.toolCalls).toHaveLength(0);
  });

  it('ignores malformed JSON inside XML', () => {
    const ctx = makeCtx('<function_call>not json</function_call>');
    extractXmlToolCalls(ctx, mockTools);
    expect(ctx.toolCalls).toHaveLength(0);
  });

  it('extracts multiple XML tool calls', () => {
    const ctx = makeCtx(
      '<function_call>{"name":"generate_image","arguments":{"prompt":"cat"}}</function_call>\n' +
      '<function_call>{"name":"get_weather","arguments":{"location":"NYC"}}</function_call>'
    );
    extractXmlToolCalls(ctx, mockTools);
    expect(ctx.toolCalls).toHaveLength(2);
  });
});

// ── extractJsonToolCalls ─────────────────────────────────────

describe('extractJsonToolCalls', () => {
  it('extracts bare JSON tool objects', () => {
    const ctx = makeCtx(
      'Here is the result: {"name":"generate_image","arguments":{"prompt":"a dog"}}'
    );
    extractJsonToolCalls(ctx, mockTools);
    expect(ctx.toolCalls).toHaveLength(1);
    expect(ctx.toolCalls[0].function.name).toBe('generate_image');
    expect(ctx.toolCalls[0].function.arguments).toEqual({ prompt: 'a dog' });
  });

  it('skips when tool_calls already present', () => {
    const existingTc: OllamaToolCall = {
      type: 'function',
      function: { name: 'generate_image', arguments: {} },
    };
    const ctx = makeCtx(
      '{"name":"get_weather","arguments":{"location":"Seattle"}}',
      [existingTc]
    );
    extractJsonToolCalls(ctx, mockTools);
    expect(ctx.toolCalls).toHaveLength(1);
    expect(ctx.toolCalls[0].function.name).toBe('generate_image');
  });

  it('ignores unrecognized tool names', () => {
    const ctx = makeCtx('{"name":"bogus_tool","arguments":{"x":"y"}}');
    extractJsonToolCalls(ctx, mockTools);
    expect(ctx.toolCalls).toHaveLength(0);
  });
});

// ── repairUrls ───────────────────────────────────────────────

describe('repairUrls', () => {
  it('fixes double-wrapped markdown links', () => {
    const ctx = makeCtx('Check [[click here](https://example.com)](https://example.com)');
    repairUrls(ctx);
    expect(ctx.text).toBe('Check [click here](https://example.com)');
  });

  it('removes double brackets around URLs', () => {
    const ctx = makeCtx('Visit [[https://example.com]]');
    repairUrls(ctx);
    expect(ctx.text).toBe('Visit https://example.com');
  });

  it('unwraps backtick-wrapped URLs', () => {
    const ctx = makeCtx('See `https://example.com/path` for more');
    repairUrls(ctx);
    expect(ctx.text).toBe('See https://example.com/path for more');
  });

  it('adds https:// to www. URLs', () => {
    const ctx = makeCtx('Visit www.example.com for info');
    repairUrls(ctx);
    expect(ctx.text).toBe('Visit https://www.example.com for info');
  });

  it('does not double-prefix existing https://www URLs', () => {
    const ctx = makeCtx('Visit https://www.example.com');
    repairUrls(ctx);
    expect(ctx.text).toBe('Visit https://www.example.com');
  });

  it('logs when repairs are made', () => {
    const ctx = makeCtx('[[https://example.com]]');
    repairUrls(ctx);
    expect(ctx.log).toHaveLength(1);
  });

  it('does not log when no repairs needed', () => {
    const ctx = makeCtx('No URLs here');
    repairUrls(ctx);
    expect(ctx.log).toHaveLength(0);
  });
});

// ── stripToolPreamble ────────────────────────────────────────

describe('stripToolPreamble', () => {
  it('strips short preamble when tool calls exist', () => {
    const tc: OllamaToolCall = { type: 'function', function: { name: 'generate_image', arguments: {} } };
    const ctx = makeCtx("Sure, I'll generate that image for you!", [tc]);
    stripToolPreamble(ctx);
    expect(ctx.text).toBe('');
  });

  it('strips "Let me" preamble', () => {
    const tc: OllamaToolCall = { type: 'function', function: { name: 'get_weather', arguments: {} } };
    const ctx = makeCtx('Let me check the weather for you.', [tc]);
    stripToolPreamble(ctx);
    expect(ctx.text).toBe('');
  });

  it('does not strip when no tool calls', () => {
    const ctx = makeCtx("Sure, I'll help you with that!");
    stripToolPreamble(ctx);
    expect(ctx.text).toBe("Sure, I'll help you with that!");
  });

  it('does not strip long text (>200 chars)', () => {
    const tc: OllamaToolCall = { type: 'function', function: { name: 'get_weather', arguments: {} } };
    const longText = "Sure, I'll help! " + 'x'.repeat(200);
    const ctx = makeCtx(longText, [tc]);
    stripToolPreamble(ctx);
    expect(ctx.text).toBe(longText);
  });

  it('does not strip text without preamble phrases', () => {
    const tc: OllamaToolCall = { type: 'function', function: { name: 'get_weather', arguments: {} } };
    const ctx = makeCtx('Weather data follows.', [tc]);
    stripToolPreamble(ctx);
    expect(ctx.text).toBe('Weather data follows.');
  });
});

// ── fixTables ────────────────────────────────────────────────

describe('fixTables', () => {
  it('converts a markdown table to a monospace code block', () => {
    const md = [
      '| Name  | Age |',
      '| ----- | --- |',
      '| Alice | 30  |',
      '| Bob   | 25  |',
    ].join('\n');
    const ctx = makeCtx(md);
    fixTables(ctx);
    expect(ctx.text).toContain('```');
    expect(ctx.text).toContain('Alice');
    expect(ctx.text).toContain('Bob');
    // Should not contain pipe delimiters inside the code block
    const inner = ctx.text.split('```')[1];
    expect(inner).not.toContain('|');
    expect(ctx.log).toHaveLength(1);
  });

  it('preserves surrounding text when converting a table', () => {
    const md = [
      'Here are the results:',
      '',
      '| Name  | Age |',
      '| ----- | --- |',
      '| Alice | 30  |',
      '',
      'That is all.',
    ].join('\n');
    const ctx = makeCtx(md);
    fixTables(ctx);
    expect(ctx.text).toContain('Here are the results:');
    expect(ctx.text).toContain('That is all.');
    expect(ctx.text).toContain('```');
  });

  it('normalises an ASCII table already inside a code block', () => {
    const block = [
      '```',
      '| Name | Age |',
      '| --- | --- |',
      '| Alice | 30 |',
      '| Bob | 25 |',
      '```',
    ].join('\n');
    const ctx = makeCtx(block);
    fixTables(ctx);
    // Should still be in a code block, with aligned columns
    expect(ctx.text).toMatch(/^```\n/);
    expect(ctx.text).toMatch(/\n```$/);
    const inner = ctx.text.split('```')[1].trim();
    const lines = inner.split('\n');
    // All lines should have the same length (padded)
    expect(lines.length).toBe(3); // header + 2 data rows (separator stripped)
    expect(lines[0].length).toBe(lines[1].length);
  });

  it('does not modify text without tables', () => {
    const ctx = makeCtx('Just some normal text with no tables.');
    fixTables(ctx);
    expect(ctx.text).toBe('Just some normal text with no tables.');
    expect(ctx.log).toHaveLength(0);
  });

  it('handles a table with uneven column counts', () => {
    const md = [
      '| A | B | C |',
      '| - | - | - |',
      '| 1 | 2 |',
      '| 3 | 4 | 5 |',
    ].join('\n');
    const ctx = makeCtx(md);
    fixTables(ctx);
    expect(ctx.text).toContain('```');
    // Should not throw, and should pad missing columns
    const inner = ctx.text.split('```')[1].trim();
    const lines = inner.split('\n');
    expect(lines.length).toBe(3); // header + 2 data rows
  });
});

// ── applyFixups orchestrator ─────────────────────────────────

describe('applyFixups', () => {
  beforeEach(() => {
    (config.getOllamaFixupEnabled as jest.Mock).mockReturnValue(true);
    (config.getOllamaFixupExtractXmlTools as jest.Mock).mockReturnValue(true);
    (config.getOllamaFixupExtractJsonTools as jest.Mock).mockReturnValue(true);
    (config.getOllamaFixupRepairUrls as jest.Mock).mockReturnValue(true);
    (config.getOllamaFixupStripToolPreamble as jest.Mock).mockReturnValue(true);
    (config.getOllamaFixupFixTables as jest.Mock).mockReturnValue(true);
  });

  it('returns unmodified when fixup disabled', () => {
    (config.getOllamaFixupEnabled as jest.Mock).mockReturnValue(false);
    const result = applyFixups(
      '<function_call>{"name":"generate_image","arguments":{}}</function_call>',
      [],
      mockTools
    );
    expect(result.toolCalls).toHaveLength(0);
    expect(result.text).toContain('<function_call>');
  });

  it('runs XML extraction and preamble stripping together', () => {
    const result = applyFixups(
      "Sure! <function_call>{\"name\":\"generate_image\",\"arguments\":{\"prompt\":\"cat\"}}</function_call>",
      [],
      mockTools
    );
    expect(result.toolCalls).toHaveLength(1);
    expect(result.text).toBe('');
    expect(result.log.length).toBeGreaterThanOrEqual(2);
  });

  it('skips JSON extraction when XML already found tools', () => {
    const text =
      '<function_call>{"name":"generate_image","arguments":{}}</function_call> {"name":"get_weather","arguments":{"location":"x"}}';
    const result = applyFixups(text, [], mockTools);
    // XML extracted one, JSON should be skipped because toolCalls is non-empty
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].function.name).toBe('generate_image');
  });

  it('respects individual toggle: XML disabled (JSON also disabled)', () => {
    (config.getOllamaFixupExtractXmlTools as jest.Mock).mockReturnValue(false);
    (config.getOllamaFixupExtractJsonTools as jest.Mock).mockReturnValue(false);
    const result = applyFixups(
      '<function_call>{"name":"generate_image","arguments":{}}</function_call>',
      [],
      mockTools
    );
    expect(result.toolCalls).toHaveLength(0);
  });

  it('respects individual toggle: JSON disabled', () => {
    (config.getOllamaFixupExtractJsonTools as jest.Mock).mockReturnValue(false);
    const result = applyFixups(
      '{"name":"generate_image","arguments":{"prompt":"cat"}}',
      [],
      mockTools
    );
    expect(result.toolCalls).toHaveLength(0);
  });

  it('respects individual toggle: URL repair disabled', () => {
    (config.getOllamaFixupRepairUrls as jest.Mock).mockReturnValue(false);
    const result = applyFixups('[[https://example.com]]', [], mockTools);
    expect(result.text).toBe('[[https://example.com]]');
  });

  it('respects individual toggle: preamble strip disabled', () => {
    (config.getOllamaFixupStripToolPreamble as jest.Mock).mockReturnValue(false);
    const tc: OllamaToolCall = { type: 'function', function: { name: 'x', arguments: {} } };
    const result = applyFixups("Sure, I'll do it!", [tc], mockTools);
    expect(result.text).toBe("Sure, I'll do it!");
  });

  it('preserves existing native tool_calls', () => {
    const tc: OllamaToolCall = { type: 'function', function: { name: 'generate_image', arguments: { prompt: 'dog' } } };
    const result = applyFixups('Here is your image', [tc], mockTools);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toEqual(tc);
  });

  it('repairs URLs even when no tool calls present', () => {
    const result = applyFixups('Visit [[https://example.com]] today', [], mockTools);
    expect(result.text).toBe('Visit https://example.com today');
  });

  it('converts markdown tables when fixTables enabled', () => {
    const md = '| A | B |\n| - | - |\n| 1 | 2 |';
    const result = applyFixups(md, [], mockTools);
    expect(result.text).toContain('```');
    expect(result.text).not.toMatch(/\|.*\|/);
  });

  it('respects individual toggle: fixTables disabled', () => {
    (config.getOllamaFixupFixTables as jest.Mock).mockReturnValue(false);
    const md = '| A | B |\n| - | - |\n| 1 | 2 |';
    const result = applyFixups(md, [], mockTools);
    expect(result.text).toBe(md);
  });
});
