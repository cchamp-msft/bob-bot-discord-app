/**
 * Configurator — Keywords view UI behaviour tests.
 *
 * These tests parse the raw configurator.html source to verify that:
 * 1. Keyword detail rows are collapsed by default (no auto-open).
 * 2. Visual separators exist between keyword entry groups.
 * 3. Ctx Depth Min/Max are rendered as two stacked rows.
 */

import * as fs from 'fs';
import * as path from 'path';

const htmlPath = path.resolve(__dirname, '../src/public/configurator.html');
const html = fs.readFileSync(htmlPath, 'utf-8');

// ── Helpers ────────────────────────────────────────────────────

/** Extract everything inside <style>…</style> */
function extractStyle(): string {
  const match = html.match(/<style>([\s\S]*?)<\/style>/i);
  return match ? match[1] : '';
}

/** Extract everything inside <script>…</script> (last match — the main app script) */
function extractScript(): string {
  const matches = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)];
  // The main application script is the last/largest <script> block
  return matches.length > 0 ? matches[matches.length - 1][1] : '';
}

// ── Detail rows: collapsed by default ─────────────────────────

describe('Keywords — detail rows collapsed by default', () => {
  const script = extractScript();

  it('does NOT auto-add the "open" class to detail rows based on hasDetails', () => {
    // The old code was: detailTr.className = 'kw-details-row' + (hasDetails ? ' open' : '');
    // The new code must set className to just 'kw-details-row' unconditionally.
    expect(script).toContain("detailTr.className = 'kw-details-row'");
    // Must NOT contain the conditional open pattern
    expect(script).not.toMatch(/detailTr\.className\s*=\s*['"]kw-details-row['"]\s*\+/);
  });

  it('does NOT auto-set expand button text to expanded state', () => {
    // The old code changed the button to '▾' when hasDetails was true.
    // That block should no longer exist.
    expect(script).not.toMatch(/kw-expand-btn.*textContent\s*=\s*['"]▾['"]/);
    // Except inside toggleKwDetails which is the user-driven toggle
    const toggleFn = script.match(/function toggleKwDetails[\s\S]*?\n\s{2}\}/);
    expect(toggleFn).not.toBeNull();
    // The toggle function itself should still reference '▾' for the open state
    expect(toggleFn![0]).toContain('▾');
  });

  it('CSS hides .kw-details-row by default and shows when .open', () => {
    const css = extractStyle();
    expect(css).toMatch(/\.kw-details-row\s*\{\s*display:\s*none/);
    expect(css).toMatch(/\.kw-details-row\.open\s*\{\s*display:\s*table-row/);
  });
});

// ── Visual separators between keyword entries ──────────────────

describe('Keywords — visual separators', () => {
  const css = extractStyle();
  const script = extractScript();

  it('defines a CSS rule for keyword row separators', () => {
    // The separator class should apply a visible border
    expect(css).toMatch(/\.kw-separator-top[\s\S]*?border-top/);
  });

  it('addKeywordRow applies the separator class to non-first rows', () => {
    // The script must add the separator class when tbody already has children
    expect(script).toContain('kw-separator-top');
    expect(script).toMatch(/tbody\.children\.length\s*>\s*0/);
  });
});

// ── Ctx Depth Min/Max: two-row stacked layout ─────────────────

describe('Keywords — Ctx Depth two-row layout', () => {
  const script = extractScript();
  const css = extractStyle();

  it('renders Min and Max as separate kw-ctx-row elements', () => {
    // Each row should be its own .kw-ctx-row span
    const minRow = script.match(/kw-ctx-row.*kw-ctx-label.*Min.*kw-ctxMin/);
    const maxRow = script.match(/kw-ctx-row.*kw-ctx-label.*Max.*kw-ctxMax/);
    expect(minRow).not.toBeNull();
    expect(maxRow).not.toBeNull();
  });

  it('uses the stacked container class for vertical layout', () => {
    expect(script).toContain('kw-ctx-depth-stacked');
  });

  it('CSS defines stacked layout for .kw-ctx-depth-stacked', () => {
    expect(css).toMatch(/\.kw-ctx-depth-stacked\s*\{[^}]*flex-direction:\s*column/);
  });

  it('CSS defines row layout for .kw-ctx-row', () => {
    expect(css).toMatch(/\.kw-ctx-row\s*\{[^}]*display:\s*flex/);
  });
});
