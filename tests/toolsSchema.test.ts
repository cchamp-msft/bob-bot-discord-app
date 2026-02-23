import { buildOllamaToolsSchema, resolveToolNameToTool } from '../src/utils/toolsSchema';
import type { ToolConfig } from '../src/utils/config';

describe('toolsSchema', () => {
  const baseTool: ToolConfig = {
    name: 'weather',
    api: 'accuweather',
    timeout: 60,
    description: 'Get weather',
  };

  describe('buildOllamaToolsSchema', () => {
    it('excludes internal-only tools (help, activity_key)', () => {
      const tools: ToolConfig[] = [
        { ...baseTool, name: 'help', api: 'ollama', builtin: true },
        { ...baseTool, name: 'activity_key', api: 'ollama', builtin: true },
        { ...baseTool, name: 'weather' },
      ];
      const schema = buildOllamaToolsSchema(tools);
      const names = schema.map((t) => t.function.name);
      expect(names).not.toContain('help');
      expect(names).not.toContain('activity_key');
      expect(names).toContain('weather');
    });

    it('excludes disabled, builtin, and ollama-api tools', () => {
      const tools: ToolConfig[] = [
        { ...baseTool, enabled: false },
        { ...baseTool, name: 'chat', api: 'ollama' },
        { ...baseTool, name: 'generate', api: 'comfyui', builtin: true },
        { ...baseTool, name: 'web_search', api: 'serpapi' },
      ];
      const schema = buildOllamaToolsSchema(tools);
      const names = schema.map((t) => t.function.name);
      expect(names).not.toContain('weather');
      expect(names).not.toContain('chat');
      expect(names).not.toContain('generate');
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
      expect(schema[0].function.name).toBe('weather');
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
        { ...baseTool, name: 'weather' },
        { ...baseTool, name: '!weather' },
      ];
      const schema = buildOllamaToolsSchema(tools);
      expect(schema).toHaveLength(1);
    });
  });

  describe('resolveToolNameToTool', () => {
    it('resolves tool name to tool config', () => {
      const tools: ToolConfig[] = [
        { ...baseTool, name: 'weather' },
        { ...baseTool, name: 'web_search', api: 'serpapi' },
      ];
      const resolved = resolveToolNameToTool('weather', tools);
      expect(resolved?.name).toBe('weather');
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
      const tools: ToolConfig[] = [{ ...baseTool, name: '!weather' }];
      expect(resolveToolNameToTool('weather', tools)?.name).toBe('!weather');
      expect(resolveToolNameToTool('!weather', tools)?.name).toBe('!weather');
    });
  });
});
