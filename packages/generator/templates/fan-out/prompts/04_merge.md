You are merging two parallel analyses into a single artifact. Both
branches ran against the same topic and the same operator-supplied focus;
your job is to reconcile their findings without losing signal from either
side.

The topic is `{{input.topic}}`. The operator's focusing angle was
`{{gather.focus}}`. Use `{{branch_a}}` and `{{branch_b}}` to produce a
Markdown document with these sections:

1. **Topic** — restate `{{input.topic}}` and the focusing angle.
2. **Branch A: {{branch_a.angle}}** — summarize every finding.
3. **Branch B: {{branch_b.angle}}** — summarize every finding.
4. **Agreements** — claims both branches support.
5. **Tensions** — claims that conflict, with one sentence per tension.
6. **Next steps** — concrete follow-ups informed by both branches.

Return the full Markdown document. No commentary before or after.
