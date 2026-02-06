import * as fs from 'fs';
import * as path from 'path';
import { KeywordConfig, ConfigData } from './config';

interface EnvUpdate {
  [key: string]: string | number;
}

class ConfigWriter {
  private envPath = path.join(__dirname, '../../.env');
  private keywordsPath = path.join(__dirname, '../../config/keywords.json');
  private configDir = path.join(__dirname, '../../.config');
  private workflowPath = path.join(__dirname, '../../.config/comfyui-workflow.json');

  /**
   * Ensure the .config directory exists.
   */
  private ensureConfigDir(): void {
    if (!fs.existsSync(this.configDir)) {
      fs.mkdirSync(this.configDir, { recursive: true });
    }
  }

  /**
   * Save and validate a ComfyUI workflow JSON file.
   * Validates that the content is valid JSON and contains at least one %prompt% placeholder (case-sensitive).
   * Returns the result of validation and save.
   */
  async saveWorkflow(workflowJson: string, filename: string): Promise<{ success: boolean; error?: string }> {
    // Validate JSON structure
    try {
      JSON.parse(workflowJson);
    } catch (e) {
      return {
        success: false,
        error: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    // Validate %prompt% placeholder presence (case-sensitive)
    if (!workflowJson.includes('%prompt%')) {
      return {
        success: false,
        error: 'Workflow must contain at least one %prompt% placeholder (case-sensitive). See documentation for details.',
      };
    }

    try {
      this.ensureConfigDir();
      fs.writeFileSync(this.workflowPath, workflowJson, 'utf-8');
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: `Failed to save workflow: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

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
            lines[i] = `${key}=${this.encodeEnvValue(String(updates[key]))}`;
            updatedKeys.add(key);
          }
        }
      }

      // Append new keys that weren't in the file
      for (const [key, value] of Object.entries(updates)) {
        if (!updatedKeys.has(key)) {
          lines.push(`${key}=${this.encodeEnvValue(String(value))}`);
        }
      }

      // Write back
      fs.writeFileSync(this.envPath, lines.join('\n'), 'utf-8');
    } catch (error) {
      throw new Error(`Failed to update .env: ${error}`);
    }
  }

  /**
   * Encode a value for safe storage in a .env file.
   * Wraps values containing newlines, quotes, or leading/trailing
   * whitespace in double quotes with proper escaping.
   */
  private encodeEnvValue(value: string): string {
    // If the value contains newlines, quotes, or surrounding whitespace, quote it
    if (/[\n\r"]/.test(value) || value !== value.trim()) {
      const escaped = value
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r');
      return `"${escaped}"`;
    }
    return value;
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
