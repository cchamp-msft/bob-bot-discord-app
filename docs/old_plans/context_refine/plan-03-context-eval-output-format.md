# Plan 03 — Context evaluation output format (bracket-array) confirmation

## Goal
5) Confirm whether **JSON array selection** (bracket notation like `[1, 2, 4]`) is the best method for context evaluation, and decide if this needs separate work.

## Current behavior (as implemented)
- `src/utils/contextEvaluator.ts` instructs:
  - “Respond with ONLY a JSON array of integer indices — e.g. `[1, 2, 4]`.”
- `parseEvalResponse()`:
  - first attempts `JSON.parse()` expecting an integer array
  - enforces `minDepth` by injecting indices `1..minDepth`
  - enforces `maxDepth` by truncating
  - has a legacy fallback: parse a single integer meaning “keep most recent N”

## Assessment
The bracket-array approach is **appropriate and likely best** for this intent because:
- it’s strict, machine-parseable, and language-model-friendly
- it’s widely supported across models (JSON arrays are a common “structured output” primitive)
- your parser already validates range, dedupes, and enforces min/max constraints

So: this does **not** need a large separate plan, but it does benefit from a small hardening pass.

## Proposed improvements (small, targeted)
1) **Harden parsing against common wrappers**
   - Some models wrap JSON in code fences (```json … ```), add leading/trailing commentary, or emit trailing commas.
   - Add a pre-parse “extract first JSON array substring” step:
     - find first `[` and matching `]` and attempt `JSON.parse()` on that slice
     - keep existing strictness; only accept an int array

2) **Update evaluator prompt for source-based tags**
   - This will happen as part of Plan 01.

3) **Add tests**
   - Extend `tests/contextEvaluator.test.ts` to cover:
     - exact array: `[1,2,4]`
     - fenced array: ```json\n[1,2]\n```
     - extra text: `Selected: [1,2]`
     - invalid values: `[0, 999, "2"]` (should reject or filter as per current logic)

## Acceptance criteria
- Context-eval works unchanged for “clean” JSON arrays.
- Context-eval becomes more robust to minor model formatting variance.
- No behavior change in min/max enforcement.

## If you *want* a separate bigger initiative
Only needed if you want to move to a richer output (e.g., “selected indices + per-index reason”), which would:
- increase prompt/response size
- complicate parsing
- provide limited runtime benefit for the current architecture

Recommendation: keep the bracket-array output.
