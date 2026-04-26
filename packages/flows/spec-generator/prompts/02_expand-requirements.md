<role>
You are expanding a feature analysis into a complete set of structured requirements across six categories.
</role>

<context>
The feature analysis is in the `<context name="analyze">` block above.
Feature: {{analyze.featureName}}
Summary: {{analyze.summary}}
</context>

<job>
Generate all six requirement sets and return them as a single JSON object matching the RequirementsSchema.
</job>

<rules>
- Every requirement must be verifiable as pass/fail. Replace vague qualifiers with specific bounds:
  write "under 200 ms at p95" not "quickly"; write "returns HTTP 422" not "rejects properly".
- `functionalRequirements` (FR-001, FR-002, ...): one item per distinct behavior the feature must exhibit. Generate at least 3 items.
- `nonFunctionalRequirements` (NFR-001, ...): cover performance, scalability, reliability, and observability. Generate at least 1 item.
- `edgeCases` (EC-001, ...): name the boundary condition and the exact expected behavior at that boundary. Generate at least 2 items.
- `validationRules` (VR-001, ...): state what input is rejected and the exact rejection behavior — error code, message text. Generate at least 2 items.
- `errorHandling` (EH-001, ...): set `scenario` to the triggering condition; set `response` to the HTTP status, error message, and any rollback or side effect. Generate at least 2 items.
- `authorization` (AUTH-001, ...): name the role or permission and state exactly what it allows or denies. Generate at least 1 item.
</rules>

<output_format>
Return ONLY the raw JSON object below, with every array populated. No prose, no markdown fences, no preamble.

{
  "functionalRequirements": [
    { "id": "FR-001", "description": "..." }
  ],
  "nonFunctionalRequirements": [
    { "id": "NFR-001", "description": "..." }
  ],
  "edgeCases": [
    { "id": "EC-001", "description": "..." }
  ],
  "validationRules": [
    { "id": "VR-001", "description": "..." }
  ],
  "errorHandling": [
    { "id": "EH-001", "scenario": "...", "response": "..." }
  ],
  "authorization": [
    { "id": "AUTH-001", "description": "..." }
  ]
}
</output_format>
