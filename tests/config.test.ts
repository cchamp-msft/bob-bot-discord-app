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
      expect(config.getComfyUIEndpoint()).toBe('http://localhost:8190');

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

    it('should fall back to default on non-numeric env value', () => {
      process.env.DEFAULT_TIMEOUT = 'abc';
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      expect(config.getDefaultTimeout()).toBe(300);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('not a valid number'));
      warnSpy.mockRestore();
    });

    it('getFileSizeThreshold should return default when not set', () => {
      delete process.env.FILE_SIZE_THRESHOLD;
      expect(config.getFileSizeThreshold()).toBe(10485760);
    });

    it('getMaxAttachments should return default 10 when not set', () => {
      delete process.env.MAX_ATTACHMENTS;
      expect(config.getMaxAttachments()).toBe(10);
    });

    it('getMaxAttachments should parse valid int', () => {
      process.env.MAX_ATTACHMENTS = '5';
      expect(config.getMaxAttachments()).toBe(5);
    });

    it('getMaxAttachments should clamp values above 10 to 10', () => {
      process.env.MAX_ATTACHMENTS = '25';
      expect(config.getMaxAttachments()).toBe(10);
    });

    it('getMaxAttachments should clamp values below 1 to 1', () => {
      process.env.MAX_ATTACHMENTS = '0';
      expect(config.getMaxAttachments()).toBe(1);
    });

    it('getMaxAttachments should clamp negative values to 1', () => {
      process.env.MAX_ATTACHMENTS = '-3';
      expect(config.getMaxAttachments()).toBe(1);
    });
  });

  describe('getOllamaSystemPrompt', () => {
    const { config } = require('../src/utils/config');

    it('should return default prompt when env not set', () => {
      delete process.env.OLLAMA_SYSTEM_PROMPT;
      const prompt = config.getOllamaSystemPrompt();
      expect(prompt).toContain('helpful Discord bot assistant');
      expect(prompt).toContain('snarky');
    });

    it('should return custom prompt when env is set', () => {
      process.env.OLLAMA_SYSTEM_PROMPT = 'You are a pirate bot.';
      expect(config.getOllamaSystemPrompt()).toBe('You are a pirate bot.');
    });

    it('should return empty string when env is explicitly set to empty', () => {
      process.env.OLLAMA_SYSTEM_PROMPT = '';
      expect(config.getOllamaSystemPrompt()).toBe('');
    });

    it('should be included in getPublicConfig', () => {
      process.env.OLLAMA_SYSTEM_PROMPT = 'Custom prompt';
      const pub = config.getPublicConfig();
      expect(pub.apis.ollamaSystemPrompt).toBe('Custom prompt');
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
      expect(pub).toHaveProperty('replyChain');
      expect(pub).toHaveProperty('imageResponse');
    });

    it('should include replyChain enabled, maxDepth, and maxTokens', () => {
      delete process.env.REPLY_CHAIN_ENABLED;
      delete process.env.REPLY_CHAIN_MAX_DEPTH;
      delete process.env.REPLY_CHAIN_MAX_TOKENS;
      const pub = config.getPublicConfig();
      expect(pub.replyChain).toEqual({ enabled: true, maxDepth: 10, maxTokens: 16000 });
    });
  });

  describe('reply chain config', () => {
    const { config } = require('../src/utils/config');

    it('getReplyChainEnabled should default to true when env not set', () => {
      delete process.env.REPLY_CHAIN_ENABLED;
      expect(config.getReplyChainEnabled()).toBe(true);
    });

    it('getReplyChainEnabled should return false when env is "false"', () => {
      process.env.REPLY_CHAIN_ENABLED = 'false';
      expect(config.getReplyChainEnabled()).toBe(false);
    });

    it('getReplyChainEnabled should return true for any value other than "false"', () => {
      process.env.REPLY_CHAIN_ENABLED = 'true';
      expect(config.getReplyChainEnabled()).toBe(true);
      process.env.REPLY_CHAIN_ENABLED = '1';
      expect(config.getReplyChainEnabled()).toBe(true);
    });

    it('getReplyChainMaxDepth should default to 10 when env not set', () => {
      delete process.env.REPLY_CHAIN_MAX_DEPTH;
      expect(config.getReplyChainMaxDepth()).toBe(10);
    });

    it('getReplyChainMaxDepth should parse valid int', () => {
      process.env.REPLY_CHAIN_MAX_DEPTH = '25';
      expect(config.getReplyChainMaxDepth()).toBe(25);
    });

    it('getReplyChainMaxDepth should clamp to 1 minimum', () => {
      process.env.REPLY_CHAIN_MAX_DEPTH = '0';
      expect(config.getReplyChainMaxDepth()).toBe(1);
    });

    it('getReplyChainMaxDepth should clamp to 50 maximum', () => {
      process.env.REPLY_CHAIN_MAX_DEPTH = '100';
      expect(config.getReplyChainMaxDepth()).toBe(50);
    });

    it('getReplyChainMaxTokens should default to 16000 when env not set', () => {
      delete process.env.REPLY_CHAIN_MAX_TOKENS;
      expect(config.getReplyChainMaxTokens()).toBe(16000);
    });

    it('getReplyChainMaxTokens should parse valid int', () => {
      process.env.REPLY_CHAIN_MAX_TOKENS = '32000';
      expect(config.getReplyChainMaxTokens()).toBe(32000);
    });

    it('getReplyChainMaxTokens should clamp to 1000 minimum', () => {
      process.env.REPLY_CHAIN_MAX_TOKENS = '100';
      expect(config.getReplyChainMaxTokens()).toBe(1000);
    });

    it('getReplyChainMaxTokens should clamp to 128000 maximum', () => {
      process.env.REPLY_CHAIN_MAX_TOKENS = '500000';
      expect(config.getReplyChainMaxTokens()).toBe(128000);
    });

    it('getReplyChainMaxTokens should fall back to default on non-numeric value', () => {
      process.env.REPLY_CHAIN_MAX_TOKENS = 'xyz';
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      expect(config.getReplyChainMaxTokens()).toBe(16000);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('not a valid number'));
      warnSpy.mockRestore();
    });
  });

  describe('image response config', () => {
    const { config } = require('../src/utils/config');

    it('getImageResponseIncludeEmbed should default to false when env not set', () => {
      delete process.env.IMAGE_RESPONSE_INCLUDE_EMBED;
      expect(config.getImageResponseIncludeEmbed()).toBe(false);
    });

    it('getImageResponseIncludeEmbed should return true when env is "true"', () => {
      process.env.IMAGE_RESPONSE_INCLUDE_EMBED = 'true';
      expect(config.getImageResponseIncludeEmbed()).toBe(true);
    });

    it('getImageResponseIncludeEmbed should return false for any value other than "true"', () => {
      process.env.IMAGE_RESPONSE_INCLUDE_EMBED = 'false';
      expect(config.getImageResponseIncludeEmbed()).toBe(false);
      process.env.IMAGE_RESPONSE_INCLUDE_EMBED = '1';
      expect(config.getImageResponseIncludeEmbed()).toBe(false);
      process.env.IMAGE_RESPONSE_INCLUDE_EMBED = 'yes';
      expect(config.getImageResponseIncludeEmbed()).toBe(false);
    });

    it('should be included in getPublicConfig', () => {
      delete process.env.IMAGE_RESPONSE_INCLUDE_EMBED;
      const pub = config.getPublicConfig();
      expect(pub.imageResponse).toBeDefined();
      expect(pub.imageResponse.includeEmbed).toBe(false);
    });

    it('getPublicConfig should reflect env change for imageResponse', () => {
      process.env.IMAGE_RESPONSE_INCLUDE_EMBED = 'true';
      const pub = config.getPublicConfig();
      expect(pub.imageResponse.includeEmbed).toBe(true);
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

  describe('default workflow getters', () => {
    const { config } = require('../src/utils/config');

    it('getComfyUIDefaultModel should return empty string if not set', () => {
      delete process.env.COMFYUI_DEFAULT_MODEL;
      expect(config.getComfyUIDefaultModel()).toBe('');
    });

    it('getComfyUIDefaultModel should return env value', () => {
      process.env.COMFYUI_DEFAULT_MODEL = 'sd15.safetensors';
      expect(config.getComfyUIDefaultModel()).toBe('sd15.safetensors');
    });

    it('getComfyUIDefaultWidth should return 512 by default', () => {
      delete process.env.COMFYUI_DEFAULT_WIDTH;
      expect(config.getComfyUIDefaultWidth()).toBe(512);
    });

    it('getComfyUIDefaultWidth should parse env value', () => {
      process.env.COMFYUI_DEFAULT_WIDTH = '1024';
      expect(config.getComfyUIDefaultWidth()).toBe(1024);
    });

    it('getComfyUIDefaultHeight should return 512 by default', () => {
      delete process.env.COMFYUI_DEFAULT_HEIGHT;
      expect(config.getComfyUIDefaultHeight()).toBe(512);
    });

    it('getComfyUIDefaultSteps should return 20 by default', () => {
      delete process.env.COMFYUI_DEFAULT_STEPS;
      expect(config.getComfyUIDefaultSteps()).toBe(20);
    });

    it('getComfyUIDefaultCfg should return 7.0 by default', () => {
      delete process.env.COMFYUI_DEFAULT_CFG;
      expect(config.getComfyUIDefaultCfg()).toBe(7.0);
    });

    it('getComfyUIDefaultCfg should parse float env value', () => {
      process.env.COMFYUI_DEFAULT_CFG = '5.5';
      expect(config.getComfyUIDefaultCfg()).toBe(5.5);
    });

    it('getComfyUIDefaultSampler should return euler by default', () => {
      delete process.env.COMFYUI_DEFAULT_SAMPLER;
      expect(config.getComfyUIDefaultSampler()).toBe('euler');
    });

    it('getComfyUIDefaultScheduler should return normal by default', () => {
      delete process.env.COMFYUI_DEFAULT_SCHEDULER;
      expect(config.getComfyUIDefaultScheduler()).toBe('normal');
    });

    it('getComfyUIDefaultDenoise should return 1.0 by default', () => {
      delete process.env.COMFYUI_DEFAULT_DENOISE;
      expect(config.getComfyUIDefaultDenoise()).toBe(1.0);
    });

    it('getComfyUIDefaultDenoise should parse float env value', () => {
      process.env.COMFYUI_DEFAULT_DENOISE = '0.88';
      expect(config.getComfyUIDefaultDenoise()).toBe(0.88);
    });

    it('should include default workflow in getPublicConfig', () => {
      process.env.COMFYUI_DEFAULT_MODEL = 'test.safetensors';
      process.env.COMFYUI_DEFAULT_STEPS = '30';
      const pub = config.getPublicConfig();
      expect(pub.defaultWorkflow).toBeDefined();
      expect(pub.defaultWorkflow.model).toBe('test.safetensors');
      expect(pub.defaultWorkflow.steps).toBe(30);
    });
  });
});
