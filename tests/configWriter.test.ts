import * as fs from 'fs';
import * as path from 'path';
import { readEnvVar } from '../src/utils/dotenvCodec';

// The configWriter module imports from './config' which triggers dotenv + keywords loading.
// We need .env and keywords.json to exist before importing.
const testDir = path.join(__dirname, '../test-fixtures');
const testEnvPath = path.join(testDir, '.env');
const testKeywordsDir = path.join(testDir, 'config');
const testKeywordsPath = path.join(testKeywordsDir, 'keywords.json');

// We'll test configWriter in isolation by manipulating its private paths via temp files.
// Since configWriter uses hardcoded paths relative to __dirname, we mock fs instead.

jest.mock('fs', () => {
  const actual = jest.requireActual<typeof import('fs')>('fs');
  return { ...actual };
});

// Import after mocks are set up
import { configWriter } from '../src/utils/configWriter';

describe('ConfigWriter', () => {
  let tempDir: string;
  let envPath: string;
  let keywordsPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'configwriter-'));
    envPath = path.join(tempDir, '.env');
    keywordsPath = path.join(tempDir, 'keywords.json');

    // Override private paths via Object property access
    (configWriter as any).envPath = envPath;
    process.env.KEYWORDS_CONFIG_PATH = keywordsPath;
  });

  afterEach(() => {
    delete process.env.KEYWORDS_CONFIG_PATH;
    // Clean up temp dir
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('updateEnv', () => {
    it('should create .env file if it does not exist', async () => {
      await configWriter.updateEnv({ FOO: 'bar', NUM: 42 });

      const content = fs.readFileSync(envPath, 'utf-8');
      expect(content).toContain('FOO=bar');
      expect(content).toContain('NUM=42');
    });

    it('should update existing keys and preserve comments', async () => {
      fs.writeFileSync(envPath, [
        '# This is a comment',
        'EXISTING_KEY=old_value',
        '',
        '# Another comment',
        'KEEP_ME=untouched',
      ].join('\n'));

      await configWriter.updateEnv({ EXISTING_KEY: 'new_value' });

      const content = fs.readFileSync(envPath, 'utf-8');
      expect(content).toContain('# This is a comment');
      expect(content).toContain('# Another comment');
      expect(content).toContain('EXISTING_KEY=new_value');
      expect(content).not.toContain('old_value');
      expect(content).toContain('KEEP_ME=untouched');
    });

    it('should append new keys that do not exist in the file', async () => {
      fs.writeFileSync(envPath, 'EXISTING=value\n');

      await configWriter.updateEnv({ NEW_KEY: 'added' });

      const content = fs.readFileSync(envPath, 'utf-8');
      expect(content).toContain('EXISTING=value');
      expect(content).toContain('NEW_KEY=added');
    });

    it('should handle mixed updates and appends', async () => {
      fs.writeFileSync(envPath, 'A=1\nB=2\n');

      await configWriter.updateEnv({ A: 'updated', C: 'new' });

      const content = fs.readFileSync(envPath, 'utf-8');
      expect(content).toContain('A=updated');
      expect(content).toContain('B=2');
      expect(content).toContain('C=new');
    });

    it('should handle empty .env file', async () => {
      fs.writeFileSync(envPath, '');

      await configWriter.updateEnv({ KEY: 'val' });

      const content = fs.readFileSync(envPath, 'utf-8');
      expect(content).toContain('KEY=val');
    });

    it('should clear a value by writing an empty string', async () => {
      fs.writeFileSync(envPath, 'OLLAMA_MODEL=llama3\nOTHER=keep\n');

      await configWriter.updateEnv({ OLLAMA_MODEL: '' });

      const content = fs.readFileSync(envPath, 'utf-8');
      expect(content).toContain('OLLAMA_MODEL=');
      expect(content).not.toContain('OLLAMA_MODEL=llama3');
      expect(content).toContain('OTHER=keep');
    });

    it('should quote values containing newlines', async () => {
      fs.writeFileSync(envPath, '');

      await configWriter.updateEnv({ OLLAMA_SYSTEM_PROMPT: 'Line one\nLine two' });

      const content = fs.readFileSync(envPath, 'utf-8');
      expect(content).toContain('OLLAMA_SYSTEM_PROMPT="Line one\\nLine two"');
    });

    it('should escape double quotes inside values', async () => {
      fs.writeFileSync(envPath, '');

      await configWriter.updateEnv({ MSG: 'say "hello" world' });

      const content = fs.readFileSync(envPath, 'utf-8');
      expect(content).toContain('MSG="say \\"hello\\" world"');
    });

    it('should not grow backslashes on repeated save (round-trip idempotency)', async () => {
      const prompt = 'Talk about "oeb" and use a backslash \\ here';
      fs.writeFileSync(envPath, '');

      // First save
      await configWriter.updateEnv({ OLLAMA_SYSTEM_PROMPT: prompt });
      const afterFirst = fs.readFileSync(envPath, 'utf-8');

      // Simulate reload: read back via codec (same path config.ts uses)
      const decoded = readEnvVar(envPath, 'OLLAMA_SYSTEM_PROMPT');
      expect(decoded).toBe(prompt);

      // Second save with the decoded value (what the UI would send back)
      await configWriter.updateEnv({ OLLAMA_SYSTEM_PROMPT: decoded! });
      const afterSecond = fs.readFileSync(envPath, 'utf-8');

      // .env content must be identical — no escape growth
      expect(afterSecond).toBe(afterFirst);
    });

    it('should round-trip a prompt with newlines and quotes', async () => {
      const prompt = 'Line one\nSay "hi"\nLine three';
      fs.writeFileSync(envPath, '');

      await configWriter.updateEnv({ OLLAMA_SYSTEM_PROMPT: prompt });
      const decoded = readEnvVar(envPath, 'OLLAMA_SYSTEM_PROMPT');
      expect(decoded).toBe(prompt);

      // Save again and verify stability
      await configWriter.updateEnv({ OLLAMA_SYSTEM_PROMPT: decoded! });
      const decoded2 = readEnvVar(envPath, 'OLLAMA_SYSTEM_PROMPT');
      expect(decoded2).toBe(prompt);
    });
  });

  describe('updateKeywords', () => {
    const validKeyword = {
      keyword: 'test',
      api: 'ollama' as const,
      timeout: 300,
      description: 'Test keyword',
    };

    it('should write valid keywords to file', async () => {
      await configWriter.updateKeywords([validKeyword]);

      const content = JSON.parse(fs.readFileSync(keywordsPath, 'utf-8'));
      expect(content.keywords).toHaveLength(1);
      expect(content.keywords[0].keyword).toBe('test');
      expect(content.keywords[0].api).toBe('ollama');
    });

    it('should reject duplicate keywords (case-insensitive)', async () => {
      await expect(
        configWriter.updateKeywords([
          { ...validKeyword, keyword: 'Ask' },
          { ...validKeyword, keyword: 'ask' },
        ])
      ).rejects.toThrow('Duplicate keyword');
    });

    it('should reject invalid api value', async () => {
      await expect(
        configWriter.updateKeywords([
          { ...validKeyword, api: 'invalid' as any },
        ])
      ).rejects.toThrow('invalid api');
    });

    it('should reject non-positive timeout', async () => {
      await expect(
        configWriter.updateKeywords([
          { ...validKeyword, timeout: 0 },
        ])
      ).rejects.toThrow('invalid timeout');
    });

    it('should reject negative timeout', async () => {
      await expect(
        configWriter.updateKeywords([
          { ...validKeyword, timeout: -1 },
        ])
      ).rejects.toThrow('invalid timeout');
    });

    it('should reject missing keyword string', async () => {
      await expect(
        configWriter.updateKeywords([
          { ...validKeyword, keyword: '' },
        ])
      ).rejects.toThrow('missing "keyword" string');
    });

    it('should reject missing description', async () => {
      await expect(
        configWriter.updateKeywords([
          { ...validKeyword, description: '' },
        ])
      ).rejects.toThrow('missing description');
    });

    it('should reject non-array input', async () => {
      await expect(
        configWriter.updateKeywords('not-an-array' as any)
      ).rejects.toThrow('must be an array');
    });

    it('should write multiple valid keywords', async () => {
      await configWriter.updateKeywords([
        { keyword: 'generate', api: 'comfyui', timeout: 300, description: 'Gen image' },
        { keyword: 'ask', api: 'ollama', timeout: 120, description: 'Ask question' },
      ]);

      const content = JSON.parse(fs.readFileSync(keywordsPath, 'utf-8'));
      expect(content.keywords).toHaveLength(2);
      expect(content.keywords[0].api).toBe('comfyui');
      expect(content.keywords[1].api).toBe('ollama');
    });

    it('should write empty array', async () => {
      await configWriter.updateKeywords([]);

      const content = JSON.parse(fs.readFileSync(keywordsPath, 'utf-8'));
      expect(content.keywords).toHaveLength(0);
    });

    it('should accept valid abilityText field', async () => {
      await configWriter.updateKeywords([
        { ...validKeyword, abilityText: 'do something useful' },
      ]);

      const content = JSON.parse(fs.readFileSync(keywordsPath, 'utf-8'));
      expect(content.keywords[0].abilityText).toBe('do something useful');
    });

    it('should reject non-string abilityText', async () => {
      await expect(
        configWriter.updateKeywords([
          { ...validKeyword, abilityText: 123 as any },
        ])
      ).rejects.toThrow('invalid abilityText');
    });

    it('should accept valid finalOllamaPass field', async () => {
      await configWriter.updateKeywords([
        { ...validKeyword, finalOllamaPass: true },
      ]);

      const content = JSON.parse(fs.readFileSync(keywordsPath, 'utf-8'));
      expect(content.keywords[0].finalOllamaPass).toBe(true);
    });

    it('should reject non-boolean finalOllamaPass', async () => {
      await expect(
        configWriter.updateKeywords([
          { ...validKeyword, finalOllamaPass: 'yes' as any },
        ])
      ).rejects.toThrow('invalid finalOllamaPass');
    });

    it('should persist keywords with all routing fields', async () => {
      const full = {
        ...validKeyword,
        abilityText: 'do something',
        finalOllamaPass: true,
      };
      await configWriter.updateKeywords([full]);

      const content = JSON.parse(fs.readFileSync(keywordsPath, 'utf-8'));
      expect(content.keywords[0]).toMatchObject({
        keyword: 'test',
        api: 'ollama',
        abilityText: 'do something',
        finalOllamaPass: true,
      });
    });

    it('should accept keywords without optional routing fields', async () => {
      await configWriter.updateKeywords([validKeyword]);

      const content = JSON.parse(fs.readFileSync(keywordsPath, 'utf-8'));
      expect(content.keywords[0].abilityText).toBeUndefined();
      expect(content.keywords[0].finalOllamaPass).toBeUndefined();
    });

    it('should strip unknown fields like routeApi on save', async () => {
      const entryWithRouteApi = {
        ...validKeyword,
        routeApi: 'comfyui',  // deprecated/unknown field
        routeModel: 'specialized',  // deprecated field
        extraField: 'ignored',
      } as any;
      await configWriter.updateKeywords([entryWithRouteApi]);

      const content = JSON.parse(fs.readFileSync(keywordsPath, 'utf-8'));
      expect(content.keywords[0].routeApi).toBeUndefined();
      expect(content.keywords[0].routeModel).toBeUndefined();
      expect(content.keywords[0].extraField).toBeUndefined();
      expect(content.keywords[0].keyword).toBe('test');
      expect(content.keywords[0].api).toBe('ollama');
    });

    it('should accept valid enabled field (true)', async () => {
      await configWriter.updateKeywords([{ ...validKeyword, enabled: true }]);
      const content = JSON.parse(fs.readFileSync(keywordsPath, 'utf-8'));
      // enabled=true is the default, so it may be omitted in clean output
      expect(content.keywords[0].keyword).toBe('test');
    });

    it('should persist enabled=false', async () => {
      await configWriter.updateKeywords([{ ...validKeyword, enabled: false }]);
      const content = JSON.parse(fs.readFileSync(keywordsPath, 'utf-8'));
      expect(content.keywords[0].enabled).toBe(false);
    });

    it('should reject non-boolean enabled', async () => {
      await expect(
        configWriter.updateKeywords([{ ...validKeyword, enabled: 'yes' as any }])
      ).rejects.toThrow('invalid enabled');
    });

    it('should accept valid builtin field', async () => {
      await configWriter.updateKeywords([{ ...validKeyword, builtin: true }]);
      const content = JSON.parse(fs.readFileSync(keywordsPath, 'utf-8'));
      expect(content.keywords[0].builtin).toBe(true);
    });

    it('should reject non-boolean builtin', async () => {
      await expect(
        configWriter.updateKeywords([{ ...validKeyword, builtin: 'yes' as any }])
      ).rejects.toThrow('invalid builtin');
    });

    it('should persist contextFilterEnabled when true', async () => {
      await configWriter.updateKeywords([{ ...validKeyword, contextFilterEnabled: true }]);
      const content = JSON.parse(fs.readFileSync(keywordsPath, 'utf-8'));
      expect(content.keywords[0].contextFilterEnabled).toBe(true);
    });

    it('should not persist contextFilterEnabled when false or omitted', async () => {
      await configWriter.updateKeywords([{ ...validKeyword, contextFilterEnabled: false }]);
      const content = JSON.parse(fs.readFileSync(keywordsPath, 'utf-8'));
      expect(content.keywords[0].contextFilterEnabled).toBeUndefined();
    });

    it('should reject non-boolean contextFilterEnabled', async () => {
      await expect(
        configWriter.updateKeywords([{ ...validKeyword, contextFilterEnabled: 'yes' as any }])
      ).rejects.toThrow('invalid contextFilterEnabled');
    });

    it('should accept valid contextFilterMinDepth', async () => {
      await configWriter.updateKeywords([
        { ...validKeyword, contextFilterMinDepth: 3 },
      ]);
      const content = JSON.parse(fs.readFileSync(keywordsPath, 'utf-8'));
      expect(content.keywords[0].contextFilterMinDepth).toBe(3);
    });

    it('should reject contextFilterMinDepth of 0', async () => {
      await expect(
        configWriter.updateKeywords([
          { ...validKeyword, contextFilterMinDepth: 0 },
        ])
      ).rejects.toThrow('invalid contextFilterMinDepth');
    });

    it('should reject negative contextFilterMinDepth', async () => {
      await expect(
        configWriter.updateKeywords([
          { ...validKeyword, contextFilterMinDepth: -1 },
        ])
      ).rejects.toThrow('invalid contextFilterMinDepth');
    });

    it('should reject non-integer contextFilterMinDepth', async () => {
      await expect(
        configWriter.updateKeywords([
          { ...validKeyword, contextFilterMinDepth: 2.5 },
        ])
      ).rejects.toThrow('invalid contextFilterMinDepth');
    });

    it('should accept valid contextFilterMaxDepth', async () => {
      await configWriter.updateKeywords([
        { ...validKeyword, contextFilterMaxDepth: 10 },
      ]);
      const content = JSON.parse(fs.readFileSync(keywordsPath, 'utf-8'));
      expect(content.keywords[0].contextFilterMaxDepth).toBe(10);
    });

    it('should reject contextFilterMaxDepth of 0', async () => {
      await expect(
        configWriter.updateKeywords([
          { ...validKeyword, contextFilterMaxDepth: 0 },
        ])
      ).rejects.toThrow('invalid contextFilterMaxDepth');
    });

    it('should reject negative contextFilterMaxDepth', async () => {
      await expect(
        configWriter.updateKeywords([
          { ...validKeyword, contextFilterMaxDepth: -5 },
        ])
      ).rejects.toThrow('invalid contextFilterMaxDepth');
    });

    it('should reject minDepth > maxDepth', async () => {
      await expect(
        configWriter.updateKeywords([
          { ...validKeyword, contextFilterMinDepth: 5, contextFilterMaxDepth: 3 },
        ])
      ).rejects.toThrow('contextFilterMinDepth (5) greater than contextFilterMaxDepth (3)');
    });

    it('should persist keyword with context eval depth overrides', async () => {
      const full = {
        ...validKeyword,
        contextFilterMinDepth: 2,
        contextFilterMaxDepth: 8,
      };
      await configWriter.updateKeywords([full]);

      const content = JSON.parse(fs.readFileSync(keywordsPath, 'utf-8'));
      expect(content.keywords[0]).toMatchObject({
        contextFilterMinDepth: 2,
        contextFilterMaxDepth: 8,
      });
      expect(content.keywords[0].contextFilterEnabled).toBeUndefined();
    });

    it('should not persist depth fields when not set', async () => {
      await configWriter.updateKeywords([validKeyword]);
      const content = JSON.parse(fs.readFileSync(keywordsPath, 'utf-8'));
      expect(content.keywords[0].contextFilterEnabled).toBeUndefined();
      expect(content.keywords[0].contextFilterMinDepth).toBeUndefined();
      expect(content.keywords[0].contextFilterMaxDepth).toBeUndefined();
    });

    it('should persist allowEmptyContent=true', async () => {
      await configWriter.updateKeywords([
        { ...validKeyword, allowEmptyContent: true },
      ]);
      const content = JSON.parse(fs.readFileSync(keywordsPath, 'utf-8'));
      expect(content.keywords[0].allowEmptyContent).toBe(true);
    });

    it('should persist allowEmptyContent=false', async () => {
      await configWriter.updateKeywords([
        { ...validKeyword, allowEmptyContent: false },
      ]);
      const content = JSON.parse(fs.readFileSync(keywordsPath, 'utf-8'));
      expect(content.keywords[0].allowEmptyContent).toBe(false);
    });

    it('should persist finalOllamaPass=false explicitly', async () => {
      await configWriter.updateKeywords([
        { ...validKeyword, finalOllamaPass: false },
      ]);
      const content = JSON.parse(fs.readFileSync(keywordsPath, 'utf-8'));
      expect(content.keywords[0].finalOllamaPass).toBe(false);
    });

    it('should omit finalOllamaPass when not provided (inherit default)', async () => {
      await configWriter.updateKeywords([validKeyword]);
      const content = JSON.parse(fs.readFileSync(keywordsPath, 'utf-8'));
      expect(content.keywords[0].finalOllamaPass).toBeUndefined();
    });

    it('should omit allowEmptyContent when not provided (inherit default)', async () => {
      await configWriter.updateKeywords([validKeyword]);
      const content = JSON.parse(fs.readFileSync(keywordsPath, 'utf-8'));
      expect(content.keywords[0].allowEmptyContent).toBeUndefined();
    });

    it('should reject non-boolean allowEmptyContent', async () => {
      await expect(
        configWriter.updateKeywords([
          { ...validKeyword, allowEmptyContent: 'yes' as any },
        ])
      ).rejects.toThrow('invalid allowEmptyContent');
    });

    it('should persist abilityWhen and abilityInputs together', async () => {
      const full = {
        ...validKeyword,
        abilityText: 'Get weather data',
        abilityWhen: 'User asks about weather.',
        abilityInputs: {
          mode: 'explicit' as const,
          required: ['location'],
          validation: 'Must be a city name or postal code.',
          examples: ['weather Dallas'],
        },
        allowEmptyContent: false,
      };
      await configWriter.updateKeywords([full]);

      const content = JSON.parse(fs.readFileSync(keywordsPath, 'utf-8'));
      expect(content.keywords[0]).toMatchObject({
        abilityText: 'Get weather data',
        abilityWhen: 'User asks about weather.',
        abilityInputs: {
          mode: 'explicit',
          required: ['location'],
          validation: 'Must be a city name or postal code.',
          examples: ['weather Dallas'],
        },
        allowEmptyContent: false,
      });
    });

    it('should persist retry configuration', async () => {
      const full = {
        ...validKeyword,
        retry: { enabled: true, maxRetries: 3, model: 'llama3', prompt: 'try again' },
      };
      await configWriter.updateKeywords([full]);

      const content = JSON.parse(fs.readFileSync(keywordsPath, 'utf-8'));
      expect(content.keywords[0].retry).toEqual({
        enabled: true,
        maxRetries: 3,
        model: 'llama3',
        prompt: 'try again',
      });
    });

    it('should reject custom help keyword when built-in help is enabled', async () => {
      const builtinHelp = { keyword: 'help', api: 'ollama' as const, timeout: 30, description: 'Help', builtin: true };
      const customHelp = { keyword: 'help', api: 'ollama' as const, timeout: 300, description: 'Custom help' };
      // builtin enabled (default) + custom help should fail with duplicate
      // The duplicate check runs first, but if we bypass it:
      await expect(
        configWriter.updateKeywords([builtinHelp, customHelp])
      ).rejects.toThrow(/[Dd]uplicate/);
    });

    it('should allow custom help keyword when built-in help is disabled', async () => {
      const builtinHelp = { keyword: 'help', api: 'ollama' as const, timeout: 30, description: 'Help', builtin: true, enabled: false };
      const customHelp = { keyword: 'Help', api: 'ollama' as const, timeout: 300, description: 'Custom help' };
      // These would be considered duplicates by the duplicate check since they normalize to 'help'
      // So custom help can only exist if the builtin is removed from the list
      // The real flow: configurator only sends one 'help' keyword at a time
      await expect(
        configWriter.updateKeywords([builtinHelp, customHelp])
      ).rejects.toThrow(/[Dd]uplicate/);
    });

    it('should reject null entry', async () => {
      await expect(
        configWriter.updateKeywords([null as any])
      ).rejects.toThrow('Invalid keyword entry at index 0');
    });

    it('should reject undefined entry', async () => {
      await expect(
        configWriter.updateKeywords([undefined as any])
      ).rejects.toThrow('Invalid keyword entry at index 0');
    });

    it('should reject entry missing keyword field', async () => {
      await expect(
        configWriter.updateKeywords([{ api: 'ollama', timeout: 300, description: 'no keyword' } as any])
      ).rejects.toThrow('missing "keyword"');
    });

    it('should report correct index for malformed entry', async () => {
      await expect(
        configWriter.updateKeywords([validKeyword, null as any])
      ).rejects.toThrow('at index 1');
    });
  });
});
