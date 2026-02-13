# Plan 02 — Abilities prompt: params inference + validation (uniform)

## Goals
2) Clarify the internal abilities prompt for **abilities without parameters**: parameters are inferred from context.
3) Clarify the internal abilities prompt for **abilities with parameters**: require validation that parameters are present or can be confidently inferred.
4) Implement #2 and #3 uniformly via the abilities prompt directive, and clarify how to describe/use an ability (and whether we need a separate “when to use”).

## Current behavior (as implemented)
- `src/utils/promptBuilder.ts` generates a system abilities block:
  - `- keyword → abilityText ?? description`
- Routing rule is binary:
  - if fresh external data required → output ONLY the keyword on its own line
  - otherwise answer normally
- Keyword config currently supports:
  - `description`, optional `abilityText`, `allowEmptyContent`, etc. (`src/utils/config.ts`, `config/keywords.json`)
- Parameter handling today is mostly implicit:
  - APIs receive the “content” string (user’s message after stripping keyword if explicitly invoked)
  - Some keywords allow empty content (`allowEmptyContent`)

## Problem statement
We have two “instantiations” of abilities:
- **Implicit-input** abilities (no explicit params): “use the best available prompt from context”. Example: `imagine` used as a reply should use the replied-to message (or most recent relevant text) as the image prompt.
- **Explicit-params** abilities: require a parameter string/value (e.g., `weather <location>`, `nfl scores <date?>`, `search <query>`).

The model needs clear, uniform instructions for:
- what the ability does
- when it should be used
- what inputs it needs
- how inputs can be inferred
- when it must ask a clarifying question instead of invoking

## Proposed end state
### Add explicit “ability directive” fields to KeywordConfig
Extend `KeywordConfig` (and validate in `config.ts`) with model-facing fields; keep `description` as human-facing.

Proposed fields (minimal but expressive):
- `abilityText`: *what it does* (already exists)
- `abilityWhen`: *when to use it* (new)
- `abilityInputs` (new): structured guidance for inference/validation
  - `mode`: `implicit` | `explicit` | `mixed`
  - `required`: list of required inputs (can be empty)
  - `optional`: list of optional inputs
  - `inferFrom`: allowed sources (e.g., `reply_target`, `current_message`, `recent_user_message`)
  - `validation`: plain-language constraints (e.g., “date must be YYYY-MM-DD or YYYYMMDD”)
  - `examples`: 1–2 short usage examples

Notes:
- Keep these fields optional initially to avoid breaking existing keywords.
- Default behavior when fields are absent:
  - treat as `explicit` with “use the user’s current question content as input”.

### Update prompt rendering: separate “what / when / inputs”
Replace the current one-liner `- keyword → text` with a compact, uniform schema-like list.

Example (prompt form):
- `imagine`
  - What: Generate an image via ComfyUI.
  - When: User wants an image generated.
  - Inputs: Implicit.
    - Use reply target text if present; else use current message text.
    - If no usable text, ask the user for an image prompt.

- `weather`
  - What: Current conditions and forecast.
  - When: User asks about weather.
  - Inputs: Explicit.
    - Required: location.
    - Validation: must be a city/postal or use default location if configured and user didn’t specify.
    - If location missing and no default, ask a clarifying question.

### Enforce a uniform “invoke vs clarify” policy
Update the system rules so the model:
- invokes an ability **only if** required parameters are present or can be inferred per `abilityInputs`
- otherwise asks a brief follow-up question instead of outputting a keyword

This directly addresses #3 “offering some validation as inferred from the abilities directive”.

### Clarify `description` vs `abilityText`
- `description`: user-facing help text (shown in `/help`, docs)
- `abilityText`: model-facing “what” text (can be shorter or more directive)
- `abilityWhen`: model-facing “when” text (new)

Yes: a separate “when” field is useful; it reduces ambiguity and prevents ability overuse.

## Implementation steps
1) **Config schema extension**
   - Extend `KeywordConfig` in `src/utils/config.ts`.
   - Update `loadKeywords()` validation for new fields.
   - Update `config/keywords.json` incrementally (start with 2–3 abilities: `imagine`, `weather`, `search`).

2) **Prompt builder changes**
   - Update `buildAbilitiesBlock()` in `src/utils/promptBuilder.ts` to render the new structured format.
   - Update the “Rules – follow exactly” section:
     - add: “If an ability requires parameters and you can’t infer them, ask a clarification question.”

3) **Inference rules alignment (runtime)**
   - Ensure runtime behavior matches the prompt promises:
     - For ComfyUI reply behavior (`buildImagePromptFromReply`) document in prompt and ensure it matches “reply target first”.
     - For default locations (weather) ensure behavior matches “use default if configured”.

4) **Tests**
   - `tests/promptBuilder.test.ts`: snapshot/contains tests for the new abilities block and rules.
   - `tests/config.test.ts` or `tests/configWriter.test.ts`: validation for new keyword fields.

## Acceptance criteria
- Abilities prompt clearly distinguishes:
  - abilities with implicit inputs vs explicit params
  - when to invoke vs when to ask clarifying questions
- Keyword configs can express `what/when/inputs/validation` without duplicating text.

## Rollout strategy
- Phase 1: Add new fields and render them for a small set of keywords.
- Phase 2: Migrate remaining keywords.
- Phase 3: Tighten rules (optionally) once behavior is stable.

## Risks / mitigations
- **Prompt length growth**: structured ability descriptions add tokens.
  - Mitigate by limiting examples and keeping each ability to ~3–6 lines.
- **Model compliance**: some models may still output keywords even when params missing.
  - Mitigate via tighter “invoke vs clarify” rules and keep existing guardrails in code where possible.
