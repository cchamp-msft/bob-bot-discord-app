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
    (configWriter as any).keywordsPath = keywordsPath;
  });

  afterEach(() => {
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
  });
});
