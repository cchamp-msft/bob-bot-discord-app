jest.mock('../src/utils/logger', () => ({
  logger: {
    log: jest.fn(),
    logError: jest.fn(),
    logWarn: jest.fn(),
    logDebug: jest.fn(),
    logDebugLazy: jest.fn(),
  },
}));

import { buildOllamaToolsSchema, resolveToolNameToTool, validateToolBatch } from '../src/utils/toolsSchema';
import type { ToolConfig } from '../src/utils/config';

describe('toolsSchema', () => {
  const baseTool: ToolConfig = {
    name: 'get_current_weather',
    api: 'accuweather',
    timeout: 60,
    description: 'Get weather',
  };

  describe('buildOllamaToolsSchema', () => {
    it('excludes internal-only tools (help, activity_key)', () => {
      const tools: ToolConfig[] = [
        { ...baseTool, name: 'help', api: 'ollama', builtin: true },
        { ...baseTool, name: 'activity_key', api: 'ollama', builtin: true },
        { ...baseTool, name: 'get_current_weather' },
      ];
      const schema = buildOllamaToolsSchema(tools);
      const names = schema.map((t) => t.function.name);
      expect(names).not.toContain('help');
      expect(names).not.toContain('activity_key');
      expect(names).toContain('get_current_weather');
    });

    it('excludes disabled, builtin, and ollama-api tools', () => {
      const tools: ToolConfig[] = [
        { ...baseTool, enabled: false },
        { ...baseTool, name: 'chat', api: 'ollama' },
        { ...baseTool, name: 'generate_image', api: 'comfyui', builtin: true },
        { ...baseTool, name: 'web_search', api: 'serpapi' },
      ];
      const schema = buildOllamaToolsSchema(tools);
      const names = schema.map((t) => t.function.name);
      expect(names).not.toContain('get_current_weather');
      expect(names).not.toContain('chat');
      expect(names).not.toContain('generate_image');
      expect(names).toContain('web_search');
    });

    it('builds tool with abilityText as description', () => {
      const tools: ToolConfig[] = [
        {
          ...baseTool,
          abilityText: 'Get weather for a location',
          abilityInputs: { mode: 'explicit', required: ['location'], validation: 'City or postal code' },
        },
      ];
      const schema = buildOllamaToolsSchema(tools);
      expect(schema).toHaveLength(1);
      expect(schema[0].type).toBe('function');
      expect(schema[0].function.name).toBe('get_current_weather');
      expect(schema[0].function.description).toBe('Get weather for a location');
      expect(schema[0].function.parameters.type).toBe('object');
      expect(schema[0].function.parameters.required).toEqual(['location']);
      expect(schema[0].function.parameters.properties.location).toEqual({
        type: 'string',
        description: 'City or postal code',
      });
    });

    it('builds tool with optional params only in properties', () => {
      const tools: ToolConfig[] = [
        {
          ...baseTool,
          name: 'get_recent_nfl_data',
          api: 'nfl',
          abilityInputs: {
            mode: 'mixed',
            optional: ['date'],
            validation: 'Date YYYYMMDD.',
            examples: ['get_recent_nfl_data scores', 'get_recent_nfl_data scores 20250101'],
          },
        },
      ];
      const schema = buildOllamaToolsSchema(tools);
      expect(schema).toHaveLength(1);
      expect(schema[0].function.parameters.required).toBeUndefined();
      expect(schema[0].function.parameters.properties.date).toEqual({
        type: 'string',
        description: 'Date YYYYMMDD. Examples: get_recent_nfl_data scores; get_recent_nfl_data scores 20250101',
      });
    });

    it('builds single optional input for tool without abilityInputs', () => {
      const tools: ToolConfig[] = [{ ...baseTool }];
      const schema = buildOllamaToolsSchema(tools);
      expect(schema).toHaveLength(1);
      expect(schema[0].function.parameters.properties.input).toBeDefined();
      expect(schema[0].function.parameters.properties.input.type).toBe('string');
      expect(schema[0].function.parameters.required).toBeUndefined();
    });

    it('deduplicates by normalized tool name', () => {
      const tools: ToolConfig[] = [
        { ...baseTool, name: 'get_current_weather' },
        { ...baseTool, name: '!get_current_weather' },
      ];
      const schema = buildOllamaToolsSchema(tools);
      expect(schema).toHaveLength(1);
    });
  });

  describe('resolveToolNameToTool', () => {
    it('resolves tool name to tool config', () => {
      const tools: ToolConfig[] = [
        { ...baseTool, name: 'get_current_weather' },
        { ...baseTool, name: 'web_search', api: 'serpapi' },
      ];
      const resolved = resolveToolNameToTool('get_current_weather', tools);
      expect(resolved?.name).toBe('get_current_weather');
      expect(resolved?.api).toBe('accuweather');
    });

    it('returns undefined for internal-only tool', () => {
      const tools: ToolConfig[] = [
        { ...baseTool, name: 'help', api: 'ollama', builtin: true },
      ];
      const resolved = resolveToolNameToTool('help', tools);
      expect(resolved).toBeUndefined();
    });

    it('accepts tool name with or without prefix', () => {
      const tools: ToolConfig[] = [{ ...baseTool, name: '!get_current_weather' }];
      expect(resolveToolNameToTool('get_current_weather', tools)?.name).toBe('!get_current_weather');
      expect(resolveToolNameToTool('!get_current_weather', tools)?.name).toBe('!get_current_weather');
    });
  });

  describe('provider-aware filtering', () => {
    it('excludes consult_grok when provider is xai', () => {
      const tools: ToolConfig[] = [
        { ...baseTool, name: 'consult_grok', api: 'xai' },
        { ...baseTool, name: 'web_search', api: 'serpapi' },
      ];
      const schema = buildOllamaToolsSchema(tools, 'xai');
      const names = schema.map(t => t.function.name);
      expect(names).not.toContain('consult_grok');
      expect(names).toContain('web_search');
    });

    it('includes consult_grok when provider is ollama', () => {
      const tools: ToolConfig[] = [
        { ...baseTool, name: 'consult_grok', api: 'xai' },
      ];
      const schema = buildOllamaToolsSchema(tools, 'ollama');
      expect(schema.map(t => t.function.name)).toContain('consult_grok');
    });

    it('excludes delegate_to_local when provider is ollama', () => {
      const tools: ToolConfig[] = [
        { ...baseTool, name: 'delegate_to_local', api: 'xai' },
      ];
      const schema = buildOllamaToolsSchema(tools, 'ollama');
      expect(schema).toHaveLength(0);
    });

    it('includes delegate_to_local when provider is xai', () => {
      const tools: ToolConfig[] = [
        { ...baseTool, name: 'delegate_to_local', api: 'xai' },
      ];
      const schema = buildOllamaToolsSchema(tools, 'xai');
      expect(schema.map(t => t.function.name)).toContain('delegate_to_local');
    });

    it('resolveToolNameToTool respects provider filtering', () => {
      const tools: ToolConfig[] = [
        { ...baseTool, name: 'consult_grok', api: 'xai' },
      ];
      expect(resolveToolNameToTool('consult_grok', tools, 'ollama')).toBeDefined();
      expect(resolveToolNameToTool('consult_grok', tools, 'xai')).toBeUndefined();
    });
  });

  describe('validateToolBatch', () => {
    const serpTool: ToolConfig = { ...baseTool, name: 'web_search', api: 'serpapi' };
    const xaiTool: ToolConfig = { ...baseTool, name: 'consult_grok', api: 'xai' };
    const imageTool: ToolConfig = { ...baseTool, name: 'generate_image', api: 'xai' };
    const weatherTool: ToolConfig = { ...baseTool, name: 'weather', api: 'accuweather' };

    it('allows serpapi from xai provider tool calls', () => {
      const { allowed, blocked } = validateToolBatch([serpTool, weatherTool], 'xai');
      expect(blocked).toHaveLength(0);
      expect(allowed).toHaveLength(2);
    });

    it('allows non-serpapi tools from xai provider', () => {
      const { allowed, blocked } = validateToolBatch([weatherTool], 'xai');
      expect(blocked).toHaveLength(0);
      expect(allowed).toHaveLength(1);
    });

    it('allows xai tools mixed with serpapi in ollama batch', () => {
      const { allowed, blocked } = validateToolBatch([serpTool, xaiTool, weatherTool], 'ollama');
      expect(blocked).toHaveLength(0);
      expect(allowed).toHaveLength(3);
    });

    it('allows image/video tools mixed with serpapi', () => {
      const { allowed, blocked } = validateToolBatch([serpTool, imageTool], 'ollama');
      expect(blocked).toHaveLength(0);
      expect(allowed).toHaveLength(2);
    });

    it('allows all tools regardless of combination', () => {
      const { allowed, blocked } = validateToolBatch([weatherTool, serpTool], 'ollama');
      expect(blocked).toHaveLength(0);
      expect(allowed).toHaveLength(2);
    });

    it('returns empty batch unchanged', () => {
      const { allowed, blocked } = validateToolBatch([], 'ollama');
      expect(allowed).toHaveLength(0);
      expect(blocked).toHaveLength(0);
    });
  });
});
