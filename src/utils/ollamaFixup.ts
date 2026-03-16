import { config, type ToolConfig } from './config';
import { resolveToolNameToTool } from './toolsSchema';
import type { OllamaToolCall } from '../api/ollamaClient';

/** Mutable context threaded through all fixup rules. */
export interface FixupContext {
  text: string;
  toolCalls: OllamaToolCall[];
  log: string[];
}

// ── Rule 1: Extract XML-wrapped tool calls ───────────────────

/**
 * Matches XML blocks like `<function_call>{ ... }</function_call>`,
 * `<tool_call>`, `<function>`, `<tool_use>`, etc.
 * Captures the inner content (expected to be JSON).
 */
const XML_TOOL_RE = /<(function_call|tool_call|function|tool_use)>\s*([\s\S]*?)\s*<\/\1>/gi;

/**
 * Parse XML-wrapped tool call blocks from response text.
 * Only runs when no native tool_calls exist.
 */
export function extractXmlToolCalls(ctx: FixupContext, tools: ToolConfig[]): void {
  if (ctx.toolCalls.length > 0) return;

  const matches = [...ctx.text.matchAll(XML_TOOL_RE)];
  if (matches.length === 0) return;

  for (const match of matches) {
    const inner = match[2];
    const parsed = tryParseToolJson(inner, tools);
    if (parsed) {
      ctx.toolCalls.push(parsed);
      ctx.text = ctx.text.replace(match[0], '');
      ctx.log.push(`FIXUP: extracted XML tool call "${parsed.function.name}" from <${match[1]}> block`);
    }
  }
}

// ── Rule 2: Extract bare JSON tool calls ─────────────────────

/**
 * Matches bare JSON objects containing "name" and "arguments" keys.
 * Greedy but bounded by brace matching.
 */
const JSON_TOOL_RE = /\{[^{}]*"name"\s*:\s*"[^"]+"\s*,\s*"arguments"\s*:\s*\{[^}]*\}[^{}]*\}/g;

/**
 * Find bare JSON tool objects in text.
 * Only runs when toolCalls is still empty after XML extraction.
 */
export function extractJsonToolCalls(ctx: FixupContext, tools: ToolConfig[]): void {
  if (ctx.toolCalls.length > 0) return;

  const matches = [...ctx.text.matchAll(JSON_TOOL_RE)];
  if (matches.length === 0) return;

  for (const match of matches) {
    const parsed = tryParseToolJson(match[0], tools);
    if (parsed) {
      ctx.toolCalls.push(parsed);
      ctx.text = ctx.text.replace(match[0], '');
      ctx.log.push(`FIXUP: extracted bare JSON tool call "${parsed.function.name}"`);
    }
  }
}

// ── Rule 3: Repair URLs ──────────────────────────────────────

/** Double-wrapped markdown links: [[text](url)](url) → [text](url) */
const DOUBLE_WRAP_LINK_RE = /\[(\[[^\]]*\]\([^)]+\))\]\([^)]+\)/g;

/** Double-bracketed URLs: [[url]] → url */
const DOUBLE_BRACKET_RE = /\[\[([^\]]+)\]\]/g;

/** Backtick-wrapped URLs: `http...` → http... */
const BACKTICK_URL_RE = /`(https?:\/\/[^`]+)`/g;

/** URLs missing protocol (bare www.) */
const MISSING_PROTOCOL_RE = /(?<![/\w])(www\.\S+)/gi;

/** Repair common URL malformations in text. */
export function repairUrls(ctx: FixupContext): void {
  const original = ctx.text;

  // Fix double-wrapped markdown links
  ctx.text = ctx.text.replace(DOUBLE_WRAP_LINK_RE, '$1');

  // Remove double brackets around URLs
  ctx.text = ctx.text.replace(DOUBLE_BRACKET_RE, '$1');

  // Unwrap backtick-wrapped URLs
  ctx.text = ctx.text.replace(BACKTICK_URL_RE, '$1');

  // Add missing https:// for www. URLs
  ctx.text = ctx.text.replace(MISSING_PROTOCOL_RE, 'https://$1');

  if (ctx.text !== original) {
    ctx.log.push('FIXUP: repaired URLs in response text');
  }
}

// ── Rule 4: Strip tool preamble ──────────────────────────────

const PREAMBLE_PHRASES = /\b(i'll|i will|let me|sure|of course|certainly|okay|alright|here you go|here is|i can|i'm going to)\b/i;

/**
 * When tool calls were extracted and the remaining text is short preamble,
 * clear it so the bot doesn't reply with "Sure, I'll do that" alongside
 * the tool result.
 */
export function stripToolPreamble(ctx: FixupContext): void {
  if (ctx.toolCalls.length === 0) return;

  const trimmed = ctx.text.trim();
  if (trimmed.length > 200) return;
  if (trimmed.length === 0) return;

  if (PREAMBLE_PHRASES.test(trimmed)) {
    ctx.log.push(`FIXUP: stripped preamble text "${trimmed.substring(0, 80)}"`);
    ctx.text = '';
  }
}

// ── Shared helpers ───────────────────────────────────────────

/**
 * Try to parse a JSON string as a tool call object { name, arguments }.
 * Validates the tool name against the provided tool registry.
 */
function tryParseToolJson(raw: string, tools: ToolConfig[]): OllamaToolCall | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }

  const name = typeof obj.name === 'string' ? obj.name.trim() : '';
  if (!name) return null;

  // Validate against known tools
  if (!resolveToolNameToTool(name, tools)) return null;

  let args: Record<string, unknown> = {};
  if (obj.arguments && typeof obj.arguments === 'object' && !Array.isArray(obj.arguments)) {
    args = obj.arguments as Record<string, unknown>;
  } else if (typeof obj.arguments === 'string') {
    try {
      args = JSON.parse(obj.arguments);
    } catch {
      args = {};
    }
  }

  return {
    type: 'function',
    function: { name, arguments: args },
  };
}

// ── Orchestrator ─────────────────────────────────────────────

/**
 * Apply all enabled fixup rules to the Ollama response.
 * Returns updated text, tool calls, and diagnostic log entries.
 */
export function applyFixups(
  text: string,
  toolCalls: OllamaToolCall[],
  tools: ToolConfig[],
): FixupContext {
  const ctx: FixupContext = {
    text,
    toolCalls: [...toolCalls],
    log: [],
  };

  if (!config.getOllamaFixupEnabled()) return ctx;

  if (config.getOllamaFixupExtractXmlTools()) {
    extractXmlToolCalls(ctx, tools);
  }

  if (config.getOllamaFixupExtractJsonTools()) {
    extractJsonToolCalls(ctx, tools);
  }

  if (config.getOllamaFixupRepairUrls()) {
    repairUrls(ctx);
  }

  if (config.getOllamaFixupStripToolPreamble()) {
    stripToolPreamble(ctx);
  }

  return ctx;
}
