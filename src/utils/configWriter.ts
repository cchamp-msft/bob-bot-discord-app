import * as fs from 'fs';
import * as path from 'path';
import { KeywordConfig, ConfigData } from './config';
import { isUIFormat, convertUIToAPIFormat } from '../api/comfyuiClient';

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
   * If the workflow is in UI format, it is auto-converted to API format before saving.
   * Returns the result of validation and save, including whether conversion occurred.
   */
  async saveWorkflow(workflowJson: string, filename: string): Promise<{ success: boolean; error?: string; converted?: boolean }> {
    // Validate JSON structure
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(workflowJson);
    } catch (e) {
      return {
        success: false,
        error: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    // Detect UI format and auto-convert
    let finalJson = workflowJson;
    let wasConverted = false;

    if (isUIFormat(parsed)) {
      try {
        const converted = convertUIToAPIFormat(parsed);
        finalJson = JSON.stringify(converted, null, 2);
        wasConverted = true;
      } catch (e) {
        return {
          success: false,
          error: `Workflow is in ComfyUI UI format but conversion failed: ${e instanceof Error ? e.message : String(e)}. Please export using "Save (API Format)" in ComfyUI.`,
        };
      }
    }

    // Validate %prompt% placeholder presence (case-sensitive)
    if (!finalJson.includes('%prompt%')) {
      const hint = wasConverted
        ? ' The workflow was auto-converted from UI format — the %prompt% placeholder may not have survived conversion. Ensure %prompt% is set as a widget value in your ComfyUI workflow, then re-export.'
        : '';
      return {
        success: false,
        error: `Workflow must contain at least one %prompt% placeholder (case-sensitive).${hint} See documentation for details.`,
      };
    }

    try {
      this.ensureConfigDir();
      fs.writeFileSync(this.workflowPath, finalJson, 'utf-8');
      return { success: true, converted: wasConverted };
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
   * Delete the custom ComfyUI workflow file, causing the app
   * to fall back to the default generated workflow.
   * Returns true if deleted, false if it didn't exist.
   */
  deleteWorkflow(): boolean {
    if (fs.existsSync(this.workflowPath)) {
      fs.unlinkSync(this.workflowPath);
      return true;
    }
    return false;
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
      for (let i = 0; i < keywords.length; i++) {
        const entry = keywords[i];

        // Guard against null/undefined/non-object entries
        if (!entry || typeof entry !== 'object') {
          throw new Error(`Invalid keyword entry at index ${i} — expected object with "keyword" field`);
        }

        // Validate using same rules as Config.loadKeywords()
        if (!entry.keyword || typeof entry.keyword !== 'string') {
          throw new Error(`Invalid keyword entry at index ${i} — missing "keyword" string`);
        }

        const normalized = entry.keyword.toLowerCase().trim();
        if (keywordNames.has(normalized)) {
          throw new Error(`Duplicate keyword: "${entry.keyword}"`);
        }
        keywordNames.add(normalized);

        if (entry.api !== 'comfyui' && entry.api !== 'ollama' && entry.api !== 'accuweather') {
          throw new Error(`Keyword "${entry.keyword}" has invalid api "${entry.api}" — must be "comfyui", "ollama", or "accuweather"`);
        }
        if (typeof entry.timeout !== 'number' || entry.timeout <= 0) {
          throw new Error(`Keyword "${entry.keyword}" has invalid timeout — must be a positive number`);
        }
        if (!entry.description || typeof entry.description !== 'string') {
          throw new Error(`Keyword "${entry.keyword}" missing description`);
        }

        // Validate optional routing fields (must match Config.loadKeywords rules)
        if (entry.routeApi !== undefined && entry.routeApi !== 'comfyui' && entry.routeApi !== 'ollama' && entry.routeApi !== 'accuweather' && entry.routeApi !== 'external') {
          throw new Error(`Keyword "${entry.keyword}" has invalid routeApi "${entry.routeApi}" — must be "comfyui", "ollama", "accuweather", or "external"`);
        }
        if (entry.routeModel !== undefined && typeof entry.routeModel !== 'string') {
          throw new Error(`Keyword "${entry.keyword}" has invalid routeModel — must be a string`);
        }
        if (entry.finalOllamaPass !== undefined && typeof entry.finalOllamaPass !== 'boolean') {
          throw new Error(`Keyword "${entry.keyword}" has invalid finalOllamaPass — must be a boolean`);
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
