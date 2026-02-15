/**
 * Activity page — privacy policy dialog behaviour tests.
 *
 * These tests parse the raw activity.html source to verify that:
 * 1. The privacy dialog is hidden by default (CSS).
 * 2. Content is fetched only when the user clicks the privacy link (lazy).
 * 3. Error / retry handling is present.
 * 4. No eager showModal() calls exist outside event handlers.
 */

import * as fs from 'fs';
import * as path from 'path';

// Read the HTML source exactly once for all tests in this suite.
const htmlPath = path.resolve(__dirname, '../src/public/activity.html');
const html = fs.readFileSync(htmlPath, 'utf-8');

// ── Helpers ────────────────────────────────────────────────────

/** Extract everything inside <style>…</style> (case-insensitive to satisfy CodeQL js/bad-tag-filter) */
function extractStyle(): string {
  const match = html.match(/<style>([\s\S]*?)<\/style>/i);
  return match ? match[1] : '';
}

/** Extract everything inside <script>…</script> (case-insensitive to satisfy CodeQL js/bad-tag-filter) */
function extractScript(): string {
  const match = html.match(/<script>([\s\S]*?)<\/script>/i);
  return match ? match[1] : '';
}

// ── CSS visibility ─────────────────────────────────────────────

describe('Privacy dialog — CSS visibility', () => {
  const css = extractStyle();

  it('defines dialog.policy-dialog[open] with display:flex', () => {
    // The [open] selector must be the one that enables flex layout
    expect(css).toMatch(/dialog\.policy-dialog\[open\]\s*\{[^}]*display:\s*flex/);
  });

  it('base dialog.policy-dialog does NOT set display:flex', () => {
    // Grab the base rule (no [open]) and ensure display:flex is absent.
    // We need to match the rule that does NOT have [open] after the selector.
    const baseRuleMatch = css.match(/dialog\.policy-dialog\s*\{([^}]*)\}/);
    expect(baseRuleMatch).not.toBeNull();
    const baseBody = baseRuleMatch![1];
    expect(baseBody).not.toMatch(/display:\s*flex/);
  });
});

// ── HTML structure ─────────────────────────────────────────────

describe('Privacy dialog — HTML structure', () => {
  it('dialog element exists with class policy-dialog', () => {
    expect(html).toMatch(/<dialog[^>]+class="policy-dialog"/);
  });

  it('dialog does NOT have the open attribute in markup', () => {
    // Ensure the <dialog> tag itself does not include `open`
    const dialogTag = html.match(/<dialog[^>]*class="policy-dialog"[^>]*>/);
    expect(dialogTag).not.toBeNull();
    expect(dialogTag![0]).not.toMatch(/\bopen\b/);
  });

  it('contains the privacy link trigger element', () => {
    expect(html).toContain('id="privacyLink"');
  });

  it('policy body starts with Loading text (only shown after click)', () => {
    expect(html).toMatch(/<div[^>]*id="policyBody"[^>]*>Loading/);
  });
});

// ── JavaScript behaviour ───────────────────────────────────────

describe('Privacy dialog — JS behaviour', () => {
  const script = extractScript();

  it('registers click handler on privacyLink', () => {
    expect(script).toContain("privacyLink.addEventListener('click'");
  });

  it('fetches /api/privacy-policy inside the load function', () => {
    expect(script).toContain("fetch('/api/privacy-policy')");
  });

  it('does NOT call policyDialog.showModal() at top-level init', () => {
    // showModal must only appear inside function bodies, not as a
    // standalone statement during initialisation.
    const lines = script.split('\n');
    const topLevelShowModal = lines.filter((line) => {
      const trimmed = line.trim();
      // Skip lines inside function definitions (indented or after `function`)
      return (
        trimmed === 'policyDialog.showModal();' &&
        !line.match(/^\s{4,}/) // not indented (top-level IIFE body is 2-space)
      );
    });
    expect(topLevelShowModal).toHaveLength(0);
  });

  it('tracks loading state to prevent duplicate fetches', () => {
    expect(script).toContain('policyLoading');
    // Must guard: if (policyLoading) return;
    expect(script).toMatch(/if\s*\(\s*policyLoading\s*\)\s*return/);
  });

  it('renders an error message with retry button on fetch failure', () => {
    expect(script).toContain('policyRetry');
    expect(script).toContain('renderPolicyError');
    // Retry must re-trigger the load
    expect(script).toContain('loadAndShowPolicy');
  });

  it('checks response.ok before processing response', () => {
    expect(script).toMatch(/if\s*\(\s*!res\.ok\s*\)/);
  });

  it('resets policyLoading via .finally()', () => {
    expect(script).toContain('.finally(');
    expect(script).toMatch(/policyLoading\s*=\s*false/);
  });
});
