import type { KeywordConfig } from './config';

/** Keywords that are internal-only (e.g. !help, !activity_key). Not sent to Ollama as tools. */
const INTERNAL_ONLY_KEYWORDS = new Set(['help', 'activity_key']);

function isInternalOnlyKeyword(keyword: string): boolean {
  const normalized = keyword.replace(/^!\s*/, '').trim().toLowerCase();
  return INTERNAL_ONLY_KEYWORDS.has(normalized);
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
 * Build OpenAI-compatible tool definitions from keyword config for Ollama's native tools.
 * Excludes internal-only tools (help, activity_key) and non-routable keywords
 * (disabled, builtin, api === 'ollama').
 *
 * @param keywords - Full keyword list (e.g. from config).
 * @returns Tool definitions suitable for the `tools` parameter of /api/chat.
 */
export function buildOllamaToolsSchema(keywords: KeywordConfig[]): OllamaTool[] {
  const filtered = keywords.filter(
    (k) =>
      k.enabled !== false &&
      !k.builtin &&
      k.api !== 'ollama' &&
      !isInternalOnlyKeyword(k.keyword)
  );

  const seen = new Set<string>();
  const tools: OllamaTool[] = [];

  for (const k of filtered) {
    const name = k.keyword.replace(/^!\s*/, '').trim().toLowerCase();
    if (seen.has(name)) continue;
    seen.add(name);

    const description = k.abilityText ?? k.description;
    const params = buildParameters(k);
    tools.push({
      type: 'function',
      function: {
        name,
        description,
        parameters: params,
      },
    });
  }

  return tools;
}

function buildParameters(keywordConfig: KeywordConfig): OllamaTool['function']['parameters'] {
  const props: Record<string, { type: 'string'; description?: string }> = {};
  const required: string[] = [];
  const ai = keywordConfig.abilityInputs;

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
 * Resolve a tool name (as returned by Ollama) back to the keyword config.
 * Tool name is the keyword normalized (no !, lowercased). First match wins.
 */
export function resolveToolNameToKeyword(
  toolName: string,
  keywords: KeywordConfig[]
): KeywordConfig | undefined {
  const normalized = toolName.replace(/^!\s*/, '').trim().toLowerCase();
  return keywords.find(
    (k) =>
      k.enabled !== false &&
      !k.builtin &&
      k.api !== 'ollama' &&
      !isInternalOnlyKeyword(k.keyword) &&
      k.keyword.replace(/^!\s*/, '').trim().toLowerCase() === normalized
  );
}

/**
 * Convert tool call arguments (from Ollama) to the single content string
 * expected by executeRoutedRequest / apiManager.executeRequest per API.
 */
export function toolArgumentsToContent(
  keywordConfig: KeywordConfig,
  args: Record<string, unknown>
): string {
  const get = (key: string): string =>
    typeof args[key] === 'string' ? (args[key] as string).trim() : '';

  switch (keywordConfig.api) {
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
      const kw = keywordConfig.keyword.toLowerCase();
      if (kw.includes('news')) return get('filter') || get('input') || '';
      return get('date') || get('input') || '';
    }
    case 'meme': {
      const template = get('templateId') || get('template') || get('templateName');
      const top = get('top') || get('top_text') || '';
      const bottom = get('bottom') || get('bottom_text') || '';
      if (template && (top || bottom)) return `${template} | ${top} | ${bottom}`;
      return get('input') || '';
    }
    default:
      return get('input') || get('content') || Object.values(args).filter(v => typeof v === 'string').join(' ') || '';
  }
}
