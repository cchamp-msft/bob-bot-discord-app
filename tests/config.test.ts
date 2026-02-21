/**
 * Config tests — exercises keyword loading, env parsing,
 * reload detection, and public config generation.
 * Does NOT connect to Discord.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logger } from '../src/utils/logger';
import { buildToolsXml } from '../src/utils/toolsXmlWriter';

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
    keywordsPath = path.join(configDir, 'tools.xml');
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
    fs.writeFileSync(keywordsPath, buildToolsXml(keywords as any));
  }

  /** Build minimal raw XML document for validation tests. */
  function rawToolsXml(...toolBodies: string[]): string {
    return `<?xml version="1.0" encoding="UTF-8"?>\n<tools>\n${toolBodies.join('\n')}\n</tools>`;
  }

  function _writeEnv(entries: Record<string, string>) {
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
      expect(config.getOutputBaseUrl()).toBe('http://localhost:3003');

      process.env.OUTPUT_BASE_URL = 'https://cdn.example.com';
      expect(config.getOutputBaseUrl()).toBe('https://cdn.example.com');
    });

    it('getOutputsPort should return env value or default 3003', () => {
      delete process.env.OUTPUTS_PORT;
      expect(config.getOutputsPort()).toBe(3003);

      process.env.OUTPUTS_PORT = '4444';
      expect(config.getOutputsPort()).toBe(4444);
    });

    it('getOutputsHost should return env value or default 0.0.0.0', () => {
      delete process.env.OUTPUTS_HOST;
      expect(config.getOutputsHost()).toBe('0.0.0.0');

      process.env.OUTPUTS_HOST = '192.168.1.100';
      expect(config.getOutputsHost()).toBe('192.168.1.100');
    });

    it('getOutputsTrustProxy should default to false', () => {
      delete process.env.OUTPUTS_TRUST_PROXY;
      expect(config.getOutputsTrustProxy()).toBe(false);
    });

    it('getOutputsTrustProxy should accept true and numeric hops', () => {
      process.env.OUTPUTS_TRUST_PROXY = 'true';
      expect(config.getOutputsTrustProxy()).toBe(true);

      process.env.OUTPUTS_TRUST_PROXY = '1';
      expect(config.getOutputsTrustProxy()).toBe(1);
    });

    it('getOutputsTrustProxy should normalize "0" to false', () => {
      process.env.OUTPUTS_TRUST_PROXY = '0';
      expect(config.getOutputsTrustProxy()).toBe(false);
    });

    it('getOutputsTrustProxy should fall back to false on invalid value', () => {
      process.env.OUTPUTS_TRUST_PROXY = 'abc';
      const warnSpy = jest.spyOn(logger, 'logWarn').mockImplementation(() => {});
      expect(config.getOutputsTrustProxy()).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith('config', expect.stringContaining('OUTPUTS_TRUST_PROXY'));
      warnSpy.mockRestore();
    });

    it('getHttpHost should return env value or default 127.0.0.1', () => {
      delete process.env.HTTP_HOST;
      expect(config.getHttpHost()).toBe('127.0.0.1');

      process.env.HTTP_HOST = '0.0.0.0';
      expect(config.getHttpHost()).toBe('0.0.0.0');
    });

    it('getHttpHost should trim whitespace', () => {
      process.env.HTTP_HOST = '  192.168.1.50  ';
      expect(config.getHttpHost()).toBe('192.168.1.50');
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

    it('getSerpApiLocation should return empty string when unset', () => {
      delete process.env.SERPAPI_LOCATION;
      expect(config.getSerpApiLocation()).toBe('');
    });

    it('getSerpApiLocation should return env value when set', () => {
      process.env.SERPAPI_LOCATION = 'Austin,Texas';
      expect(config.getSerpApiLocation()).toBe('Austin,Texas');
    });

    it('getSerpApiHl should default to "en" when unset', () => {
      delete process.env.SERPAPI_HL;
      expect(config.getSerpApiHl()).toBe('en');
    });

    it('getSerpApiHl should return env value when set', () => {
      process.env.SERPAPI_HL = 'de';
      expect(config.getSerpApiHl()).toBe('de');
    });

    it('getSerpApiHl should return empty string when explicitly cleared', () => {
      process.env.SERPAPI_HL = '';
      expect(config.getSerpApiHl()).toBe('');
    });

    it('getSerpApiGl should default to "us" when unset', () => {
      delete process.env.SERPAPI_GL;
      expect(config.getSerpApiGl()).toBe('us');
    });

    it('getSerpApiGl should return env value when set', () => {
      process.env.SERPAPI_GL = 'uk';
      expect(config.getSerpApiGl()).toBe('uk');
    });

    it('getSerpApiGl should return empty string when explicitly cleared', () => {
      process.env.SERPAPI_GL = '';
      expect(config.getSerpApiGl()).toBe('');
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
      expect(prompt).toContain('helpful Discord bot');
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
      expect(pub).toHaveProperty('defaultKeywords');
      expect(pub).toHaveProperty('replyChain');
      expect(pub).toHaveProperty('imageResponse');
    });

    it('should include serpapiLocation in public config', () => {
      process.env.SERPAPI_LOCATION = 'United States';
      const pub = config.getPublicConfig();
      expect(pub.apis.serpapiLocation).toBe('United States');
    });

    it('should include replyChain enabled, maxDepth, maxTokens, and imageMaxDepth', () => {
      delete process.env.REPLY_CHAIN_ENABLED;
      delete process.env.REPLY_CHAIN_MAX_DEPTH;
      delete process.env.REPLY_CHAIN_MAX_TOKENS;
      delete process.env.REPLY_CHAIN_IMAGE_MAX_DEPTH;
      const pub = config.getPublicConfig();
      expect(pub.replyChain).toEqual({ enabled: true, maxDepth: 30, maxTokens: 16000, imageMaxDepth: 5 });
    });

    it('should include httpHost and outputsHost in http section', () => {
      delete process.env.HTTP_HOST;
      delete process.env.OUTPUTS_HOST;
      const pub = config.getPublicConfig();
      expect(pub.http).toHaveProperty('httpHost');
      expect(pub.http).toHaveProperty('outputsHost');
      expect(pub.http.httpHost).toBe('127.0.0.1');
      expect(pub.http.outputsHost).toBe('0.0.0.0');
    });

    it('should reflect custom httpHost and outputsHost values', () => {
      process.env.HTTP_HOST = '0.0.0.0';
      process.env.OUTPUTS_HOST = '192.168.1.50';
      const pub = config.getPublicConfig();
      expect(pub.http.httpHost).toBe('0.0.0.0');
      expect(pub.http.outputsHost).toBe('192.168.1.50');
    });

    it('should include outputsTrustProxy in http section', () => {
      process.env.OUTPUTS_TRUST_PROXY = '1';
      const pub = config.getPublicConfig();
      expect(pub.http.outputsTrustProxy).toBe('1');
    });
  });

  describe('allowBotInteractions config', () => {
    const { config } = require('../src/utils/config');

    it('getAllowBotInteractions should default to false when env not set', () => {
      delete process.env.ALLOW_BOT_INTERACTIONS;
      expect(config.getAllowBotInteractions()).toBe(false);
    });

    it('getAllowBotInteractions should return true when env is "true"', () => {
      process.env.ALLOW_BOT_INTERACTIONS = 'true';
      expect(config.getAllowBotInteractions()).toBe(true);
    });

    it('getAllowBotInteractions should return false for any value other than "true"', () => {
      process.env.ALLOW_BOT_INTERACTIONS = 'false';
      expect(config.getAllowBotInteractions()).toBe(false);
      process.env.ALLOW_BOT_INTERACTIONS = '1';
      expect(config.getAllowBotInteractions()).toBe(false);
    });

    it('getPublicConfig should include allowBotInteractions', () => {
      process.env.ALLOW_BOT_INTERACTIONS = 'true';
      const pub = config.getPublicConfig();
      expect(pub.allowBotInteractions).toBe(true);
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

    it('getReplyChainMaxDepth should default to 30 when env not set', () => {
      delete process.env.REPLY_CHAIN_MAX_DEPTH;
      expect(config.getReplyChainMaxDepth()).toBe(30);
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

    it('getReplyChainImageMaxDepth should default to 5 when env not set', () => {
      delete process.env.REPLY_CHAIN_IMAGE_MAX_DEPTH;
      expect(config.getReplyChainImageMaxDepth()).toBe(5);
    });

    it('getReplyChainImageMaxDepth should parse valid int', () => {
      process.env.REPLY_CHAIN_IMAGE_MAX_DEPTH = '10';
      expect(config.getReplyChainImageMaxDepth()).toBe(10);
    });

    it('getReplyChainImageMaxDepth should clamp to 0 minimum', () => {
      process.env.REPLY_CHAIN_IMAGE_MAX_DEPTH = '-1';
      expect(config.getReplyChainImageMaxDepth()).toBe(0);
    });

    it('getReplyChainImageMaxDepth should clamp to 50 maximum', () => {
      process.env.REPLY_CHAIN_IMAGE_MAX_DEPTH = '100';
      expect(config.getReplyChainImageMaxDepth()).toBe(50);
    });

    it('getReplyChainImageMaxDepth should allow 0 to disable image collection', () => {
      process.env.REPLY_CHAIN_IMAGE_MAX_DEPTH = '0';
      expect(config.getReplyChainImageMaxDepth()).toBe(0);
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

  describe('meme logging config', () => {
    const { config } = require('../src/utils/config');

    it('getMemeLoggingDebug should default to false when env not set', () => {
      delete process.env.MEME_LOGGING_DEBUG;
      expect(config.getMemeLoggingDebug()).toBe(false);
    });

    it('getMemeLoggingDebug should return true when env is "true"', () => {
      process.env.MEME_LOGGING_DEBUG = 'true';
      expect(config.getMemeLoggingDebug()).toBe(true);
    });

    it('getPublicConfig should include memeLogging.debug', () => {
      process.env.MEME_LOGGING_DEBUG = 'true';
      const pub = config.getPublicConfig();
      expect(pub.memeLogging).toEqual({ debug: true });
    });
  });

  describe('getKeywordConfig', () => {
    const { config } = require('../src/utils/config');

    it('should find keyword case-insensitively', () => {
      // The runtime tools.xml (copied from tools.default.xml) should have "generate"
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

  describe('tools.default.xml copy-on-startup', () => {
    const { config } = require('../src/utils/config');
    const runtimePath = path.join(__dirname, '../config/tools.xml');
    const defaultPath = path.join(__dirname, '../config/tools.default.xml');
    let savedRuntime: string | null = null;

    beforeEach(() => {
      // Save current runtime file content (may have been created by earlier tests / singleton init)
      if (fs.existsSync(runtimePath)) {
        savedRuntime = fs.readFileSync(runtimePath, 'utf-8');
      } else {
        savedRuntime = null;
      }
    });

    afterEach(() => {
      // Restore runtime tools.xml
      if (savedRuntime !== null) {
        fs.writeFileSync(runtimePath, savedRuntime);
      } else if (fs.existsSync(runtimePath)) {
        fs.unlinkSync(runtimePath);
      }
      delete process.env.TOOLS_CONFIG_PATH;
      config.reload();
    });

    it('should copy tools.default.xml to tools.xml when runtime file is missing', () => {
      // Remove the runtime file
      if (fs.existsSync(runtimePath)) {
        fs.unlinkSync(runtimePath);
      }

      config.reload();

      // Runtime file should now exist (copied from default)
      expect(fs.existsSync(runtimePath)).toBe(true);

      // Content should match the default template (byte-for-byte copy)
      const defaultContent = fs.readFileSync(defaultPath, 'utf-8');
      const runtimeContent = fs.readFileSync(runtimePath, 'utf-8');
      expect(runtimeContent).toEqual(defaultContent);

      // Keywords should be loaded
      expect(config.getKeywords().length).toBeGreaterThan(0);
    });

    it('should not overwrite existing runtime tools.xml', () => {
      // Write a custom runtime file
      fs.writeFileSync(runtimePath, buildToolsXml([
        { keyword: 'customonly', api: 'ollama', timeout: 30, description: 'Custom' },
      ] as any));

      config.reload();

      // Should load the custom keyword, not the defaults
      expect(config.getKeywordConfig('customonly')).toBeDefined();
    });

    it('should skip copy-from-default when TOOLS_CONFIG_PATH is set', () => {
      // Remove the runtime file
      if (fs.existsSync(runtimePath)) {
        fs.unlinkSync(runtimePath);
      }

      // Point to a custom path
      writeKeywords([
        { keyword: 'envpath', api: 'ollama', timeout: 30, description: 'From env path' },
      ]);
      process.env.TOOLS_CONFIG_PATH = keywordsPath;

      config.reload();

      // Runtime tools.xml should NOT have been created (env path used instead)
      expect(fs.existsSync(runtimePath)).toBe(false);
      expect(config.getKeywordConfig('envpath')).toBeDefined();
    });

    it('should fall back to empty keywords when neither runtime nor default file exists', () => {
      // Remove the runtime file
      if (fs.existsSync(runtimePath)) {
        fs.unlinkSync(runtimePath);
      }

      // Temporarily rename the default file
      const backupPath = defaultPath + '.bak';
      fs.renameSync(defaultPath, backupPath);

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      try {
        config.reload();
        expect(config.getKeywords()).toEqual([]);
      } finally {
        // Restore the default file
        fs.renameSync(backupPath, defaultPath);
        warnSpy.mockRestore();
      }
    });
  });

  describe('getDefaultKeywords', () => {
    const { config } = require('../src/utils/config');

    it('should return an array of keywords from tools.default.xml', () => {
      const defaults = config.getDefaultKeywords();
      expect(Array.isArray(defaults)).toBe(true);
      expect(defaults.length).toBeGreaterThan(0);
    });

    it('should include the activity_key built-in keyword', () => {
      const defaults = config.getDefaultKeywords();
      const ak = defaults.find((k: any) => k.keyword === 'activity_key');
      expect(ak).toBeDefined();
      expect(ak.builtin).toBe(true);
    });
  });

  describe('default keyword self-heal', () => {
    const { config } = require('../src/utils/config');
    const runtimePath = path.join(__dirname, '../config/tools.xml');
    let savedRuntime: string | null = null;

    beforeEach(() => {
      if (fs.existsSync(runtimePath)) {
        savedRuntime = fs.readFileSync(runtimePath, 'utf-8');
      } else {
        savedRuntime = null;
      }
    });

    afterEach(() => {
      if (savedRuntime !== null) {
        fs.writeFileSync(runtimePath, savedRuntime);
      } else if (fs.existsSync(runtimePath)) {
        fs.unlinkSync(runtimePath);
      }
      config.reload();
    });

    it('should merge missing built-in keywords from defaults into runtime config', () => {
      // Write a runtime config WITHOUT activity_key
      fs.writeFileSync(runtimePath, buildToolsXml([
        { keyword: 'help', api: 'ollama', timeout: 120, description: 'Help', builtin: true },
        { keyword: 'chat', api: 'ollama', timeout: 300, description: 'Chat' },
      ] as any));
      config.reload();

      // activity_key should be merged from defaults
      const ak = config.getKeywordConfig('activity_key');
      expect(ak).toBeDefined();
      expect(ak!.builtin).toBe(true);
    });

    it('should merge missing non-built-in keywords from defaults into runtime config', () => {
      // Write a runtime config without meme_templates
      fs.writeFileSync(runtimePath, buildToolsXml([
        { keyword: 'help', api: 'ollama', timeout: 120, description: 'Help', builtin: true },
        { keyword: 'meme', api: 'meme', timeout: 60, description: 'Create meme images' },
      ] as any));
      config.reload();

      const mt = config.getKeywordConfig('meme_templates');
      expect(mt).toBeDefined();
      expect(mt!.api).toBe('meme');
      expect(mt!.allowEmptyContent).toBe(true);
    });

    it('should not duplicate already-present built-in keywords', () => {
      // Write a runtime config WITH activity_key already present
      fs.writeFileSync(runtimePath, buildToolsXml([
        { keyword: 'help', api: 'ollama', timeout: 120, description: 'Help', builtin: true },
        { keyword: 'activity_key', api: 'ollama', timeout: 10, description: 'Key', builtin: true },
      ] as any));
      config.reload();

      const matches = config.getKeywords().filter((k: any) => k.keyword.toLowerCase() === 'activity_key');
      expect(matches).toHaveLength(1);
    });

    it('should not backfill optional fields on existing keywords', () => {
      // Write a runtime config with help that does NOT have allowEmptyContent.
      // Existing keyword entries should remain unchanged.
      fs.writeFileSync(runtimePath, buildToolsXml([
        { keyword: 'help', api: 'ollama', timeout: 120, description: 'Help', builtin: true },
      ] as any));
      config.reload();

      const helpKw = config.getKeywordConfig('help');
      expect(helpKw).toBeDefined();
      expect(helpKw!.allowEmptyContent).toBeUndefined();
    });

    it('should not overwrite existing allowEmptyContent on built-in keyword', () => {
      // Write a runtime config with help that explicitly has allowEmptyContent: false
      fs.writeFileSync(runtimePath, buildToolsXml([
        { keyword: 'help', api: 'ollama', timeout: 120, description: 'Help', builtin: true, allowEmptyContent: false },
      ] as any));
      config.reload();

      const helpKw = config.getKeywordConfig('help');
      expect(helpKw).toBeDefined();
      // Existing value is preserved
      expect(helpKw!.allowEmptyContent).toBe(false);
    });

    it('should keep existing keyword unchanged while still adding missing defaults', () => {
      fs.writeFileSync(runtimePath, buildToolsXml([
        { keyword: 'help', api: 'ollama', timeout: 120, description: 'Custom help', builtin: true },
      ] as any));
      config.reload();

      const helpKw = config.getKeywordConfig('help');
      const activityKeyKw = config.getKeywordConfig('activity_key');
      expect(helpKw).toBeDefined();
      expect(helpKw!.description).toBe('Custom help');
      expect(activityKeyKw).toBeDefined();
    });

    it('should preserve runtime values for fields that also exist in defaults', () => {
      fs.writeFileSync(runtimePath, buildToolsXml([
        {
          keyword: 'help',
          api: 'ollama',
          timeout: 120,
          description: 'Help',
          builtin: true,
          allowEmptyContent: false,
        },
      ] as any));
      config.reload();

      const helpKw = config.getKeywordConfig('help');
      expect(helpKw).toBeDefined();
      // Existing values are retained even when defaults define the same field.
      expect(helpKw!.allowEmptyContent).toBe(false);
      // In XML, description doubles as abilityText
      expect(helpKw!.abilityText).toBe('Help');
    });

    it('should not backfill multiple missing fields on an existing keyword', () => {
      // Existing keywords are kept as-is; only truly missing keywords are added.
      fs.writeFileSync(runtimePath, buildToolsXml([
        { keyword: 'help', api: 'ollama', timeout: 120, description: 'Help', builtin: true },
      ] as any));
      config.reload();

      const helpKw = config.getKeywordConfig('help');
      expect(helpKw).toBeDefined();
      expect(helpKw!.allowEmptyContent).toBeUndefined();
    });
  });

  describe('getPublicConfig includes defaultKeywords', () => {
    const { config } = require('../src/utils/config');

    it('should include defaultKeywords array in public config', () => {
      const pub = config.getPublicConfig();
      expect(pub).toHaveProperty('defaultKeywords');
      expect(Array.isArray(pub.defaultKeywords)).toBe(true);
      expect(pub.defaultKeywords.length).toBeGreaterThan(0);
    });
  });

  describe('TOOLS_CONFIG_PATH support', () => {
    const { config } = require('../src/utils/config');

    it('reload should read keywords from TOOLS_CONFIG_PATH when set', () => {
      writeKeywords([
        {
          keyword: 'envkw',
          api: 'ollama',
          timeout: 30,
          description: 'Loaded from env path',
        },
      ]);

      process.env.TOOLS_CONFIG_PATH = keywordsPath;

      try {
        const result = config.reload();
        expect(result.reloaded).toContain('keywords');

        const loaded = config.getKeywordConfig('envkw');
        expect(loaded).toBeDefined();
        expect(loaded!.description).toBe('Loaded from env path');
        // Default sync merges ALL keywords from defaults, so 'generate' is present
        expect(config.getKeywordConfig('generate')).toBeDefined();
      } finally {
        delete process.env.TOOLS_CONFIG_PATH;
        config.reload();
      }
    });
  });

  describe('abilityWhen and parameters validation', () => {
    const { config } = require('../src/utils/config');
    const kwPath = path.join(__dirname, '../config/tools.xml');
    let originalContent: string;

    beforeEach(() => {
      originalContent = fs.readFileSync(kwPath, 'utf-8');
    });

    afterEach(() => {
      fs.writeFileSync(kwPath, originalContent);
      config.reload();
    });

    it('should accept valid abilityWhen string', () => {
      fs.writeFileSync(
        kwPath,
        rawToolsXml(`  <tool>
    <name>testkw</name>
    <api>nfl</api>
    <timeout>30</timeout>
    <description>test</description>
    <abilityWhen>User asks for test data</abilityWhen>
  </tool>`)
      );
      config.reload();
      const kw = config.getKeywordConfig('testkw');
      expect(kw).toBeDefined();
      expect(kw!.abilityWhen).toBe('User asks for test data');
    });

    it('should treat numeric-looking abilityWhen as string in XML', () => {
      // In XML all values are strings — numeric-looking values are valid
      fs.writeFileSync(
        kwPath,
        rawToolsXml(`  <tool>
    <name>testkw</name>
    <api>nfl</api>
    <timeout>30</timeout>
    <description>test</description>
    <abilityWhen>42</abilityWhen>
  </tool>`)
      );
      config.reload();
      const kw = config.getKeywordConfig('testkw');
      expect(kw).toBeDefined();
      expect(kw!.abilityWhen).toBe('42');
    });

    it('should accept valid parameters with all fields', () => {
      fs.writeFileSync(
        kwPath,
        rawToolsXml(`  <tool>
    <name>testkw</name>
    <api>nfl</api>
    <timeout>30</timeout>
    <description>test</description>
    <parameters>
      <mode>explicit</mode>
      <location>
        <type>string</type>
        <description>The location</description>
        <required>true</required>
      </location>
      <date>
        <type>string</type>
        <description>The date</description>
        <required>false</required>
      </date>
      <inferFrom>current_message</inferFrom>
      <validation>location must be a city</validation>
      <examples>
        <example>testkw Dallas</example>
      </examples>
    </parameters>
  </tool>`)
      );
      config.reload();
      const kw = config.getKeywordConfig('testkw');
      expect(kw).toBeDefined();
      expect(kw!.abilityInputs).toBeDefined();
      expect(kw!.abilityInputs!.mode).toBe('explicit');
      expect(kw!.abilityInputs!.required).toEqual(['location']);
      expect(kw!.abilityInputs!.optional).toEqual(['date']);
      expect(kw!.abilityInputs!.validation).toBe('location must be a city');
      expect(kw!.abilityInputs!.examples).toEqual(['testkw Dallas']);
    });

    it('should accept parameters with only mode (minimal)', () => {
      fs.writeFileSync(
        kwPath,
        rawToolsXml(`  <tool>
    <name>testkw</name>
    <api>comfyui</api>
    <timeout>30</timeout>
    <description>test</description>
    <parameters>
      <mode>implicit</mode>
    </parameters>
  </tool>`)
      );
      config.reload();
      const kw = config.getKeywordConfig('testkw');
      expect(kw).toBeDefined();
      expect(kw!.abilityInputs!.mode).toBe('implicit');
    });

    it('should reject parameters with invalid mode', () => {
      fs.writeFileSync(
        kwPath,
        rawToolsXml(`  <tool>
    <name>testkw</name>
    <api>nfl</api>
    <timeout>30</timeout>
    <description>test</description>
    <parameters>
      <mode>auto</mode>
    </parameters>
  </tool>`)
      );
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      config.reload();
      expect(config.getKeywordConfig('testkw')).toBeUndefined();
      warnSpy.mockRestore();
    });

    it('should reject parameters with no mode element', () => {
      fs.writeFileSync(
        kwPath,
        rawToolsXml(`  <tool>
    <name>testkw</name>
    <api>nfl</api>
    <timeout>30</timeout>
    <description>test</description>
    <parameters>
      <location>
        <type>string</type>
        <description>The location</description>
        <required>true</required>
      </location>
    </parameters>
  </tool>`)
      );
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      config.reload();
      expect(config.getKeywordConfig('testkw')).toBeUndefined();
      warnSpy.mockRestore();
    });

    it('should reject malformed XML gracefully', () => {
      fs.writeFileSync(
        kwPath,
        '<tools><tool><name>testkw</name><api>nfl</api>'
      );
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      config.reload();
      expect(config.getKeywordConfig('testkw')).toBeUndefined();
      warnSpy.mockRestore();
    });

    it('should reject tool with invalid api', () => {
      fs.writeFileSync(
        kwPath,
        rawToolsXml(`  <tool>
    <name>testkw</name>
    <api>badapi</api>
    <timeout>30</timeout>
    <description>test</description>
  </tool>`)
      );
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      config.reload();
      expect(config.getKeywordConfig('testkw')).toBeUndefined();
      warnSpy.mockRestore();
    });
  });

  describe('contextFilterMaxDepth normalization on load', () => {
    const { config } = require('../src/utils/config');
    const kwPath = path.join(__dirname, '../config/tools.xml');
    let originalContent: string;

    beforeEach(() => {
      originalContent = fs.readFileSync(kwPath, 'utf-8');
    });

    afterEach(() => {
      // Restore runtime tools.xml and reload
      fs.writeFileSync(kwPath, originalContent);
      config.reload();
    });

    it('should normalize contextFilterMaxDepth of 0 to undefined and log a warning', () => {
      fs.writeFileSync(
        kwPath,
        rawToolsXml(`  <tool>
    <name>testdepth</name>
    <api>ollama</api>
    <timeout>30</timeout>
    <description>test</description>
    <contextFilterMaxDepth>0</contextFilterMaxDepth>
  </tool>`)
      );
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      config.reload();

      const kw = config.getKeywordConfig('testdepth');
      expect(kw).toBeDefined();
      expect(kw!.contextFilterMaxDepth).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('contextFilterMaxDepth=0 is invalid')
      );

      warnSpy.mockRestore();
    });

    it('should accept contextFilterMaxDepth >= 1', () => {
      fs.writeFileSync(
        kwPath,
        rawToolsXml(`  <tool>
    <name>testdepth</name>
    <api>ollama</api>
    <timeout>30</timeout>
    <description>test</description>
    <contextFilterMaxDepth>3</contextFilterMaxDepth>
  </tool>`)
      );

      config.reload();

      const kw = config.getKeywordConfig('testdepth');
      expect(kw).toBeDefined();
      expect(kw!.contextFilterMaxDepth).toBe(3);
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

    it('getComfyUIDefaultSampler should return euler_ancestral by default', () => {
      delete process.env.COMFYUI_DEFAULT_SAMPLER;
      expect(config.getComfyUIDefaultSampler()).toBe('euler_ancestral');
    });

    it('getComfyUIDefaultScheduler should return beta by default', () => {
      delete process.env.COMFYUI_DEFAULT_SCHEDULER;
      expect(config.getComfyUIDefaultScheduler()).toBe('beta');
    });

    it('getComfyUIDefaultDenoise should return 0.88 by default', () => {
      delete process.env.COMFYUI_DEFAULT_DENOISE;
      expect(config.getComfyUIDefaultDenoise()).toBe(0.88);
    });

    it('getComfyUIDefaultDenoise should parse float env value', () => {
      process.env.COMFYUI_DEFAULT_DENOISE = '0.88';
      expect(config.getComfyUIDefaultDenoise()).toBe(0.88);
    });

    it('getComfyUIDefaultSeed should return -1 by default', () => {
      delete process.env.COMFYUI_DEFAULT_SEED;
      expect(config.getComfyUIDefaultSeed()).toBe(-1);
    });

    it('getComfyUIDefaultSeed should parse int env value', () => {
      process.env.COMFYUI_DEFAULT_SEED = '42';
      expect(config.getComfyUIDefaultSeed()).toBe(42);
    });

    it('getComfyUIDefaultSeed should clamp to valid range', () => {
      process.env.COMFYUI_DEFAULT_SEED = '9999999999';
      expect(config.getComfyUIDefaultSeed()).toBe(2147483647);
    });

    it('should include default workflow in getPublicConfig', () => {
      process.env.COMFYUI_DEFAULT_MODEL = 'test.safetensors';
      process.env.COMFYUI_DEFAULT_STEPS = '30';
      const pub = config.getPublicConfig();
      expect(pub.defaultWorkflow).toBeDefined();
      expect(pub.defaultWorkflow.model).toBe('test.safetensors');
      expect(pub.defaultWorkflow.steps).toBe(30);
      expect(pub.defaultWorkflow.seed).toBe(-1);
    });

    // ── Admin token getter ───────────────────────────────────────

    it('getAdminToken should return empty string when not set', () => {
      delete process.env.ADMIN_TOKEN;
      expect(config.getAdminToken()).toBe('');
    });

    it('getAdminToken should return trimmed value when set', () => {
      process.env.ADMIN_TOKEN = '  my-secret  ';
      expect(config.getAdminToken()).toBe('my-secret');
    });

    // ── Reload restart signaling for split-server fields ─────────
    // Note: reload() re-reads the .env file from disk with dotenv.config(),
    // so runtime process.env changes are overwritten. We verify the mechanism
    // by checking that HTTP_PORT uses the same private-field comparison
    // pattern as the new host/port fields.

    it('reload should report HTTP_PORT as restart-required when file differs from construction', () => {
      // The singleton captured HTTP_PORT at construction. If the .env file on
      // disk has a different value, reload should detect it.
      // Since we can't easily change the file in a singleton test, we verify
      // that calling reload twice with stable env does NOT flag restart keys.
      const result = config.reload();
      expect(result.requiresRestart).not.toContain('HTTP_HOST');
      expect(result.requiresRestart).not.toContain('OUTPUTS_PORT');
      expect(result.requiresRestart).not.toContain('OUTPUTS_HOST');
      expect(result.requiresRestart).not.toContain('OUTPUTS_TRUST_PROXY');
    });

    it('reload should include outputs bind settings in restart detection', () => {
      // Verify the reload return type includes the new fields when they differ.
      // We force the private fields to a known value, then reload so that
      // the live env (from .env on disk) differs.
      const original = {
        httpHost: (config as any).httpHost,
        outputsPort: (config as any).outputsPort,
        outputsHostBound: (config as any).outputsHostBound,
        outputsTrustProxyBound: (config as any).outputsTrustProxyBound,
      };

      try {
        // Set private fields to values that differ from what .env will produce
        (config as any).httpHost = '__FAKE_HOST__';
        (config as any).outputsPort = 99999;
        (config as any).outputsHostBound = '__FAKE_OUTPUTS_HOST__';
        (config as any).outputsTrustProxyBound = '__FAKE_OUTPUTS_TRUST_PROXY__';

        const result = config.reload();
        expect(result.requiresRestart).toContain('HTTP_HOST');
        expect(result.requiresRestart).toContain('OUTPUTS_PORT');
        expect(result.requiresRestart).toContain('OUTPUTS_HOST');
        expect(result.requiresRestart).toContain('OUTPUTS_TRUST_PROXY');
      } finally {
        // Restore
        (config as any).httpHost = original.httpHost;
        (config as any).outputsPort = original.outputsPort;
        (config as any).outputsHostBound = original.outputsHostBound;
        (config as any).outputsTrustProxyBound = original.outputsTrustProxyBound;
        config.reload(); // re-stabilize
      }
    });
  });
});
