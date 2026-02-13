# Plan: Export Default Workflow for ComfyUI Testing

## Problem Statement

Users need a way to export the bot's currently active workflow (default or custom) as rendered ComfyUI API format JSON so they can test it directly in ComfyUI. The exported workflow must be importable via ComfyUI's `/prompt` endpoint.

## Proposed Approach

Add an export feature to the web configurator that:
1. Retrieves the currently active workflow (default generated or custom uploaded)
2. Renders it with all parameters filled in (except `%prompt%` placeholder remains)
3. Provides a download button in the UI to save as JSON file
4. Validates the format matches ComfyUI's `/prompt` API specification

## API Format Validation

Based on ComfyUI documentation:
- **Format**: The `/prompt` endpoint expects `{ "prompt": <workflow_object> }`
- **Workflow Structure**: Object keyed by node IDs (strings), each with `class_type` and `inputs`
- **Our Current Format**: Already matches! `buildDefaultWorkflow()` returns the correct API format
- **Validation**: The exported workflow can be directly used in ComfyUI without modification

✅ **CONFIRMED**: The bot's workflows are already in ComfyUI API format and can be imported directly.

## Workplan

- [x] **Backend API**: Add GET endpoint to retrieve rendered workflow
  - Add `GET /api/config/workflow/export` route to httpServer.ts
  - Return the currently active workflow (custom if uploaded, otherwise default generated)
  - Keep `%prompt%` placeholder intact for user testing flexibility
  - Return appropriate error if no workflow is configured
  
- [x] **Workflow Rendering Logic**: Extract common workflow retrieval
  - The logic already exists in `comfyuiClient.ts` (`generateImage` method, line ~545)
  - Create a public method to get the rendered workflow without executing it
  - Handle both custom workflow from config and default generated workflow
  - Apply prompt substitution logic (but preserve `%prompt%` for export)

- [x] **Configurator UI**: Add export button
  - Add "Export Workflow" button to the ComfyUI Workflow section
  - Button calls the new API endpoint
  - Download the JSON file with filename `comfyui-workflow-export.json`
  - Show success/error feedback
  - Enable button only when a workflow is configured

- [x] **Testing**: Validate export functionality
  - Add unit tests to `defaultWorkflowRoutes.test.ts`
  - Test default workflow export
  - Test custom workflow export
  - Test error when no workflow configured
  - Test error when getExportWorkflow throws

- [x] **Documentation**: Update README
  - Add "Workflow Export" bullet to configurator features list
  - Add "Exporting Workflows for ComfyUI Testing" subsection
  - Note that `%prompt%` must be manually replaced for testing

## WIP — Progress

Implementation session: 2026-02-09

### Completed
- **Backend API** — `GET /api/config/workflow/export` route already existed in `httpServer.ts` (line ~202). Returns `{ success, workflow, source, params }` with 400 for no workflow and 500 for errors.
- **Workflow Rendering Logic** — `getExportWorkflow()` method already existed in `comfyuiClient.ts` (line ~542). Handles custom vs default priority, returns typed result with source and optional params.
- **Configurator UI** — "Export Current Workflow" button and `exportWorkflow()` JS function already existed in `configurator.html`. Downloads `comfyui-workflow-export.json` with success/error status feedback.
- **Testing** — Added 4 test cases to `tests/defaultWorkflowRoutes.test.ts`:
  1. Export default workflow with params → 200
  2. Export custom workflow without params → 200
  3. No workflow configured → 400
  4. `getExportWorkflow` throws → 500
  - Added `mockGetExportWorkflow` to the comfyuiClient mock.
- **Documentation** — Updated `README.md`:
  - Added "Workflow Export" feature bullet in configurator features list.
  - Added "Exporting Workflows for ComfyUI Testing" subsection under ComfyUI Workflow Configuration.

## Next Steps

- [x] **Run tests** — All 4 export tests pass (`npx jest --testPathPatterns="defaultWorkflowRoutes"`). Full suite: 759/759 passed (2026-02-09).
- [x] **commitpls** — Committed as `feat(comfyui): add workflow export endpoint and UI`.

## Notes

- **Export format**: Pure workflow object (not wrapped in `{"prompt": ...}`)
  - Users can wrap it themselves or paste directly into ComfyUI's API Format export
- **Prompt handling**: `%prompt%` remains as placeholder
  - Users replace manually with test prompts in ComfyUI
- **Active workflow priority**: Custom uploaded > Default generated
  - Matches current bot behavior in `comfyuiClient.ts`
- **No validation needed**: Workflows are already validated during upload/generation
- **Filename**: Use descriptive name `comfyui-workflow-export.json`

## Implementation Details

### API Endpoint Response Format
```json
{
  "success": true,
  "workflow": { /* ComfyUI API format workflow object */ },
  "source": "custom" | "default",
  "params": { /* if default, include the parameters used */ }
}
```

### Error Cases
- No workflow configured (no custom + no default model set): Return 400 with helpful message
- Workflow validation fails: Return 500 with error details

### UI Changes (configurator.html)
- Add button in the "ComfyUI Workflow" section
- Position: Below the workflow upload field
- Label: "Export Current Workflow"
- Functionality: Download JSON file on click
