import type { ToolConfig } from './config';
import type { LlmProvider } from '../types';

/** Tool names that are internal-only (e.g. !help, !activity_key). Not sent to Ollama as tools. */
const INTERNAL_ONLY_TOOLS = new Set(['help', 'activity_key']);

/** Tools only available when the provider is Ollama (blocked from xAI). */
const OLLAMA_ONLY_TOOLS = new Set(['consult_grok']);

/** Tools only available when the provider is xAI (blocked from Ollama). */
const XAI_ONLY_TOOLS = new Set(['delegate_to_local']);

function isInternalOnlyTool(name: string): boolean {
  const normalized = name.replace(/^!\s*/, '').trim().toLowerCase();
  return INTERNAL_ONLY_TOOLS.has(normalized);
}

/**
 * OpenAI-style tool definition for Ollama /api/chat tools parameter.
 * @see https://github.com/ollama/ollama/blob/main/docs/capabilities/tool-calling.md
 */
export interface OllamaTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, { type: 'string'; description?: string }>;
      required?: string[];
    };
  };
}

/**
 * Check whether a tool name is restricted to a specific provider.
 * Returns true if the tool should be excluded for the given provider.
 */
function isProviderRestricted(name: string, provider?: LlmProvider): boolean {
  const normalized = name.replace(/^!\s*/, '').trim().toLowerCase();
  if (provider === 'xai' && OLLAMA_ONLY_TOOLS.has(normalized)) return true;
  if (provider === 'ollama' && XAI_ONLY_TOOLS.has(normalized)) return true;
  return false;
}

/**
 * Build OpenAI-compatible tool definitions from tool config for native tools.
 * Excludes internal-only tools (help, activity_key) and non-routable
 * tools (disabled, builtin, api === 'ollama').
 * When a provider is specified, also excludes tools restricted to the other provider.
 *
 * @param tools - Full tool list (e.g. from config).
 * @param provider - Optional LLM provider to filter provider-restricted tools.
 * @returns Tool definitions suitable for the `tools` parameter of /api/chat.
 */
export function buildOllamaToolsSchema(tools: ToolConfig[], provider?: LlmProvider): OllamaTool[] {
  const filtered = tools.filter(
    (k) =>
      k.enabled !== false &&
      !k.builtin &&
      k.api !== 'ollama' &&
      !isInternalOnlyTool(k.name) &&
      !isProviderRestricted(k.name, provider)
  );

  const seen = new Set<string>();
  const result: OllamaTool[] = [];

  for (const k of filtered) {
    const name = k.name.replace(/^!\s*/, '').trim().toLowerCase();
    if (seen.has(name)) continue;
    seen.add(name);

    const description = k.abilityText ?? k.description;
    const params = buildParameters(k);
    result.push({
      type: 'function',
      function: {
        name,
        description,
        parameters: params,
      },
    });
  }

  return result;
}

function buildParameters(toolConfig: ToolConfig): OllamaTool['function']['parameters'] {
  const props: Record<string, { type: 'string'; description?: string }> = {};
  const required: string[] = [];
  const ai = toolConfig.abilityInputs;

  if (!ai) {
    props.input = {
      type: 'string',
      description: 'User message or context-derived input for this tool.',
    };
    return { type: 'object', properties: props };
  }

  const descParts: string[] = [];
  if (ai.validation) descParts.push(ai.validation);
  if (ai.examples && ai.examples.length > 0) {
    descParts.push(`Examples: ${ai.examples.join('; ')}`);
  }
  const defaultDesc = descParts.length > 0 ? descParts.join(' ') : undefined;

  if (ai.required && ai.required.length > 0) {
    for (const name of ai.required) {
      const key = name.trim();
      if (!key) continue;
      props[key] = { type: 'string', description: defaultDesc };
      required.push(key);
    }
  }

  if (ai.optional && ai.optional.length > 0) {
    for (const name of ai.optional) {
      const key = name.trim();
      if (!key || props[key]) continue;
      props[key] = { type: 'string', description: defaultDesc };
    }
  }

  if (Object.keys(props).length === 0) {
    props.input = {
      type: 'string',
      description: defaultDesc ?? 'User message or context-derived input.',
    };
  }

  return {
    type: 'object',
    properties: props,
    ...(required.length > 0 ? { required } : {}),
  };
}

/**
 * Resolve a tool name (as returned by the LLM) back to the tool config.
 * Tool name is the name normalized (no !, lowercased). First match wins.
 * When a provider is specified, tools restricted to the other provider are excluded.
 */
export function resolveToolNameToTool(
  toolName: string,
  tools: ToolConfig[],
  provider?: LlmProvider
): ToolConfig | undefined {
  const normalized = toolName.replace(/^!\s*/, '').trim().toLowerCase();
  return tools.find(
    (k) =>
      k.enabled !== false &&
      !k.builtin &&
      k.api !== 'ollama' &&
      !isInternalOnlyTool(k.name) &&
      !isProviderRestricted(k.name, provider) &&
      k.name.replace(/^!\s*/, '').trim().toLowerCase() === normalized
  );
}

/**
 * Convert tool call arguments (from Ollama) to the single content string
 * expected by executeRoutedRequest / apiManager.executeRequest per API.
 */
export function toolArgumentsToContent(
  toolConfig: ToolConfig,
  args: Record<string, unknown>
): string {
  const get = (key: string): string =>
    typeof args[key] === 'string' ? (args[key] as string).trim() : '';

  switch (toolConfig.api) {
    case 'accuweather':
      return get('location') || get('input') || '';
    case 'comfyui': {
      const prompt = get('prompt') || get('input') || '';
      const negative = get('negative_prompt');
      return negative ? `${prompt}\n--negative: ${negative}` : prompt;
    }
    case 'serpapi':
      return get('query') || get('input') || '';
    case 'nfl': {
      const name = toolConfig.name.toLowerCase();
      if (name.includes('news')) return get('filter') || get('input') || '';
      return get('date') || get('input') || '';
    }
    case 'meme': {
      const combined = get('template_and_text');
      if (combined) return combined;
      const template = get('templateId') || get('template') || get('templateName');
      const top = get('top') || get('top_text') || '';
      const bottom = get('bottom') || get('bottom_text') || '';
      if (template && (top || bottom)) return `${template} | ${top} | ${bottom}`;
      return get('input') || '';
    }
    case 'discord':
      return JSON.stringify(args);
    default:
      return get('input') || get('content') || Object.values(args).filter(v => typeof v === 'string').join(' ') || '';
  }
}
