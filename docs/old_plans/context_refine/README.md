# Context refine — plans

This set of improvements is **too large for one effort** if you want to keep risk low and preserve existing behavior while iterating. The changes touch:
- how Discord context is collected, collated, and formatted
- how the model is instructed to invoke abilities (keywords)
- how context-eval is prompted and parsed

Splitting into 3 efforts keeps each PR reviewable and testable.

## Plans
- [plan-01-context-by-source.md](plan-01-context-by-source.md) — present message context uniformly by `contextSource`, remove primary/secondary semantics.
- [plan-02-abilities-directive-and-params.md](plan-02-abilities-directive-and-params.md) — clarify abilities prompt for abilities w/ and w/o parameters; add inference + validation rules.
- [plan-03-context-eval-output-format.md](plan-03-context-eval-output-format.md) — confirm/improve the bracket-array output approach for context evaluation.

## Current implementation anchors (for reference)
- Context filtering & model selection: `src/utils/contextEvaluator.ts`
- Prompt assembly + abilities block: `src/utils/promptBuilder.ts`
- Context collection/collation entry: `src/bot/messageHandler.ts`
- Message metadata: `src/types.ts` (`contextPriority`, `contextSource`)
- Keyword config fields: `src/utils/config.ts` + `config/keywords.json`
