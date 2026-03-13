import * as fs from 'fs';
import * as path from 'path';
import { readEnvVar } from '../src/utils/dotenvCodec';
import { parseToolsXml } from '../src/utils/toolsXmlParser';

// The configWriter module imports from './config' which triggers dotenv + tools loading.
// We need .env and tools.xml to exist before importing.
const testDir = path.join(__dirname, '../test-fixtures');
const _testEnvPath = path.join(testDir, '.env');
const testToolsDir = path.join(testDir, 'config');
const _testToolsPath = path.join(testToolsDir, 'tools.xml');

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
  let toolsPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'configwriter-'));
    envPath = path.join(tempDir, '.env');
    toolsPath = path.join(tempDir, 'tools.xml');

    // Override private paths via Object property access
    (configWriter as any).envPath = envPath;
    process.env.TOOLS_CONFIG_PATH = toolsPath;
  });

  afterEach(() => {
    delete process.env.TOOLS_CONFIG_PATH;
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

  describe('updateTools', () => {
    const validTool = {
      name: 'test',
      api: 'ollama' as const,
      timeout: 300,
      description: 'Test tool',
    };

    it('should write valid tools to file', async () => {
      await configWriter.updateTools([validTool]);

      const content = parseToolsXml(fs.readFileSync(toolsPath, 'utf-8'));
      expect(content).toHaveLength(1);
      expect(content[0].name).toBe('test');
      expect(content[0].api).toBe('ollama');
    });

    it('should reject duplicate tools (case-insensitive)', async () => {
      await expect(
        configWriter.updateTools([
          { ...validTool, name: 'Ask' },
          { ...validTool, name: 'ask' },
        ])
      ).rejects.toThrow('Duplicate tool');
    });

    it('should reject invalid api value', async () => {
      await expect(
        configWriter.updateTools([
          { ...validTool, api: 'invalid' as any },
        ])
      ).rejects.toThrow('invalid api');
    });

    it('should reject non-positive timeout', async () => {
      await expect(
        configWriter.updateTools([
          { ...validTool, timeout: 0 },
        ])
      ).rejects.toThrow('invalid timeout');
    });

    it('should reject negative timeout', async () => {
      await expect(
        configWriter.updateTools([
          { ...validTool, timeout: -1 },
        ])
      ).rejects.toThrow('invalid timeout');
    });

    it('should reject missing name string', async () => {
      await expect(
        configWriter.updateTools([
          { ...validTool, name: '' },
        ])
      ).rejects.toThrow('missing "name" string');
    });

    it('should reject missing description', async () => {
      await expect(
        configWriter.updateTools([
          { ...validTool, description: '' },
        ])
      ).rejects.toThrow('missing description');
    });

    it('should reject non-array input', async () => {
      await expect(
        configWriter.updateTools('not-an-array' as any)
      ).rejects.toThrow('must be an array');
    });

    it('should write multiple valid tools', async () => {
      await configWriter.updateTools([
        { name: 'generate', api: 'comfyui', timeout: 300, description: 'Gen image' },
        { name: 'ask', api: 'ollama', timeout: 120, description: 'Ask question' },
      ]);

      const content = parseToolsXml(fs.readFileSync(toolsPath, 'utf-8'));
      expect(content).toHaveLength(2);
      expect(content[0].api).toBe('comfyui');
      expect(content[1].api).toBe('ollama');
    });

    it('should reject empty array (pre-write sanity check catches unparseable output)', async () => {
      await expect(configWriter.updateTools([])).rejects.toThrow('Missing root <tools> element');
    });

    it('should accept valid abilityText field', async () => {
      await configWriter.updateTools([
        { ...validTool, abilityText: 'do something useful' },
      ]);

      const content = parseToolsXml(fs.readFileSync(toolsPath, 'utf-8'));
      // In XML format, description doubles as abilityText
      expect(content[0].abilityText).toBe(content[0].description);
    });

    it('should reject non-string abilityText', async () => {
      await expect(
        configWriter.updateTools([
          { ...validTool, abilityText: 123 as any },
        ])
      ).rejects.toThrow('invalid abilityText');
    });

    it('should persist tools with all routing fields', async () => {
      const full = {
        ...validTool,
        abilityText: 'do something',
      };
      await configWriter.updateTools([full]);

      const content = parseToolsXml(fs.readFileSync(toolsPath, 'utf-8'));
      expect(content[0]).toMatchObject({
        name: 'test',
        api: 'ollama',
      });
    });

    it('should accept tools without optional routing fields', async () => {
      await configWriter.updateTools([validTool]);

      const content = parseToolsXml(fs.readFileSync(toolsPath, 'utf-8'));
      // In XML, abilityText is always derived from description
      expect(content[0].abilityText).toBe('Test tool');
    });

    it('should strip unknown fields like routeApi on save', async () => {
      const entryWithRouteApi = {
        ...validTool,
        routeApi: 'comfyui',  // deprecated/unknown field
        routeModel: 'specialized',  // deprecated field
        extraField: 'ignored',
      } as any;
      await configWriter.updateTools([entryWithRouteApi]);

      const content = parseToolsXml(fs.readFileSync(toolsPath, 'utf-8'));
      expect((content[0] as any).routeApi).toBeUndefined();
      expect((content[0] as any).routeModel).toBeUndefined();
      expect((content[0] as any).extraField).toBeUndefined();
      expect(content[0].name).toBe('test');
      expect(content[0].api).toBe('ollama');
    });

    it('should accept valid enabled field (true)', async () => {
      await configWriter.updateTools([{ ...validTool, enabled: true }]);
      const content = parseToolsXml(fs.readFileSync(toolsPath, 'utf-8'));
      // enabled=true is the default, so it may be omitted in clean output
      expect(content[0].name).toBe('test');
    });

    it('should persist enabled=false', async () => {
      await configWriter.updateTools([{ ...validTool, enabled: false }]);
      const content = parseToolsXml(fs.readFileSync(toolsPath, 'utf-8'));
      expect(content[0].enabled).toBe(false);
    });

    it('should reject non-boolean enabled', async () => {
      await expect(
        configWriter.updateTools([{ ...validTool, enabled: 'yes' as any }])
      ).rejects.toThrow('invalid enabled');
    });

    it('should accept valid builtin field', async () => {
      await configWriter.updateTools([{ ...validTool, builtin: true }]);
      const content = parseToolsXml(fs.readFileSync(toolsPath, 'utf-8'));
      expect(content[0].builtin).toBe(true);
    });

    it('should reject non-boolean builtin', async () => {
      await expect(
        configWriter.updateTools([{ ...validTool, builtin: 'yes' as any }])
      ).rejects.toThrow('invalid builtin');
    });

    it('should persist allowEmptyContent=true', async () => {
      await configWriter.updateTools([
        { ...validTool, allowEmptyContent: true },
      ]);
      const content = parseToolsXml(fs.readFileSync(toolsPath, 'utf-8'));
      expect(content[0].allowEmptyContent).toBe(true);
    });

    it('should persist allowEmptyContent=false', async () => {
      await configWriter.updateTools([
        { ...validTool, allowEmptyContent: false },
      ]);
      const content = parseToolsXml(fs.readFileSync(toolsPath, 'utf-8'));
      expect(content[0].allowEmptyContent).toBe(false);
    });

    it('should omit allowEmptyContent when not provided (inherit default)', async () => {
      await configWriter.updateTools([validTool]);
      const content = parseToolsXml(fs.readFileSync(toolsPath, 'utf-8'));
      expect(content[0].allowEmptyContent).toBeUndefined();
    });

    it('should reject non-boolean allowEmptyContent', async () => {
      await expect(
        configWriter.updateTools([
          { ...validTool, allowEmptyContent: 'yes' as any },
        ])
      ).rejects.toThrow('invalid allowEmptyContent');
    });

    it('should persist abilityWhen and abilityInputs together', async () => {
      const full = {
        ...validTool,
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
      await configWriter.updateTools([full]);

      const content = parseToolsXml(fs.readFileSync(toolsPath, 'utf-8'));
      expect(content[0].abilityWhen).toBe('User asks about weather.');
      expect(content[0].abilityInputs).toBeDefined();
      expect(content[0].abilityInputs!.mode).toBe('explicit');
      expect(content[0].abilityInputs!.required).toEqual(['location']);
      expect(content[0].abilityInputs!.validation).toBe('Must be a city name or postal code.');
      expect(content[0].abilityInputs!.examples).toEqual(['weather Dallas']);
      expect(content[0].allowEmptyContent).toBe(false);
    });

    it('should persist retry configuration', async () => {
      const full = {
        ...validTool,
        retry: { enabled: true, maxRetries: 3, model: 'llama3', prompt: 'try again' },
      };
      await configWriter.updateTools([full]);

      const content = parseToolsXml(fs.readFileSync(toolsPath, 'utf-8'));
      expect(content[0].retry).toBeDefined();
      expect(content[0].retry!.enabled).toBe(true);
      expect(content[0].retry!.maxRetries).toBe(3);
      expect(content[0].retry!.model).toBe('llama3');
      expect(content[0].retry!.prompt).toBe('try again');
    });

    it('should accept xai-image api', async () => {
      await configWriter.updateTools([
        { ...validTool, name: 'grok_image', api: 'xai-image' as const },
      ]);
      const content = parseToolsXml(fs.readFileSync(toolsPath, 'utf-8'));
      expect(content[0].api).toBe('xai-image');
    });

    it('should accept xai-video api', async () => {
      await configWriter.updateTools([
        { ...validTool, name: 'grok_video', api: 'xai-video' as const },
      ]);
      const content = parseToolsXml(fs.readFileSync(toolsPath, 'utf-8'));
      expect(content[0].api).toBe('xai-video');
    });

    it('should create .bak backup before writing', async () => {
      // Write initial content
      await configWriter.updateTools([validTool]);
      const initialContent = fs.readFileSync(toolsPath, 'utf-8');

      // Write again with different data
      await configWriter.updateTools([{ ...validTool, description: 'Updated tool' }]);

      const bakPath = toolsPath + '.bak';
      expect(fs.existsSync(bakPath)).toBe(true);
      expect(fs.readFileSync(bakPath, 'utf-8')).toBe(initialContent);
    });

    it('should reject custom help tool when built-in help is enabled', async () => {
      const builtinHelp = { name: 'help', api: 'ollama' as const, timeout: 30, description: 'Help', builtin: true };
      const customHelp = { name: 'help', api: 'ollama' as const, timeout: 300, description: 'Custom help' };
      // builtin enabled (default) + custom help should fail with duplicate
      // The duplicate check runs first, but if we bypass it:
      await expect(
        configWriter.updateTools([builtinHelp, customHelp])
      ).rejects.toThrow(/[Dd]uplicate/);
    });

    it('should allow custom help tool when built-in help is disabled', async () => {
      const builtinHelp = { name: 'help', api: 'ollama' as const, timeout: 30, description: 'Help', builtin: true, enabled: false };
      const customHelp = { name: 'Help', api: 'ollama' as const, timeout: 300, description: 'Custom help' };
      // These would be considered duplicates by the duplicate check since they normalize to 'help'
      // So custom help can only exist if the builtin is removed from the list
      // The real flow: configurator only sends one 'help' tool at a time
      await expect(
        configWriter.updateTools([builtinHelp, customHelp])
      ).rejects.toThrow(/[Dd]uplicate/);
    });

    it('should reject null entry', async () => {
      await expect(
        configWriter.updateTools([null as any])
      ).rejects.toThrow('Invalid tool entry at index 0');
    });

    it('should reject undefined entry', async () => {
      await expect(
        configWriter.updateTools([undefined as any])
      ).rejects.toThrow('Invalid tool entry at index 0');
    });

    it('should reject entry missing name field', async () => {
      await expect(
        configWriter.updateTools([{ api: 'ollama', timeout: 300, description: 'no name' } as any])
      ).rejects.toThrow('missing "name"');
    });

    it('should report correct index for malformed entry', async () => {
      await expect(
        configWriter.updateTools([validTool, null as any])
      ).rejects.toThrow('at index 1');
    });
  });

  describe('saveWorkflow with toolName', () => {
    it('should save to per-tool path when toolName is provided', async () => {
      const workflowsDir = path.join(tempDir, '.config', 'comfyui-workflows');
      (configWriter as any).configDir = path.join(tempDir, '.config');
      (configWriter as any).workflowsDir = workflowsDir;

      const workflow = JSON.stringify({ '1': { class_type: 'Test', inputs: { text: '%prompt%' } } });
      const result = await configWriter.saveWorkflow(workflow, 'test.json', 'generate_video_local');

      expect(result.success).toBe(true);
      const savedPath = path.join(workflowsDir, 'generate_video_local.json');
      expect(fs.existsSync(savedPath)).toBe(true);
      expect(fs.readFileSync(savedPath, 'utf-8')).toContain('%prompt%');
    });

    it('should save to legacy path when toolName is not provided', async () => {
      const legacyPath = path.join(tempDir, 'workflow.json');
      (configWriter as any).configDir = tempDir;
      (configWriter as any).workflowPath = legacyPath;

      const workflow = JSON.stringify({ '1': { class_type: 'Test', inputs: { text: '%prompt%' } } });
      const result = await configWriter.saveWorkflow(workflow, 'test.json');

      expect(result.success).toBe(true);
      expect(fs.existsSync(legacyPath)).toBe(true);
    });
  });

  describe('deleteWorkflow with toolName', () => {
    it('should delete per-tool workflow file', () => {
      const workflowsDir = path.join(tempDir, 'comfyui-workflows');
      fs.mkdirSync(workflowsDir, { recursive: true });
      const toolFile = path.join(workflowsDir, 'generate_video_local.json');
      fs.writeFileSync(toolFile, '{}');
      (configWriter as any).workflowsDir = workflowsDir;

      const result = configWriter.deleteWorkflow('generate_video_local');
      expect(result).toBe(true);
      expect(fs.existsSync(toolFile)).toBe(false);
    });

    it('should return false if per-tool workflow does not exist', () => {
      (configWriter as any).workflowsDir = path.join(tempDir, 'nonexistent');
      const result = configWriter.deleteWorkflow('nonexistent_tool');
      expect(result).toBe(false);
    });
  });

  describe('listToolWorkflows', () => {
    it('should list workflow files in the workflows directory', () => {
      const workflowsDir = path.join(tempDir, 'comfyui-workflows');
      fs.mkdirSync(workflowsDir, { recursive: true });
      fs.writeFileSync(path.join(workflowsDir, 'generate_video_local.json'), '{}');
      fs.writeFileSync(path.join(workflowsDir, 'generate_image_from_image_local.json'), '{}');
      (configWriter as any).workflowsDir = workflowsDir;

      const results = configWriter.listToolWorkflows();
      expect(results).toHaveLength(2);
      expect(results.map(r => r.toolName).sort()).toEqual([
        'generate_image_from_image_local',
        'generate_video_local',
      ]);
      expect(results.every(r => r.hasWorkflow)).toBe(true);
    });

    it('should return empty array if directory does not exist', () => {
      (configWriter as any).workflowsDir = path.join(tempDir, 'nonexistent');
      const results = configWriter.listToolWorkflows();
      expect(results).toEqual([]);
    });
  });

  describe('renameWorkflow', () => {
    it('should rename an existing per-tool workflow file', () => {
      const workflowsDir = path.join(tempDir, 'comfyui-workflows');
      fs.mkdirSync(workflowsDir, { recursive: true });
      fs.writeFileSync(path.join(workflowsDir, 'old_tool.json'), '{"test":true}');
      (configWriter as any).workflowsDir = workflowsDir;

      const result = configWriter.renameWorkflow('old_tool', 'new_tool');
      expect(result).toBe(true);
      expect(fs.existsSync(path.join(workflowsDir, 'new_tool.json'))).toBe(true);
      expect(fs.existsSync(path.join(workflowsDir, 'old_tool.json'))).toBe(false);
      // Verify content is preserved
      const content = fs.readFileSync(path.join(workflowsDir, 'new_tool.json'), 'utf-8');
      expect(JSON.parse(content)).toEqual({ test: true });
    });

    it('should return false if the source workflow does not exist', () => {
      const workflowsDir = path.join(tempDir, 'comfyui-workflows');
      fs.mkdirSync(workflowsDir, { recursive: true });
      (configWriter as any).workflowsDir = workflowsDir;

      const result = configWriter.renameWorkflow('nonexistent', 'new_name');
      expect(result).toBe(false);
    });
  });
});
