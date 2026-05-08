import { describe, expect, it } from 'vitest';

import { renderOutputContract } from '../../src/orchestrator/output-contract.js';

describe('renderOutputContract', () => {
  it('renders the byte-stable contract block with all placeholders interpolated', () => {
    const out = renderOutputContract({
      handoffId: 'greeted',
      stagingPath: '/runs/r1/.tmp/greeted.json',
      handoffScript: '/runs/r1/.bin/handoff.mjs',
      schemaJson: '{\n  "type": "object"\n}',
    });
    expect(out).toMatchInlineSnapshot(`
      "

      ---

      ## OUTPUT CONTRACT (required)

      You MUST persist your final answer by running this command via the Bash tool. Do not print JSON to stdout — it is ignored.

      1. Use the Write tool to save your draft JSON at: /runs/r1/.tmp/greeted.json
      2. Run via the Bash tool:

         node /runs/r1/.bin/handoff.mjs write greeted --from /runs/r1/.tmp/greeted.json

      The script validates your JSON against the schema below and writes it atomically on success. On failure it prints one error per line on stderr and exits non-zero; read the errors, edit the staging file, and re-run the command.

      The schema (JSON Schema 2020-12):

      \`\`\`json
      {
        "type": "object"
      }
      \`\`\`

      Repeat the Write + Bash cycle until the script prints "OK greeted". Stop only after you see that line.
      "
    `);
  });

  describe('edge cases', () => {
    // OC-1: Different handoffIds must produce uniquely-routed contracts.
    // If the id were ignored or hardcoded, two steps in the same flow would
    // both try to write to the same file, causing a silent data-race.
    it('[OC-1] different handoffIds produce distinct staging paths, script args, and OK sentinels', () => {
      const a = renderOutputContract({
        handoffId: 'alpha',
        stagingPath: '/run/.tmp/alpha.json',
        handoffScript: '/run/.bin/handoff.mjs',
        schemaJson: '{}',
      });
      const b = renderOutputContract({
        handoffId: 'beta',
        stagingPath: '/run/.tmp/beta.json',
        handoffScript: '/run/.bin/handoff.mjs',
        schemaJson: '{}',
      });

      expect(a).toContain('/run/.tmp/alpha.json');
      expect(a).toContain('write alpha --from');
      expect(a).toContain('OK alpha');

      expect(b).toContain('/run/.tmp/beta.json');
      expect(b).toContain('write beta --from');
      expect(b).toContain('OK beta');

      // The two outputs must not contain each other's id in the wrong places.
      // Extract the "write <id>" portion to ensure routing is independent.
      expect(a).not.toContain('write beta');
      expect(b).not.toContain('write alpha');
    });

    // OC-2: The schemaJson string must appear verbatim between the fenced
    // code block delimiters. If the renderer HTML-escaped it, indented it, or
    // truncated it, the model would see a corrupted schema and self-correction
    // would fail.
    it('[OC-2] schemaJson is embedded verbatim between the json fences', () => {
      const schema =
        '{\n  "type": "object",\n  "properties": {\n    "x": { "type": "number" }\n  }\n}';
      const out = renderOutputContract({
        handoffId: 'doc',
        stagingPath: '/r/.tmp/doc.json',
        handoffScript: '/r/.bin/handoff.mjs',
        schemaJson: schema,
      });

      // The schema must appear exactly as passed — no indentation shifts,
      // no escaping, no truncation.
      expect(out).toContain('```json\n' + schema + '\n```');
    });

    // OC-3: The contract must preserve newlines in multi-line schemaJson.
    // A renderer that collapsed whitespace would break JSON syntax inside
    // the fence and confuse the model.
    it('[OC-3] multi-line schemaJson with nested properties preserves all newlines', () => {
      const multiLine = [
        '{',
        '  "type": "object",',
        '  "required": ["name", "count"],',
        '  "properties": {',
        '    "name": { "type": "string" },',
        '    "count": { "type": "integer" }',
        '  }',
        '}',
      ].join('\n');

      const out = renderOutputContract({
        handoffId: 'report',
        stagingPath: '/r/.tmp/report.json',
        handoffScript: '/r/.bin/handoff.mjs',
        schemaJson: multiLine,
      });

      // Every line of the schema must survive the round-trip intact.
      for (const line of multiLine.split('\n')) {
        expect(out).toContain(line);
      }
      // And the full block must appear together, not fragmented.
      expect(out).toContain(multiLine);
    });

    // OC-4: The terminating instruction "Stop only after you see that line."
    // is what prevents the model from yielding before it has confirmed the
    // write succeeded. If the renderer omitted or rephrased this line the
    // model might stop after the first script invocation regardless of outcome.
    it('[OC-4] the contract ends with the exact stop-after-confirmation instruction', () => {
      const out = renderOutputContract({
        handoffId: 'final',
        stagingPath: '/r/.tmp/final.json',
        handoffScript: '/r/.bin/handoff.mjs',
        schemaJson: '{}',
      });

      // The trailing sentinel must be present with the exact wording the spec
      // requires. The `final` id propagates into the sentinel too.
      expect(out).toContain(
        'Repeat the Write + Bash cycle until the script prints "OK final". Stop only after you see that line.',
      );
    });

    // OC-5: No template placeholder markers should survive into the rendered
    // output. A leak would expose implementation internals to the model and
    // break the contract's instructions.
    it('[OC-5] no unresolved placeholder markers survive in the rendered output', () => {
      const out = renderOutputContract({
        handoffId: 'check',
        stagingPath: '/r/.tmp/check.json',
        handoffScript: '/r/.bin/handoff.mjs',
        schemaJson: '{"type":"string"}',
      });

      // None of these template markers should appear in the final text.
      expect(out).not.toContain('{{handoffId}}');
      expect(out).not.toContain('{{stagingPath}}');
      expect(out).not.toContain('{{handoffScript}}');
      expect(out).not.toContain('{{schemaJson}}');
      // Also verify the actual values replaced them correctly.
      expect(out).toContain('check');
      expect(out).toContain('/r/.tmp/check.json');
      expect(out).toContain('/r/.bin/handoff.mjs');
      expect(out).toContain('{"type":"string"}');
    });
  });
});
