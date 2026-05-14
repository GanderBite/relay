import { defineFlow, step, z } from '@ganderbite/relay-core';

/**
 * Flow used by the resume-cwd test to assert that RELAY_FLOW_DIR is stable
 * across a pause/resume boundary. The two script steps each write
 * $RELAY_FLOW_DIR to a known file inside $RELAY_RUN_DIR so the test can read
 * them back and compare.
 */
export const flow = defineFlow({
  name: 'script-ask-script',
  version: '0.0.1',
  input: z.object({}),
  steps: {
    'script-before': step.script({
      run: ['sh', '-c', 'printf "%s" "$RELAY_FLOW_DIR" > "$RELAY_RUN_DIR/flowdir-before.txt"'],
    }),
    'pause-ask': step.ask({
      questions: [{ id: 'confirm', kind: 'text', label: 'Ready to continue?' }],
      dependsOn: ['script-before'],
    }),
    'script-after': step.script({
      run: ['sh', '-c', 'printf "%s" "$RELAY_FLOW_DIR" > "$RELAY_RUN_DIR/flowdir-after.txt"'],
      dependsOn: ['pause-ask'],
    }),
  },
});

export default flow;
