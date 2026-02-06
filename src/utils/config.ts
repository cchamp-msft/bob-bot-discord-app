import dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

dotenv.config();

export interface KeywordConfig {
  keyword: string;
  api: 'comfyui' | 'ollama';
  timeout: number;
  description: string;
}

export interface ConfigData {
  keywords: KeywordConfig[];
}

class Config {
  private keywords: KeywordConfig[] = [];

  constructor() {
    this.loadKeywords();
  }

  private loadKeywords(): void {
    const keywordsPath = path.join(__dirname, '../../config/keywords.json');
    try {
      const data = fs.readFileSync(keywordsPath, 'utf-8');
      const config: ConfigData = JSON.parse(data);
      this.keywords = config.keywords;
      console.log(`Loaded ${this.keywords.length} keywords from config`);
    } catch (error) {
      console.error('Failed to load keywords.json:', error);
      this.keywords = [];
    }
  }

  getKeywords(): KeywordConfig[] {
    return this.keywords;
  }

  getKeywordConfig(keyword: string): KeywordConfig | undefined {
    return this.keywords.find(
      (k) => k.keyword.toLowerCase() === keyword.toLowerCase()
    );
  }

  getDiscordToken(): string {
    const token = process.env.DISCORD_TOKEN;
    if (!token) throw new Error('DISCORD_TOKEN not set in .env');
    return token;
  }

  getClientId(): string {
    const id = process.env.DISCORD_CLIENT_ID;
    if (!id) throw new Error('DISCORD_CLIENT_ID not set in .env');
    return id;
  }

  getComfyUIEndpoint(): string {
    return process.env.COMFYUI_ENDPOINT || 'http://localhost:8188';
  }

  getOllamaEndpoint(): string {
    return process.env.OLLAMA_ENDPOINT || 'http://localhost:11434';
  }

  getHttpPort(): number {
    return parseInt(process.env.HTTP_PORT || '3000', 10);
  }

  getOutputBaseUrl(): string {
    return process.env.OUTPUT_BASE_URL || 'http://localhost:3000';
  }

  getFileSizeThreshold(): number {
    return parseInt(process.env.FILE_SIZE_THRESHOLD || '10485760', 10);
  }

  getDefaultTimeout(): number {
    return parseInt(process.env.DEFAULT_TIMEOUT || '300', 10);
  }

  getApiEndpoint(api: 'comfyui' | 'ollama'): string {
    return api === 'comfyui'
      ? this.getComfyUIEndpoint()
      : this.getOllamaEndpoint();
  }
}

export const config = new Config();
