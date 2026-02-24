import { XMLBuilder } from 'fast-xml-parser';
import { ToolConfig, AbilityInputs } from './config';
import type { ToolParameter } from './toolsXmlParser';

/**
 * Reserved element names within <parameters> that are metadata, not named params.
 */
const _RESERVED_PARAM_KEYS = new Set(['mode', 'inferFrom', 'validation', 'examples']);

/**
 * Build an XML string from an array of ToolConfig objects.
 *
 * Produces well-formed, indented XML matching the tools.default.xml schema:
 * - `name` → `<name>`
 * - `abilityInputs` + `parameters` → `<parameters>` (OpenAI-style)
 * - `description` → `<description>` (also serves as abilityText)
 *
 * @returns A complete XML document string with `<?xml?>` declaration.
 */
export function buildToolsXml(tools: ToolConfig[]): string {
  const toolElements = tools.map(buildToolObject);
  return renderXml({ tools: { tool: toolElements } });
}

/**
 * Convert a single ToolConfig to the plain-object representation
 * that XMLBuilder serialises into a `<tool>` element.
 *
 * Field ordering follows the canonical tools.default.xml layout:
 * name, api, timeout, description, builtin, enabled, allowEmptyContent,
 * abilityWhen, parameters, contextFilter*, retry.
 */
function buildToolObject(tc: ToolConfig): Record<string, unknown> {
  const obj: Record<string, unknown> = {};

  // Required fields
  obj.name = tc.name;
  obj.api = tc.api;
  obj.timeout = tc.timeout;
  obj.description = tc.description;

  // Optional flags — written only when meaningful (not default)
  if (tc.builtin) obj.builtin = true;
  if (tc.enabled === false) obj.enabled = false;
  if (tc.allowEmptyContent !== undefined) obj.allowEmptyContent = tc.allowEmptyContent;

  // Ability / model-facing
  if (tc.abilityWhen) obj.abilityWhen = tc.abilityWhen;

  // Parameters (prefer stored ToolParameter map for faithful round-trip,
  // fall back to reconstructing from abilityInputs).
  if (tc.parameters || tc.abilityInputs) {
    obj.parameters = buildParametersObject(tc.abilityInputs, tc.parameters);
  }

  // Context filter
  if (tc.contextFilterMinDepth !== undefined) obj.contextFilterMinDepth = tc.contextFilterMinDepth;
  if (tc.contextFilterMaxDepth !== undefined) obj.contextFilterMaxDepth = tc.contextFilterMaxDepth;

  // Retry
  if (tc.retry) {
    const r: Record<string, unknown> = {};
    if (tc.retry.enabled !== undefined) r.enabled = tc.retry.enabled;
    if (tc.retry.maxRetries !== undefined) r.maxRetries = tc.retry.maxRetries;
    if (tc.retry.model !== undefined) r.model = tc.retry.model;
    if (tc.retry.prompt !== undefined) r.prompt = tc.retry.prompt;
    if (Object.keys(r).length > 0) obj.retry = r;
  }

  return obj;
}

/**
 * Build the JS object for the `<parameters>` element.
 *
 * If a ToolParameter map is available (from a prior XML parse), we use it
 * directly so per-parameter descriptions survive the round-trip.
 * Otherwise we reconstruct from AbilityInputs (lossy — param descriptions
 * will be the param name only).
 */
function buildParametersObject(
  inputs?: AbilityInputs,
  paramMap?: Record<string, ToolParameter>,
): Record<string, unknown> {
  const obj: Record<string, unknown> = {};

  const mode = inputs?.mode ?? 'implicit';
  obj.mode = mode;

  // Named parameters
  if (paramMap && Object.keys(paramMap).length > 0) {
    // Use rich ToolParameter definitions
    for (const [name, param] of Object.entries(paramMap)) {
      obj[name] = {
        type: param.type,
        description: param.description,
        required: param.required,
      };
    }
  } else if (inputs) {
    // Reconstruct from legacy abilityInputs arrays
    if (inputs.required) {
      for (const name of inputs.required) {
        obj[name] = { type: 'string', description: name, required: true };
      }
    }
    if (inputs.optional) {
      for (const name of inputs.optional) {
        obj[name] = { type: 'string', description: name, required: false };
      }
    }
  }

  // Metadata fields (after named params for readability)
  if (inputs?.inferFrom && inputs.inferFrom.length > 0) {
    obj.inferFrom = inputs.inferFrom.join(', ');
  }
  if (inputs?.validation) {
    obj.validation = inputs.validation;
  }
  if (inputs?.examples && inputs.examples.length > 0) {
    obj.examples = { example: inputs.examples };
  }

  return obj;
}

/**
 * Render a JS object tree to a formatted XML string with declaration.
 */
function renderXml(obj: Record<string, unknown>): string {
  const builder = new XMLBuilder({
    format: true,
    indentBy: '  ',
    suppressEmptyNode: true,
    // Don't use attributes — everything is child elements
    ignoreAttributes: true,
  });

  const xmlBody = builder.build(obj) as string;
  return `<?xml version="1.0" encoding="UTF-8"?>\n${xmlBody}`;
}
