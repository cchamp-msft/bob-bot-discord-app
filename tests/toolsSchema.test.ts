import { buildOllamaToolsSchema, resolveToolNameToKeyword } from '../src/utils/toolsSchema';
import type { KeywordConfig } from '../src/utils/config';

describe('toolsSchema', () => {
  const baseKeyword: KeywordConfig = {
    keyword: 'weather',
    api: 'accuweather',
    timeout: 60,
    description: 'Get weather',
  };

  describe('buildOllamaToolsSchema', () => {
    it('excludes internal-only keywords (help, activity_key)', () => {
      const keywords: KeywordConfig[] = [
        { ...baseKeyword, keyword: 'help', api: 'ollama', builtin: true },
        { ...baseKeyword, keyword: 'activity_key', api: 'ollama', builtin: true },
        { ...baseKeyword, keyword: 'weather' },
      ];
      const tools = buildOllamaToolsSchema(keywords);
      const names = tools.map((t) => t.function.name);
      expect(names).not.toContain('help');
      expect(names).not.toContain('activity_key');
      expect(names).toContain('weather');
    });

    it('excludes disabled, builtin, and ollama-api keywords', () => {
      const keywords: KeywordConfig[] = [
        { ...baseKeyword, enabled: false },
        { ...baseKeyword, keyword: 'chat', api: 'ollama' },
        { ...baseKeyword, keyword: 'generate', api: 'comfyui', builtin: true },
        { ...baseKeyword, keyword: 'search', api: 'serpapi' },
      ];
      const tools = buildOllamaToolsSchema(keywords);
      const names = tools.map((t) => t.function.name);
      expect(names).not.toContain('weather');
      expect(names).not.toContain('chat');
      expect(names).not.toContain('generate');
      expect(names).toContain('search');
    });

    it('builds tool with abilityText as description', () => {
      const keywords: KeywordConfig[] = [
        {
          ...baseKeyword,
          abilityText: 'Get weather for a location',
          abilityInputs: { mode: 'explicit', required: ['location'], validation: 'City or postal code' },
        },
      ];
      const tools = buildOllamaToolsSchema(keywords);
      expect(tools).toHaveLength(1);
      expect(tools[0].type).toBe('function');
      expect(tools[0].function.name).toBe('weather');
      expect(tools[0].function.description).toBe('Get weather for a location');
      expect(tools[0].function.parameters.type).toBe('object');
      expect(tools[0].function.parameters.required).toEqual(['location']);
      expect(tools[0].function.parameters.properties.location).toEqual({
        type: 'string',
        description: 'City or postal code',
      });
    });

    it('builds tool with optional params only in properties', () => {
      const keywords: KeywordConfig[] = [
        {
          ...baseKeyword,
          keyword: 'nfl scores',
          api: 'nfl',
          abilityInputs: {
            mode: 'mixed',
            optional: ['date'],
            validation: 'Date YYYYMMDD.',
            examples: ['nfl scores', 'nfl scores 20250101'],
          },
        },
      ];
      const tools = buildOllamaToolsSchema(keywords);
      expect(tools).toHaveLength(1);
      expect(tools[0].function.parameters.required).toBeUndefined();
      expect(tools[0].function.parameters.properties.date).toEqual({
        type: 'string',
        description: 'Date YYYYMMDD. Examples: nfl scores; nfl scores 20250101',
      });
    });

    it('builds single optional input for keyword without abilityInputs', () => {
      const keywords: KeywordConfig[] = [{ ...baseKeyword }];
      const tools = buildOllamaToolsSchema(keywords);
      expect(tools).toHaveLength(1);
      expect(tools[0].function.parameters.properties.input).toBeDefined();
      expect(tools[0].function.parameters.properties.input.type).toBe('string');
      expect(tools[0].function.parameters.required).toBeUndefined();
    });

    it('deduplicates by normalized keyword name', () => {
      const keywords: KeywordConfig[] = [
        { ...baseKeyword, keyword: 'weather' },
        { ...baseKeyword, keyword: '!weather' },
      ];
      const tools = buildOllamaToolsSchema(keywords);
      expect(tools).toHaveLength(1);
    });
  });

  describe('resolveToolNameToKeyword', () => {
    it('resolves tool name to keyword config', () => {
      const keywords: KeywordConfig[] = [
        { ...baseKeyword, keyword: 'weather' },
        { ...baseKeyword, keyword: 'search', api: 'serpapi' },
      ];
      const resolved = resolveToolNameToKeyword('weather', keywords);
      expect(resolved?.keyword).toBe('weather');
      expect(resolved?.api).toBe('accuweather');
    });

    it('returns undefined for internal-only keyword', () => {
      const keywords: KeywordConfig[] = [
        { ...baseKeyword, keyword: 'help', api: 'ollama', builtin: true },
      ];
      const resolved = resolveToolNameToKeyword('help', keywords);
      expect(resolved).toBeUndefined();
    });

    it('accepts tool name with or without prefix', () => {
      const keywords: KeywordConfig[] = [{ ...baseKeyword, keyword: '!weather' }];
      expect(resolveToolNameToKeyword('weather', keywords)?.keyword).toBe('!weather');
      expect(resolveToolNameToKeyword('!weather', keywords)?.keyword).toBe('!weather');
    });
  });
});
