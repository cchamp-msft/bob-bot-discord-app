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

// ── Rule 5: Fix tables for Discord ───────────────────────────

/**
 * Matches a markdown table: one or more `| ... |` rows with a separator
 * line of `| ---` between the header and body.
 *
 * Capture strategy: find contiguous runs of lines that start/end with `|`.
 */
const MD_TABLE_LINE_RE = /^\s*\|.*\|\s*$/;
const MD_SEPARATOR_RE  = /^\s*\|[\s:]*-+[\s:|-]*\|\s*$/;

/**
 * Detect a fenced code block that contains an ASCII-art table
 * (lines with `|` separators).  We fix column alignment inside those.
 */
const FENCED_BLOCK_RE = /```[^\n]*\n([\s\S]*?)```/g;

/** Split a `| a | b | c |` line into cell strings (trimmed). */
function splitTableRow(line: string): string[] {
  // Strip leading/trailing pipe and split on interior pipes
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map(c => c.trim());
}

/** Is this line a markdown separator row like `| --- | --- |`? */
function isSeparatorRow(line: string): boolean {
  return MD_SEPARATOR_RE.test(line);
}

/**
 * Render rows (string[][]) into a monospace text table with space-padded columns.
 * Returns the table without surrounding fences (caller adds those).
 */
function renderMonospaceTable(rows: string[][]): string {
  if (rows.length === 0) return '';

  // Determine max column count across all rows
  const colCount = Math.max(...rows.map(r => r.length));

  // Pad every row to have `colCount` columns
  const normalised = rows.map(r => {
    const padded = [...r];
    while (padded.length < colCount) padded.push('');
    return padded;
  });

  // Calculate max width per column
  const widths: number[] = Array.from({ length: colCount }, () => 0);
  for (const row of normalised) {
    for (let i = 0; i < colCount; i++) {
      widths[i] = Math.max(widths[i], row[i].length);
    }
  }

  // Render each row with fixed-width padding
  return normalised
    .map(row =>
      row.map((cell, i) => cell.padEnd(widths[i])).join('  ')
    )
    .join('\n');
}

/**
 * Convert markdown tables (pipe-delimited with separator row) to
 * monospace code blocks so they render properly on Discord.
 * Also normalises ASCII tables already inside ``` fences.
 */
export function fixTables(ctx: FixupContext): void {
  const original = ctx.text;

  // --- Pass 1: fix malformed ASCII tables inside existing code blocks ---
  ctx.text = ctx.text.replace(FENCED_BLOCK_RE, (_match, inner: string) => {
    const lines: string[] = inner.split('\n');
    // Only treat as a table if most lines contain pipes
    const pipeLines = lines.filter(l => l.includes('|') && l.trim().length > 0);
    if (pipeLines.length < 2) return _match;

    const rows: string[][] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      if (isSeparatorRow(trimmed)) continue;           // skip separator rows
      if (!trimmed.includes('|')) {
        // Non-table line inside the block — keep it as-is by treating as single-cell
        rows.push([trimmed]);
        continue;
      }
      rows.push(splitTableRow(trimmed));
    }

    if (rows.length === 0) return _match;
    return '```\n' + renderMonospaceTable(rows) + '\n```';
  });

  // --- Pass 2: convert bare markdown tables (not inside fences) to monospace blocks ---
  ctx.text = convertMarkdownTables(ctx.text);

  if (ctx.text !== original) {
    ctx.log.push('FIXUP: converted tables for Discord rendering');
  }
}

/**
 * Find contiguous runs of markdown table lines (header + separator + body rows)
 * that are NOT inside fenced code blocks, and replace each with a
 * fenced monospace block.
 */
function convertMarkdownTables(text: string): string {
  const lines = text.split('\n');
  const result: string[] = [];
  let i = 0;
  let inFence = false;

  while (i < lines.length) {
    // Track fenced code blocks so we don't double-convert
    if (/^\s*```/.test(lines[i])) {
      inFence = !inFence;
      result.push(lines[i]);
      i++;
      continue;
    }

    // Look for the start of a markdown table: a pipe-row followed by a separator row
    if (
      !inFence &&
      MD_TABLE_LINE_RE.test(lines[i]) &&
      i + 1 < lines.length &&
      isSeparatorRow(lines[i + 1])
    ) {
      // Collect all contiguous pipe-delimited rows
      const tableLines: string[] = [lines[i]];
      let j = i + 1;
      while (j < lines.length && MD_TABLE_LINE_RE.test(lines[j])) {
        tableLines.push(lines[j]);
        j++;
      }

      // Parse into rows, skipping separator lines
      const rows: string[][] = [];
      for (const tl of tableLines) {
        if (isSeparatorRow(tl)) continue;
        rows.push(splitTableRow(tl));
      }

      result.push('```');
      result.push(renderMonospaceTable(rows));
      result.push('```');
      i = j;
    } else {
      result.push(lines[i]);
      i++;
    }
  }

  return result.join('\n');
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

  if (config.getOllamaFixupFixTables()) {
    fixTables(ctx);
  }

  return ctx;
}
