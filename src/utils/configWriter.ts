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

        if (entry.api !== 'comfyui' && entry.api !== 'ollama' && entry.api !== 'accuweather' && entry.api !== 'nfl' && entry.api !== 'serpapi') {
          throw new Error(`Keyword "${entry.keyword}" has invalid api "${entry.api}" — must be "comfyui", "ollama", "accuweather", "nfl", or "serpapi"`);
        }
        if (typeof entry.timeout !== 'number' || entry.timeout <= 0) {
          throw new Error(`Keyword "${entry.keyword}" has invalid timeout — must be a positive number`);
        }
        if (!entry.description || typeof entry.description !== 'string') {
          throw new Error(`Keyword "${entry.keyword}" missing description`);
        }

        // Validate optional routing fields (must match Config.loadKeywords rules)
        if (entry.abilityText !== undefined && typeof entry.abilityText !== 'string') {
          throw new Error(`Keyword "${entry.keyword}" has invalid abilityText — must be a string`);
        }
        if (entry.abilityWhen !== undefined && typeof entry.abilityWhen !== 'string') {
          throw new Error(`Keyword "${entry.keyword}" has invalid abilityWhen — must be a string`);
        }
        if (entry.abilityInputs !== undefined) {
          const ai = entry.abilityInputs as unknown;
          if (typeof ai !== 'object' || ai === null || Array.isArray(ai)) {
            throw new Error(`Keyword "${entry.keyword}" has invalid abilityInputs — must be an object`);
          }
          const mode = (ai as any).mode;
          const validModes = ['implicit', 'explicit', 'mixed'];
          if (!validModes.includes(mode)) {
            throw new Error(`Keyword "${entry.keyword}" has invalid abilityInputs.mode "${mode}" — must be "implicit", "explicit", or "mixed"`);
          }
          const validateStringArray = (val: unknown) => Array.isArray(val) && val.every(s => typeof s === 'string');
          if ((ai as any).required !== undefined && !validateStringArray((ai as any).required)) {
            throw new Error(`Keyword "${entry.keyword}" has invalid abilityInputs.required — must be an array of strings`);
          }
          if ((ai as any).optional !== undefined && !validateStringArray((ai as any).optional)) {
            throw new Error(`Keyword "${entry.keyword}" has invalid abilityInputs.optional — must be an array of strings`);
          }
          if ((ai as any).inferFrom !== undefined && !validateStringArray((ai as any).inferFrom)) {
            throw new Error(`Keyword "${entry.keyword}" has invalid abilityInputs.inferFrom — must be an array of strings`);
          }
          if ((ai as any).validation !== undefined && typeof (ai as any).validation !== 'string') {
            throw new Error(`Keyword "${entry.keyword}" has invalid abilityInputs.validation — must be a string`);
          }
          if ((ai as any).examples !== undefined && !validateStringArray((ai as any).examples)) {
            throw new Error(`Keyword "${entry.keyword}" has invalid abilityInputs.examples — must be an array of strings`);
          }
        }
        if (entry.finalOllamaPass !== undefined && typeof entry.finalOllamaPass !== 'boolean') {
          throw new Error(`Keyword "${entry.keyword}" has invalid finalOllamaPass — must be a boolean`);
        }
        if (entry.accuweatherMode !== undefined && entry.accuweatherMode !== 'current' && entry.accuweatherMode !== 'forecast' && entry.accuweatherMode !== 'full') {
          throw new Error(`Keyword "${entry.keyword}" has invalid accuweatherMode "${entry.accuweatherMode}" — must be "current", "forecast", or "full"`);
        }
        if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') {
          throw new Error(`Keyword "${entry.keyword}" has invalid enabled — must be a boolean`);
        }
        if (entry.retry !== undefined) {
          const r: KeywordConfig['retry'] = entry.retry;
          if (typeof r !== 'object' || r === null || Array.isArray(r)) {
            throw new Error(`Keyword "${entry.keyword}" has invalid retry — must be an object`);
          }
          if (r.enabled !== undefined && typeof r.enabled !== 'boolean') {
            throw new Error(`Keyword "${entry.keyword}" has invalid retry.enabled — must be a boolean`);
          }
          if (r.maxRetries !== undefined) {
            if (typeof r.maxRetries !== 'number' || !Number.isInteger(r.maxRetries) || r.maxRetries < 0 || r.maxRetries > 10) {
              throw new Error(`Keyword "${entry.keyword}" has invalid retry.maxRetries — must be an integer between 0 and 10`);
            }
          }
          if (r.model !== undefined && typeof r.model !== 'string') {
            throw new Error(`Keyword "${entry.keyword}" has invalid retry.model — must be a string`);
          }
          if (r.prompt !== undefined && typeof r.prompt !== 'string') {
            throw new Error(`Keyword "${entry.keyword}" has invalid retry.prompt — must be a string`);
          }
        }
        if (entry.builtin !== undefined && typeof entry.builtin !== 'boolean') {
          throw new Error(`Keyword "${entry.keyword}" has invalid builtin — must be a boolean`);
        }
        if (entry.contextFilterEnabled !== undefined && typeof entry.contextFilterEnabled !== 'boolean') {
          throw new Error(`Keyword "${entry.keyword}" has invalid contextFilterEnabled — must be a boolean`);
        }
        if (entry.contextFilterMinDepth !== undefined) {
          if (typeof entry.contextFilterMinDepth !== 'number' || entry.contextFilterMinDepth < 1 || !Number.isInteger(entry.contextFilterMinDepth)) {
            throw new Error(`Keyword "${entry.keyword}" has invalid contextFilterMinDepth — must be a positive integer (>= 1)`);
          }
        }
        if (entry.contextFilterMaxDepth !== undefined) {
          if (typeof entry.contextFilterMaxDepth !== 'number' || entry.contextFilterMaxDepth < 1 || !Number.isInteger(entry.contextFilterMaxDepth)) {
            throw new Error(`Keyword "${entry.keyword}" has invalid contextFilterMaxDepth — must be a positive integer (>= 1)`);
          }
        }
        if (entry.contextFilterMinDepth !== undefined && entry.contextFilterMaxDepth !== undefined) {
          if (entry.contextFilterMinDepth > entry.contextFilterMaxDepth) {
            throw new Error(`Keyword "${entry.keyword}" has contextFilterMinDepth (${entry.contextFilterMinDepth}) greater than contextFilterMaxDepth (${entry.contextFilterMaxDepth})`);
          }
        }
      }

      // Enforce: custom "help" keyword is only allowed when the built-in help keyword is disabled
      const builtinHelp = keywords.find(k => k.builtin && k.keyword.toLowerCase() === 'help');
      const builtinHelpEnabled = builtinHelp ? builtinHelp.enabled !== false : false;
      if (builtinHelpEnabled) {
        const customHelpIndex = keywords.findIndex(k => !k.builtin && k.keyword.toLowerCase() === 'help');
        if (customHelpIndex !== -1) {
          throw new Error('Cannot save a custom "help" keyword while the built-in help keyword is enabled — disable the built-in help keyword first');
        }
      }

      // Strip unknown/deprecated fields and build clean keyword objects
      const cleanKeywords: KeywordConfig[] = keywords.map(entry => {
        const clean: KeywordConfig = {
          keyword: entry.keyword,
          api: entry.api,
          timeout: entry.timeout,
          description: entry.description,
        };
        if (entry.abilityText) clean.abilityText = entry.abilityText;
        if (entry.abilityWhen) clean.abilityWhen = entry.abilityWhen;
        if (entry.abilityInputs) clean.abilityInputs = entry.abilityInputs;
        if (entry.finalOllamaPass) clean.finalOllamaPass = entry.finalOllamaPass;
        if (entry.allowEmptyContent) clean.allowEmptyContent = entry.allowEmptyContent;
        if (entry.accuweatherMode) clean.accuweatherMode = entry.accuweatherMode;
        if (entry.enabled === false) clean.enabled = false;
        if (entry.retry) clean.retry = entry.retry;
        if (entry.builtin) clean.builtin = true;
        // contextFilterEnabled is deprecated (context eval is always active);
        // accepted on input for backward compat but no longer persisted.
        if (entry.contextFilterMinDepth !== undefined && entry.contextFilterMinDepth >= 1) clean.contextFilterMinDepth = entry.contextFilterMinDepth;
        if (entry.contextFilterMaxDepth !== undefined && entry.contextFilterMaxDepth >= 1) clean.contextFilterMaxDepth = entry.contextFilterMaxDepth;
        return clean;
      });

      // Write to file
      const configData: ConfigData = { keywords: cleanKeywords };
      fs.writeFileSync(
        this.keywordsPath,
        `${JSON.stringify(configData, null, 2)}\n`,
        'utf-8'
      );
    } catch (error) {
      throw new Error(`Failed to update keywords.json: ${error}`);
    }
  }
}

export const configWriter = new ConfigWriter();
