import { XMLParser } from 'fast-xml-parser';
import { KeywordConfig, AbilityInputs } from './config';

/**
 * Reserved element names within <parameters> that are NOT named tool parameters.
 * These are metadata fields that map to AbilityInputs properties.
 */
const RESERVED_PARAM_KEYS = new Set(['mode', 'inferFrom', 'validation', 'examples']);

/**
 * Represents a single named parameter in the OpenAI-style XML format.
 * Stored on KeywordConfig.parameters for faithful XML round-trip.
 */
export interface ToolParameter {
  type: string;
  description: string;
  required: boolean;
}

/**
 * Parse an XML tools configuration string into an array of KeywordConfig objects.
 *
 * The XML format uses `<tool>` elements with `<name>` instead of `keyword`,
 * `<parameters>` with OpenAI-style named children instead of `abilityInputs`,
 * and `<description>` serving double duty as both description and abilityText.
 *
 * @throws Error if the XML is malformed or missing required fields
 */
export function parseToolsXml(xmlContent: string): KeywordConfig[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    // Preserve tag value types — booleans and numbers should not auto-convert
    // because we validate types explicitly below.
    parseTagValue: false,
    // Always wrap these in arrays even if there's only one element,
    // so we get consistent iteration.
    isArray: (name: string) => name === 'tool' || name === 'example',
    // Preserve whitespace in text content (descriptions, validation, etc.)
    trimValues: true,
  });

  let parsed: Record<string, unknown>;
  try {
    parsed = parser.parse(xmlContent);
  } catch (err) {
    throw new Error(`tools.xml: Failed to parse XML — ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }

  const tools = parsed.tools as Record<string, unknown> | undefined;
  if (!tools) {
    throw new Error('tools.xml: Missing root <tools> element');
  }

  const toolArray = (tools as Record<string, unknown>).tool;
  if (!Array.isArray(toolArray)) {
    throw new Error('tools.xml: <tools> must contain at least one <tool> element');
  }

  return toolArray.map((raw: Record<string, unknown>, index: number) => {
    return parseToolElement(raw, index);
  });
}

/**
 * Parse a single <tool> element into a KeywordConfig.
 */
function parseToolElement(raw: Record<string, unknown>, index: number): KeywordConfig {
  // Required fields
  const name = raw.name;
  if (!name || typeof name !== 'string') {
    throw new Error(`tools.xml: <tool> at index ${index} is missing <name>`);
  }

  const api = raw.api;
  const validApis = ['comfyui', 'ollama', 'accuweather', 'nfl', 'serpapi', 'meme'];
  if (!api || typeof api !== 'string' || !validApis.includes(api)) {
    throw new Error(`tools.xml: tool "${name}" has invalid <api> "${api}" — must be one of: ${validApis.join(', ')}`);
  }

  const timeout = Number(raw.timeout);
  if (!raw.timeout || isNaN(timeout) || timeout <= 0) {
    throw new Error(`tools.xml: tool "${name}" has invalid <timeout> — must be a positive number`);
  }

  const description = raw.description;
  if (!description || typeof description !== 'string') {
    throw new Error(`tools.xml: tool "${name}" is missing <description>`);
  }

  const kw: KeywordConfig = {
    keyword: String(name),
    api: api as KeywordConfig['api'],
    timeout,
    description: String(description),
    // description doubles as abilityText for model-facing prompts
    abilityText: String(description),
  };

  // Optional simple fields
  if (raw.abilityWhen !== undefined) {
    kw.abilityWhen = String(raw.abilityWhen);
  }
  if (raw.finalOllamaPass !== undefined) {
    kw.finalOllamaPass = parseBool(raw.finalOllamaPass, `tool "${name}" <finalOllamaPass>`);
  }
  if (raw.allowEmptyContent !== undefined) {
    kw.allowEmptyContent = parseBool(raw.allowEmptyContent, `tool "${name}" <allowEmptyContent>`);
  }
  if (raw.enabled !== undefined) {
    kw.enabled = parseBool(raw.enabled, `tool "${name}" <enabled>`);
  }
  if (raw.builtin !== undefined) {
    kw.builtin = parseBool(raw.builtin, `tool "${name}" <builtin>`);
  }

  // Context filter fields
  if (raw.contextFilterEnabled !== undefined) {
    kw.contextFilterEnabled = parseBool(raw.contextFilterEnabled, `tool "${name}" <contextFilterEnabled>`);
  }
  if (raw.contextFilterMinDepth !== undefined) {
    const v = Number(raw.contextFilterMinDepth);
    if (isNaN(v) || v < 1 || !Number.isInteger(v)) {
      throw new Error(`tools.xml: tool "${name}" has invalid <contextFilterMinDepth> — must be a positive integer (>= 1)`);
    }
    kw.contextFilterMinDepth = v;
  }
  if (raw.contextFilterMaxDepth !== undefined) {
    const v = Number(raw.contextFilterMaxDepth);
    if (isNaN(v) || !Number.isInteger(v)) {
      throw new Error(`tools.xml: tool "${name}" has invalid <contextFilterMaxDepth> — must be an integer`);
    }
    kw.contextFilterMaxDepth = v;
  }

  // Retry block
  if (raw.retry !== undefined) {
    const r = raw.retry as Record<string, unknown>;
    if (typeof r !== 'object' || r === null) {
      throw new Error(`tools.xml: tool "${name}" has invalid <retry> — must contain child elements`);
    }
    const retry: KeywordConfig['retry'] = {};
    if (r.enabled !== undefined) retry.enabled = parseBool(r.enabled, `tool "${name}" <retry><enabled>`);
    if (r.maxRetries !== undefined) {
      const v = Number(r.maxRetries);
      if (isNaN(v) || !Number.isInteger(v) || v < 0 || v > 10) {
        throw new Error(`tools.xml: tool "${name}" has invalid <retry><maxRetries> — must be an integer between 0 and 10`);
      }
      retry.maxRetries = v;
    }
    if (r.model !== undefined) retry.model = String(r.model);
    if (r.prompt !== undefined) retry.prompt = String(r.prompt);
    kw.retry = retry;
  }

  // Parameters → abilityInputs mapping
  if (raw.parameters !== undefined) {
    const { abilityInputs, parameters } = parseParametersElement(
      raw.parameters as Record<string, unknown>,
      name as string,
    );
    kw.abilityInputs = abilityInputs;
    kw.parameters = parameters;
  }

  return kw;
}

/**
 * Parse a <parameters> element into both the legacy AbilityInputs format
 * (for backward-compatible consumption) and a ToolParameter map (for
 * faithful XML round-trip).
 */
function parseParametersElement(
  raw: Record<string, unknown>,
  toolName: string,
): { abilityInputs: AbilityInputs; parameters: Record<string, ToolParameter> } {
  // Mode (required within parameters)
  const modeStr = raw.mode;
  const validModes = ['implicit', 'explicit', 'mixed'];
  if (!modeStr || !validModes.includes(String(modeStr))) {
    throw new Error(
      `tools.xml: tool "${toolName}" <parameters> has invalid <mode> "${modeStr}" — must be "implicit", "explicit", or "mixed"`,
    );
  }
  const mode = String(modeStr) as AbilityInputs['mode'];

  const abilityInputs: AbilityInputs = { mode };
  const paramMap: Record<string, ToolParameter> = {};

  // Extract reserved metadata fields
  if (raw.inferFrom !== undefined) {
    const inferStr = String(raw.inferFrom);
    abilityInputs.inferFrom = inferStr.split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (raw.validation !== undefined) {
    abilityInputs.validation = String(raw.validation);
  }

  // Examples
  if (raw.examples !== undefined) {
    const exBlock = raw.examples as Record<string, unknown>;
    if (exBlock && typeof exBlock === 'object' && exBlock.example !== undefined) {
      const examples = Array.isArray(exBlock.example)
        ? (exBlock.example as unknown[]).map(String)
        : [String(exBlock.example)];
      abilityInputs.examples = examples;
    }
  }

  // Extract named parameters (everything that's not a reserved key)
  const requiredParams: string[] = [];
  const optionalParams: string[] = [];

  for (const [key, value] of Object.entries(raw)) {
    if (RESERVED_PARAM_KEYS.has(key)) continue;
    if (typeof value !== 'object' || value === null) continue;

    const paramDef = value as Record<string, unknown>;
    // Must look like a parameter definition (has at least description or required)
    if (paramDef.description === undefined && paramDef.required === undefined && paramDef.type === undefined) {
      continue;
    }

    const isRequired = parseBool(
      paramDef.required ?? false,
      `tool "${toolName}" parameter "${key}" <required>`,
    );

    paramMap[key] = {
      type: String(paramDef.type ?? 'string'),
      description: String(paramDef.description ?? key),
      required: isRequired,
    };

    if (isRequired) {
      requiredParams.push(key);
    } else {
      optionalParams.push(key);
    }
  }

  if (requiredParams.length > 0) abilityInputs.required = requiredParams;
  if (optionalParams.length > 0) abilityInputs.optional = optionalParams;

  return { abilityInputs, parameters: paramMap };
}

/**
 * Parse a value that should be boolean from XML text content.
 * XML text is always a string, so "true"/"false" need conversion.
 */
function parseBool(value: unknown, context: string): boolean {
  if (typeof value === 'boolean') return value;
  const str = String(value).toLowerCase().trim();
  if (str === 'true') return true;
  if (str === 'false') return false;
  throw new Error(`tools.xml: ${context} must be "true" or "false", got "${value}"`);
}
