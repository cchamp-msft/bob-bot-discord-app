import * as fs from 'fs';
import * as path from 'path';
import { KeywordConfig, ConfigData } from './config';

interface EnvUpdate {
  [key: string]: string | number;
}

class ConfigWriter {
  private envPath = path.join(__dirname, '../../.env');
  private keywordsPath = path.join(__dirname, '../../config/keywords.json');

  /**
   * Update .env file with new values while preserving formatting and comments
   */
  async updateEnv(updates: EnvUpdate): Promise<void> {
    try {
      let envContent = '';
      
      // Read existing .env if it exists
      if (fs.existsSync(this.envPath)) {
        envContent = fs.readFileSync(this.envPath, 'utf-8');
      }

      // Parse existing lines
      const lines = envContent.split('\n');
      const updatedKeys = new Set<string>();

      // Update existing keys
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        
        // Skip comments and empty lines
        if (line.startsWith('#') || line === '') {
          continue;
        }

        // Parse key=value
        const match = line.match(/^([^=]+)=(.*)$/);
        if (match) {
          const key = match[1].trim();
          if (key in updates) {
            lines[i] = `${key}=${updates[key]}`;
            updatedKeys.add(key);
          }
        }
      }

      // Append new keys that weren't in the file
      for (const [key, value] of Object.entries(updates)) {
        if (!updatedKeys.has(key)) {
          lines.push(`${key}=${value}`);
        }
      }

      // Write back
      fs.writeFileSync(this.envPath, lines.join('\n'), 'utf-8');
    } catch (error) {
      throw new Error(`Failed to update .env: ${error}`);
    }
  }

  /**
   * Validate and update keywords.json
   */
  async updateKeywords(keywords: KeywordConfig[]): Promise<void> {
    try {
      // Validate keywords array
      if (!Array.isArray(keywords)) {
        throw new Error('keywords must be an array');
      }

      // Check for duplicates
      const keywordNames = new Set<string>();
      for (const entry of keywords) {
        const normalized = entry.keyword.toLowerCase().trim();
        if (keywordNames.has(normalized)) {
          throw new Error(`Duplicate keyword: "${entry.keyword}"`);
        }
        keywordNames.add(normalized);

        // Validate using same rules as Config.loadKeywords()
        if (!entry.keyword || typeof entry.keyword !== 'string') {
          throw new Error('Invalid keyword entry — missing "keyword" string');
        }
        if (entry.api !== 'comfyui' && entry.api !== 'ollama') {
          throw new Error(`Keyword "${entry.keyword}" has invalid api "${entry.api}" — must be "comfyui" or "ollama"`);
        }
        if (typeof entry.timeout !== 'number' || entry.timeout <= 0) {
          throw new Error(`Keyword "${entry.keyword}" has invalid timeout — must be a positive number`);
        }
        if (!entry.description || typeof entry.description !== 'string') {
          throw new Error(`Keyword "${entry.keyword}" missing description`);
        }
      }

      // Write to file
      const configData: ConfigData = { keywords };
      fs.writeFileSync(
        this.keywordsPath,
        JSON.stringify(configData, null, 2),
        'utf-8'
      );
    } catch (error) {
      throw new Error(`Failed to update keywords.json: ${error}`);
    }
  }
}

export const configWriter = new ConfigWriter();
