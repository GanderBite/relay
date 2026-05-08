export interface RenderOutputContractArgs {
  /** Handoff id the prompt step writes — also the SCHEMAS key in the helper. */
  handoffId: string;
  /** Absolute path to `<runDir>/.tmp/<handoffId>.json` for the model to draft into. */
  stagingPath: string;
  /** Absolute path to `<runDir>/.bin/handoff.mjs` the model invokes via Bash. */
  handoffScript: string;
  /** Pretty-printed JSON Schema 2020-12 to embed verbatim in the contract. */
  schemaJson: string;
}

/**
 * Renders the OUTPUT CONTRACT block that the orchestrator appends to a prompt
 * body when the step has both `output.handoff` and `output.schema`. The block
 * lands in the model's prompt unchanged — every visible string here is part of
 * the product surface, so the wording is byte-stable and snapshot-locked by
 * `tests/orchestrator/exec/output-contract.test.ts`.
 */
export function renderOutputContract(args: RenderOutputContractArgs): string {
  const { handoffId, stagingPath, handoffScript, schemaJson } = args;
  return `

---

## OUTPUT CONTRACT (required)

You MUST persist your final answer by running this command via the Bash tool. Do not print JSON to stdout — it is ignored.

1. Use the Write tool to save your draft JSON at: ${stagingPath}
2. Run via the Bash tool:

   node ${handoffScript} write ${handoffId} --from ${stagingPath}

The script validates your JSON against the schema below and writes it atomically on success. On failure it prints one error per line on stderr and exits non-zero; read the errors, edit the staging file, and re-run the command.

The schema (JSON Schema 2020-12):

\`\`\`json
${schemaJson}
\`\`\`

Repeat the Write + Bash cycle until the script prints "OK ${handoffId}". Stop only after you see that line.
`;
}
