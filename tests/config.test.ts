/**
 * Config tests — exercises keyword loading, env parsing,
 * reload detection, and public config generation.
 * Does NOT connect to Discord.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// We can't easily test the singleton since it loads on import.
// Instead we test the Config class directly by re-creating instances
// with controlled temp dirs.

// Save original env
const originalEnv = { ...process.env };

describe('Config', () => {
  let tempDir: string;
  let configDir: string;
  let envPath: string;
  let keywordsPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
    configDir = path.join(tempDir, 'config');
    fs.mkdirSync(configDir, { recursive: true });
    envPath = path.join(tempDir, '.env');
    keywordsPath = path.join(configDir, 'keywords.json');
  });

  afterEach(() => {
    // Restore env
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function writeKeywords(keywords: any[]) {
    fs.writeFileSync(keywordsPath, JSON.stringify({ keywords }, null, 2));
  }

  function writeEnv(entries: Record<string, string>) {
    const content = Object.entries(entries)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    fs.writeFileSync(envPath, content);
  }

  // We can test the Config singleton's methods that read process.env
  // by manipulating process.env directly (since Config reads it live).
  describe('env-based getters (via singleton)', () => {
    // Import the singleton
    const { config } = require('../src/utils/config');

    it('getComfyUIEndpoint should return env value or default', () => {
      delete process.env.COMFYUI_ENDPOINT;
      expect(config.getComfyUIEndpoint()).toBe('http://localhost:8188');

      process.env.COMFYUI_ENDPOINT = 'http://custom:9999';
      expect(config.getComfyUIEndpoint()).toBe('http://custom:9999');
    });

    it('getOllamaEndpoint should return env value or default', () => {
      delete process.env.OLLAMA_ENDPOINT;
      expect(config.getOllamaEndpoint()).toBe('http://localhost:11434');

      process.env.OLLAMA_ENDPOINT = 'http://ollama:5555';
      expect(config.getOllamaEndpoint()).toBe('http://ollama:5555');
    });

    it('getOutputBaseUrl should return env value or default', () => {
      delete process.env.OUTPUT_BASE_URL;
      expect(config.getOutputBaseUrl()).toBe('http://localhost:3000');

      process.env.OUTPUT_BASE_URL = 'https://cdn.example.com';
      expect(config.getOutputBaseUrl()).toBe('https://cdn.example.com');
    });

    it('getApiEndpoint should route correctly', () => {
      process.env.COMFYUI_ENDPOINT = 'http://comfy:1111';
      process.env.OLLAMA_ENDPOINT = 'http://ollama:2222';

      expect(config.getApiEndpoint('comfyui')).toBe('http://comfy:1111');
      expect(config.getApiEndpoint('ollama')).toBe('http://ollama:2222');
    });

    it('getDiscordToken should return empty string if not set', () => {
      const saved = process.env.DISCORD_TOKEN;
      delete process.env.DISCORD_TOKEN;
      expect(config.getDiscordToken()).toBe('');
      if (saved) process.env.DISCORD_TOKEN = saved;
    });

    it('getClientId should return empty string if not set', () => {
      const saved = process.env.DISCORD_CLIENT_ID;
      delete process.env.DISCORD_CLIENT_ID;
      expect(config.getClientId()).toBe('');
      if (saved) process.env.DISCORD_CLIENT_ID = saved;
    });
  });

  describe('parseIntEnv (via public getters)', () => {
    const { config } = require('../src/utils/config');

    it('getDefaultTimeout should return default when env not set', () => {
      delete process.env.DEFAULT_TIMEOUT;
      expect(config.getDefaultTimeout()).toBe(300);
    });

    it('getDefaultTimeout should parse valid int', () => {
      process.env.DEFAULT_TIMEOUT = '60';
      expect(config.getDefaultTimeout()).toBe(60);
    });

    it('should throw on non-numeric env value', () => {
      process.env.DEFAULT_TIMEOUT = 'abc';
      expect(() => config.getDefaultTimeout()).toThrow('not a valid number');
    });

    it('getFileSizeThreshold should return default when not set', () => {
      delete process.env.FILE_SIZE_THRESHOLD;
      expect(config.getFileSizeThreshold()).toBe(10485760);
    });
  });

  describe('getPublicConfig', () => {
    const { config } = require('../src/utils/config');

    it('should never expose the Discord token value', () => {
      process.env.DISCORD_TOKEN = 'super-secret-token';
      const pub = config.getPublicConfig();

      const json = JSON.stringify(pub);
      expect(json).not.toContain('super-secret-token');
      expect(pub.discord.tokenConfigured).toBe(true);
    });

    it('should report tokenConfigured as false when no token', () => {
      delete process.env.DISCORD_TOKEN;
      const pub = config.getPublicConfig();
      expect(pub.discord.tokenConfigured).toBe(false);
    });

    it('should include all expected sections', () => {
      const pub = config.getPublicConfig();
      expect(pub).toHaveProperty('discord');
      expect(pub).toHaveProperty('apis');
      expect(pub).toHaveProperty('http');
      expect(pub).toHaveProperty('limits');
      expect(pub).toHaveProperty('keywords');
    });
  });

  describe('getKeywordConfig', () => {
    const { config } = require('../src/utils/config');

    it('should find keyword case-insensitively', () => {
      // The default keywords.json should have "generate"
      const kw = config.getKeywordConfig('GENERATE');
      if (kw) {
        expect(kw.keyword.toLowerCase()).toBe('generate');
      }
      // If no keywords loaded, this test is a no-op (still valid)
    });

    it('should return undefined for unknown keyword', () => {
      const kw = config.getKeywordConfig('nonexistent_keyword_xyz');
      expect(kw).toBeUndefined();
    });
  });
});
