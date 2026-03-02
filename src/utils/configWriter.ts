import * as fs from 'fs';
import * as path from 'path';
import { ToolConfig, COMMAND_PREFIX, VALID_TOOL_APIS } from './config';
import { isUIFormat, convertUIToAPIFormat } from '../api/comfyuiClient';
import { buildToolsXml } from './toolsXmlWriter';
import { parseToolsXml } from './toolsXmlParser';

interface EnvUpdate {
  [key: string]: string | number;
}

class ConfigWriter {
  private envPath = path.join(__dirname, '../../.env');
  private get toolsPath(): string {
    const envPath = process.env.TOOLS_CONFIG_PATH;
    if (envPath) {
      return path.resolve(path.join(__dirname, '../..'), envPath);
    }
    return path.join(__dirname, '../../config/tools.xml');
  }
  private defaultToolsPath = path.join(__dirname, '../../config/tools.default.xml');
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
  async saveWorkflow(workflowJson: string, _filename: string): Promise<{ success: boolean; error?: string; converted?: boolean }> {
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
      throw new Error(`Failed to update .env: ${error}`, { cause: error });
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
   * Validate and update tools.xml
   */
  async updateTools(tools: ToolConfig[]): Promise<void> {
    try {
      // Validate tools array
      if (!Array.isArray(tools)) {
        throw new Error('tools must be an array');
      }

      // Check for duplicates
      const toolNames = new Set<string>();
      for (let i = 0; i < tools.length; i++) {
        const entry = tools[i];

        // Guard against null/undefined/non-object entries
        if (!entry || typeof entry !== 'object') {
          throw new Error(`Invalid tool entry at index ${i} — expected object with "name" field`);
        }

        // Validate using same rules as Config.loadTools()
        if (!entry.name || typeof entry.name !== 'string') {
          throw new Error(`Invalid tool entry at index ${i} — missing "name" string`);
        }

        const normalized = entry.name.toLowerCase().trim();
        if (toolNames.has(normalized)) {
          throw new Error(`Duplicate tool: "${entry.name}"`);
        }
        toolNames.add(normalized);

        const validApis: readonly string[] = VALID_TOOL_APIS;
        if (!validApis.includes(entry.api)) {
          throw new Error(`Tool "${entry.name}" has invalid api "${entry.api}" — must be one of: ${validApis.join(', ')}`);
        }
        if (typeof entry.timeout !== 'number' || entry.timeout <= 0) {
          throw new Error(`Tool "${entry.name}" has invalid timeout — must be a positive number`);
        }
        if (!entry.description || typeof entry.description !== 'string') {
          throw new Error(`Tool "${entry.name}" missing description`);
        }

        // Validate optional routing fields (must match Config.loadTools rules)
        if (entry.abilityText !== undefined && typeof entry.abilityText !== 'string') {
          throw new Error(`Tool "${entry.name}" has invalid abilityText — must be a string`);
        }
        if (entry.abilityWhen !== undefined && typeof entry.abilityWhen !== 'string') {
          throw new Error(`Tool "${entry.name}" has invalid abilityWhen — must be a string`);
        }
        if (entry.abilityInputs !== undefined) {
          const ai: Record<string, unknown> = entry.abilityInputs as unknown as Record<string, unknown>;
          if (typeof ai !== 'object' || ai === null || Array.isArray(ai)) {
            throw new Error(`Tool "${entry.name}" has invalid abilityInputs — must be an object`);
          }
          const mode = ai.mode;
          const validModes = ['implicit', 'explicit', 'mixed'];
          if (!validModes.includes(mode as string)) {
            throw new Error(`Tool "${entry.name}" has invalid abilityInputs.mode "${mode}" — must be "implicit", "explicit", or "mixed"`);
          }
          const validateStringArray = (val: unknown) => Array.isArray(val) && val.every(s => typeof s === 'string');
          if (ai.required !== undefined && !validateStringArray(ai.required)) {
            throw new Error(`Tool "${entry.name}" has invalid abilityInputs.required — must be an array of strings`);
          }
          if (ai.optional !== undefined && !validateStringArray(ai.optional)) {
            throw new Error(`Tool "${entry.name}" has invalid abilityInputs.optional — must be an array of strings`);
          }
          if (ai.validation !== undefined && typeof ai.validation !== 'string') {
            throw new Error(`Tool "${entry.name}" has invalid abilityInputs.validation — must be a string`);
          }
          if (ai.examples !== undefined && !validateStringArray(ai.examples)) {
            throw new Error(`Tool "${entry.name}" has invalid abilityInputs.examples — must be an array of strings`);
          }
        }
        if (entry.allowEmptyContent !== undefined && typeof entry.allowEmptyContent !== 'boolean') {
          throw new Error(`Tool "${entry.name}" has invalid allowEmptyContent — must be a boolean`);
        }
        if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') {
          throw new Error(`Tool "${entry.name}" has invalid enabled — must be a boolean`);
        }
        if (entry.retry !== undefined) {
          const r: ToolConfig['retry'] = entry.retry;
          if (typeof r !== 'object' || r === null || Array.isArray(r)) {
            throw new Error(`Tool "${entry.name}" has invalid retry — must be an object`);
          }
          if (r.enabled !== undefined && typeof r.enabled !== 'boolean') {
            throw new Error(`Tool "${entry.name}" has invalid retry.enabled — must be a boolean`);
          }
          if (r.maxRetries !== undefined) {
            if (typeof r.maxRetries !== 'number' || !Number.isInteger(r.maxRetries) || r.maxRetries < 0 || r.maxRetries > 10) {
              throw new Error(`Tool "${entry.name}" has invalid retry.maxRetries — must be an integer between 0 and 10`);
            }
          }
          if (r.model !== undefined && typeof r.model !== 'string') {
            throw new Error(`Tool "${entry.name}" has invalid retry.model — must be a string`);
          }
          if (r.prompt !== undefined && typeof r.prompt !== 'string') {
            throw new Error(`Tool "${entry.name}" has invalid retry.prompt — must be a string`);
          }
        }
        if (entry.builtin !== undefined && typeof entry.builtin !== 'boolean') {
          throw new Error(`Tool "${entry.name}" has invalid builtin — must be a boolean`);
        }
      }

      // Enforce: custom "help" tool is only allowed when the built-in help tool is disabled
      const helpTool = `${COMMAND_PREFIX}help`;
      const builtinHelp = tools.find(k => k.builtin && k.name.toLowerCase() === helpTool);
      const builtinHelpEnabled = builtinHelp ? builtinHelp.enabled !== false : false;
      if (builtinHelpEnabled) {
        const customHelpIndex = tools.findIndex(k => !k.builtin && k.name.toLowerCase() === helpTool);
        if (customHelpIndex !== -1) {
          throw new Error('Cannot save a custom "help" tool while the built-in help tool is enabled — disable the built-in help tool first');
        }
      }

      // Strip unknown/deprecated fields and build clean tool objects
      const cleanTools: ToolConfig[] = tools.map(entry => {
        const clean: ToolConfig = {
          name: entry.name,
          api: entry.api,
          timeout: entry.timeout,
          description: entry.description,
        };
        if (entry.abilityText) clean.abilityText = entry.abilityText;
        if (entry.abilityWhen) clean.abilityWhen = entry.abilityWhen;
        if (entry.abilityInputs) clean.abilityInputs = entry.abilityInputs;
        if (entry.parameters) clean.parameters = entry.parameters;
        if (entry.allowEmptyContent !== undefined) clean.allowEmptyContent = entry.allowEmptyContent;
        if (entry.enabled === false) clean.enabled = false;
        if (entry.retry) {
          // Whitelist known retry keys to prevent config drift from unknown properties.
          const r = entry.retry;
          const cleanRetry: ToolConfig['retry'] = {};
          if (r.enabled !== undefined) cleanRetry.enabled = r.enabled;
          if (r.maxRetries !== undefined) cleanRetry.maxRetries = r.maxRetries;
          if (r.model !== undefined) cleanRetry.model = r.model;
          if (r.prompt !== undefined) cleanRetry.prompt = r.prompt;
          if (Object.keys(cleanRetry).length > 0) clean.retry = cleanRetry;
        }
        if (entry.builtin) clean.builtin = true;
        return clean;
      });

      // Write to file as XML with backup and post-write validation
      const xmlContent = buildToolsXml(cleanTools);

      // Pre-write sanity check: verify the generated XML is parseable before touching disk
      parseToolsXml(xmlContent);

      const toolsFile = this.toolsPath;
      const backupFile = toolsFile + '.bak';

      // Step 1: Create backup of existing file (if it exists)
      if (fs.existsSync(toolsFile)) {
        fs.copyFileSync(toolsFile, backupFile);
      }

      // Step 2: Write the new content
      fs.writeFileSync(toolsFile, xmlContent, 'utf-8');

      // Step 3: Post-write validation — read back and parse to confirm integrity
      try {
        const written = fs.readFileSync(toolsFile, 'utf-8');
        parseToolsXml(written);
      } catch (validationErr) {
        // Dump the failing content and the pre-write XML for diagnostics
        const debugFile = toolsFile + '.debug';
        try {
          const written = fs.readFileSync(toolsFile, 'utf-8');
          fs.writeFileSync(debugFile, [
            `=== POST-WRITE VALIDATION FAILURE (${new Date().toISOString()}) ===`,
            `Error: ${validationErr instanceof Error ? validationErr.message : String(validationErr)}`,
            `File length: ${written.length} bytes`,
            `Pre-write XML length: ${xmlContent.length} bytes`,
            `Tools count: ${cleanTools.length}`,
            `\n=== FILE CONTENT (read back) ===\n${written}`,
            `\n=== PRE-WRITE XML (in-memory) ===\n${xmlContent}`,
          ].join('\n'), 'utf-8');
        } catch { /* best-effort diagnostic */ }

        // Restore from backup if validation fails
        if (fs.existsSync(backupFile)) {
          fs.copyFileSync(backupFile, toolsFile);
        }
        throw new Error(
          `tools.xml was written but failed re-parse validation — restored from backup. ` +
          `See ${path.basename(debugFile)} for diagnostics. ` +
          `Validation error: ${validationErr instanceof Error ? validationErr.message : String(validationErr)}`,
        );
      }
    } catch (error) {
      throw new Error(`Failed to update tools config: ${error}`, { cause: error });
    }
  }
}

export const configWriter = new ConfigWriter();
