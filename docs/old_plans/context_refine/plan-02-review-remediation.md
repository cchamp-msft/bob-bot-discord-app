Plan: Align Abilities Clarification
-----------------------------------

This change updates both prompt rule locations to enforce the same clarification behavior and refines `generate`/`imagine` ability inputs so implicit abilities prompt for missing prompts. The plan keeps all logic model-facing (no new API-specific branching in shared code paths) and updates tests to reflect the new guidance. A small follow-up to review the parallel abilities context used by the keyword classifier will be deferred.

**Steps**

1.  Update `<thinking_and_output_rules>` to mirror the clarification policy so it instructs the model to ask a brief follow-up when required inputs are missing, aligning with system rules in [promptBuilder.ts:167-254].
2.  Refine implicit ability inputs for `generate` and `imagine` to explicitly state that a prompt must be present or inferred; add validation or examples that instruct a clarification when no usable text is available in [keywords.json:11-34].
3.  Adjust prompt builder tests to cover the updated clarification language in `<thinking_and_output_rules>` and the new implicit input guidance for `generate`/`imagine` in [promptBuilder.test.ts:156-205].
4.  Update config validation tests only if new fields/constraints are added for the implicit clarification guidance in [config.test.ts:374-526].
5.  Use `gh` to create an issue to address the deferred follow-up: review whether the keyword classifier abilities context should be updated to mirror the new clarification guidance in [keywordClassifier.ts:130-151].

**Verification**

-   Run `npm test` (or targeted `npm test -- promptBuilder.test.ts config.test.ts`) to ensure prompt rendering expectations and config validation remain green.

**Decisions**

-   Keep changes model-facing (prompt text + config), avoiding new API-specific branching in shared runtime paths.
-   Defer aligning the keyword classifier abilities context as a follow-up to keep scope focused.