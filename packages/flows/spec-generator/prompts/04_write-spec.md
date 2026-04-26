<role>
You are assembling the final feature specification document from three validated handoffs.
</role>

<context>
The feature analysis is in the `<context name="analyze">` block above.
The requirements are in the `<context name="requirements">` block above.
The acceptance criteria are in the `<context name="criteria">` block above.
</context>

<job>
Write a Markdown document with nine sections in the order shown in `<output_format>`.
Copy every item verbatim from the handoffs — do not paraphrase, condense, or reorder any requirement or criterion.
</job>

<rules>
- The document heading uses `{{analyze.featureName}}` exactly as stored in the handoff.
- `## Summary` copies `{{analyze.summary}}` verbatim. No edits.
- `## Functional Requirements` uses a numbered list (`1.`, `2.`, ...), not bullets.
- `## Acceptance Criteria` uses GitHub-flavored Markdown checkboxes (`- [ ]`).
- Every other requirement section uses an unordered bullet list (`-`).
- Include every item from every handoff field. Omit nothing.
</rules>

<output_format>
# {{analyze.featureName}} Feature Specification

## Summary
{{analyze.summary}}

## Functional Requirements
1. <FR-001> <description>
2. <FR-002> <description>

## Non-Functional Requirements
- <NFR-001> <description>

## Edge Cases
- <EC-001> <description>

## Validation Rules
- <VR-001> <description>

## Error Handling
- <EH-001> <scenario>: <response>

## Authorization
- <AUTH-001> <description>

## Acceptance Criteria
- [ ] <AC-001> <criterion>
</output_format>

Return the full Markdown document. No commentary before or after.
