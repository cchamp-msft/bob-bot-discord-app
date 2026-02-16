/**
 * Configurator — Section structure & rendering tests.
 *
 * These tests parse the raw configurator.html source to verify that:
 * 1. ComfyUI and Ollama are separate top-level collapsible sections.
 * 2. "Include Embed in Image Responses" is located in the ComfyUI section.
 * 3. The Limits section does NOT contain the embed toggle.
 * 4. Mermaid diagrams are rendered on section expand (not on initial load).
 */

import * as fs from 'fs';
import * as path from 'path';

const htmlPath = path.resolve(__dirname, '../src/public/configurator.html');
const html = fs.readFileSync(htmlPath, 'utf-8');

/** Extract everything inside <style>…</style> */
function extractStyle(): string {
  const match = html.match(/<style>([\s\S]*?)<\/style>/i);
  return match ? match[1] : '';
}

/** Extract everything inside <script>…</script> (last match — the main app script) */
function extractScript(): string {
  const matches = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)];
  return matches.length > 0 ? matches[matches.length - 1][1] : '';
}

/**
 * Extract all top-level <section>…</section> blocks from the HTML body.
 * Returns an array of { heading, body } objects.
 */
function extractSections(): { heading: string; body: string }[] {
  const sectionRegex = /<section>\s*<h2[^>]*>([\s\S]*?)<\/h2>\s*<div class="body[^"]*">([\s\S]*?)<\/div>\s*<\/section>/g;
  const sections: { heading: string; body: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = sectionRegex.exec(html)) !== null) {
    sections.push({ heading: m[1].trim(), body: m[2] });
  }
  return sections;
}

// ── ComfyUI and Ollama are separate top-level sections ────────

describe('Configurator — section structure', () => {
  const sections = extractSections();
  const headings = sections.map(s => s.heading);

  it('has a top-level ComfyUI section', () => {
    expect(headings).toContain('ComfyUI');
  });

  it('has a top-level Ollama section', () => {
    expect(headings).toContain('Ollama');
  });

  it('does NOT have a combined "API Endpoints" section', () => {
    expect(headings).not.toContain('API Endpoints');
  });
});

// ── Embed toggle is in ComfyUI, not Limits ────────────────────

describe('Configurator — embed toggle placement', () => {
  const sections = extractSections();

  it('the ComfyUI section contains the embed toggle', () => {
    const comfyui = sections.find(s => s.heading === 'ComfyUI');
    expect(comfyui).toBeDefined();
    expect(comfyui!.body).toContain('image_response_include_embed');
  });

  it('the Limits section does NOT contain the embed toggle', () => {
    const limits = sections.find(s => s.heading === 'Limits');
    expect(limits).toBeDefined();
    expect(limits!.body).not.toContain('image_response_include_embed');
  });
});

// ── Mermaid render-on-expand ──────────────────────────────────

describe('Configurator — Mermaid render on expand', () => {
  const script = extractScript();

  it('initializes mermaid with startOnLoad disabled', () => {
    expect(script).toMatch(/mermaid\.initialize\(\s*\{[^}]*startOnLoad:\s*false/);
  });

  it('toggleSection triggers mermaid.run for unprocessed diagrams', () => {
    expect(script).toContain('mermaid.run');
    // Should target un-rendered pre.mermaid elements
    expect(script).toMatch(/pre\.mermaid:not\(\[data-processed\]\)/);
  });
});
