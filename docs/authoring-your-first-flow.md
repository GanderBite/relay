# Authoring your first flow

This tutorial walks through the complete loop a new flow author goes through: scaffold, edit, run, fail, fix, resume, extend. By the end you have a working two-step flow that passes a handoff from the first step to the second.

If you want the format reference instead of a walkthrough, read [`docs/flow-package-format.md`](flow-package-format.md).

---

## 1. Scaffold with `relay new`

```
relay new my-flow --template blank
```

Expected output (abbreviated):

```
●─▶●─▶●─▶●  relay new my-flow (blank template)

 ✓ wrote ./my-flow/package.json
 ✓ wrote ./my-flow/flow.ts
 ✓ wrote ./my-flow/prompts/01_first.md
 ✓ wrote ./my-flow/README.md
 ✓ wrote ./my-flow/tsconfig.json
 ✓ installed dev dependencies

try it:
    cd my-flow && relay run .
```

The `--template blank` flag skips the interactive generator skill and writes files directly. Without the flag, `relay new` detects whether the generator skill is installed in Claude Code and offers the conversational path instead.

The directory you now have:

```
my-flow/
├── package.json
├── flow.ts
├── prompts/
│   └── 01_first.md
├── README.md
└── tsconfig.json
```

`flow.ts` is the entry point. It default-exports a `Flow` object built by `defineFlow`. The blank template gives you one step named `first` that reads its prompt from `prompts/01_first.md` and writes a handoff named `result`.

Before running, build the flow so the CLI can load `dist/flow.js`:

```
cd my-flow && npm run build
```

---

## 2. Edit `prompts/01_first.md`

Open `my-flow/prompts/01_first.md`. The blank template places this content there:

```
You are writing about {{input.subject}}. Produce a short paragraph describing it.

Return ONLY the paragraph text. No preamble, no headings, no commentary.
```

Prompt files are Handlebars templates. The variables available inside every prompt:

| Variable | Value |
|---|---|
| `{{input.<field>}}` | Any field from the flow's `input` schema. The blank template declares `subject: z.string()`, so `{{input.subject}}` resolves to the value the caller passes. |
| `{{<handoffId>.<field>}}` | The JSON value a prior step wrote as a handoff. Only available in steps that declare `contextFrom: ['<handoffId>']` in `flow.ts`. |

For now, leave the prompt as-is. You will edit it in step 4.

---

## 3. Run with `relay run .`

```
relay run . --subject "the water cycle"
```

The `.` argument tells the CLI to load the flow from the current directory. The `--subject` flag satisfies the `subject: z.string()` input the blank template declares.

Expected output at start (abbreviated):

```
●─▶●─▶●─▶●  my-flow  a1b2c3

flow     my-flow v0.1.0
input    the water cycle
run      a1b2c3  ·  2026-04-23 09:14
bill     subscription (max)  ·  no api charges
est      ~0.00  ·  1 step  ·  ~1 min

state is saved after every step.

 ⠋ first          sonnet     turn 1
```

The `run` row gives you the run ID. You will need it in step 6 if you resume. The `bill` row confirms whether the run is on your Claude subscription or on an API account — it is never hidden.

When the step completes, the success banner appears:

```
●─▶●─▶●─▶●  my-flow  a1b2c3  ✓

 ✓ first          sonnet     3.2s    0.8K→0.1K    $0.000

total  3.2s  ·  $0.000
output .relay/runs/a1b2c3
```

The handoff `result` is written to `.relay/runs/a1b2c3/handoffs/result.json`. You can inspect it directly:

```
cat .relay/runs/a1b2c3/handoffs/result.json
```

---

## 4. Introduce a deliberate prompt failure

Edit `prompts/01_first.md` to produce output that does not match what a downstream step expects. The clearest way is to add a `output.schema` constraint in `flow.ts` and then make the prompt return the wrong shape.

Open `flow.ts` and add a Zod schema to the first step:

```ts
import { defineFlow, step, z } from '@relay/core';

export default defineFlow({
  name: 'my-flow',
  version: '0.1.0',
  description: 'A Relay flow.',
  input: z.object({
    subject: z.string(),
  }),
  steps: {
    first: step.prompt({
      promptFile: 'prompts/01_first.md',
      output: {
        handoff: 'result',
        schema: z.object({ summary: z.string(), wordCount: z.number() }),
      },
    }),
  },
});
```

Now rebuild:

```
npm run build
```

The prompt still asks for a plain paragraph, which will not satisfy `{ summary: string; wordCount: number }`. Run the flow again:

```
relay run . --subject "photosynthesis"
```

The step fails and the failure banner appears:

```
●─▶●─▶●─▶●  my-flow  b2c3d4  ✕

 ✕ first          sonnet     2.8s                 $0.000
   HandoffSchemaError: handoff "result" failed schema validation
   [0] path: summary · required
   [1] path: wordCount · required

spent $0.000
```

The run ID `b2c3d4` and the step ID `first` are both present in the banner. The checkpoint up to (but not including) the failed step is saved on disk.

For a full explanation of `HandoffSchemaError` and other step errors, see [`docs/troubleshooting.md`](troubleshooting.md#handoffschemerror).

---

## 5. Understand the failure and plan the fix

The `HandoffSchemaError` means the step's prompt returned output the schema did not expect. The banner tells you exactly which paths failed.

To diagnose further, read the structured log:

```
relay logs b2c3d4 --step first
```

Two remediation paths:

→ Fix the prompt so it returns `{ "summary": "...", "wordCount": <n> }`.  
→ Remove or relax the schema if strict validation was not your intent.

For this tutorial, fix the prompt. Open `prompts/01_first.md` and replace its content with:

```
You are writing about {{input.subject}}.

Return ONLY a JSON object with this exact shape:

{
  "summary": "<one sentence describing the subject>",
  "wordCount": <number of words in the summary sentence>
}

No prose, no backticks, no preamble.
```

Rebuild:

```
npm run build
```

The prompt is now fixed. The checkpoint from the previous run (`b2c3d4`) has no completed steps to reuse — `first` was the only step and it failed — so you can either start a fresh run or resume. Because the step wrote no handoff before failing, resuming and starting fresh are equivalent here. Step 6 shows resuming from a run where at least one step did succeed.

---

## 6. Resume from the last checkpoint with `relay resume`

To see resume in action, you need a run where at least one step succeeded before a later step failed. Add a second step first (step 7 below), then run and fail the second step. For now, let's verify the syntax and the pre-resume banner by resuming the failed `b2c3d4` run.

```
relay resume b2c3d4
```

The pre-resume banner shows which steps are cached and where Relay picks up:

```
●─▶●─▶●─▶●  relay resume b2c3d4

flow     my-flow v0.1.0
picking up from: first

 ⠋ first          running

spent so far: $0.000
```

Because `first` failed, Relay re-dispatches it. This time the fixed prompt produces the expected JSON and the run succeeds.

The key rule: steps with status `✓` in the pre-resume banner are cached — they will not re-execute and their cost is not re-incurred. Only failed or pending steps run again. This means:

→ Resuming a five-step flow where step 3 failed costs roughly what step 3 through step 5 cost originally.  
→ You are never charged again for steps that already completed.

For the full checkpoint and state machine details, read [`docs/resume-semantics.md`](resume-semantics.md).

---

## 7. Add a second step with a handoff

Open `flow.ts` and add a second step that consumes the `result` handoff from the first step:

```ts
import { defineFlow, step, z } from '@relay/core';

export default defineFlow({
  name: 'my-flow',
  version: '0.1.0',
  description: 'A Relay flow.',
  input: z.object({
    subject: z.string(),
  }),
  steps: {
    first: step.prompt({
      promptFile: 'prompts/01_first.md',
      output: {
        handoff: 'result',
        schema: z.object({ summary: z.string(), wordCount: z.number() }),
      },
    }),
    second: step.prompt({
      promptFile: 'prompts/02_second.md',
      dependsOn: ['first'],
      contextFrom: ['result'],
      output: { artifact: 'report.md' },
    }),
  },
});
```

Three fields wire the handoff:

| Field | Role |
|---|---|
| `output.handoff: 'result'` | The first step names the JSON value it writes to disk. |
| `dependsOn: ['first']` | The second step will not start until `first` succeeds. |
| `contextFrom: ['result']` | The second step's prompt receives the `result` JSON injected as a Handlebars variable. |

Create `prompts/02_second.md`:

```
The prior step analysed {{input.subject}} and produced this summary:

"{{result.summary}}" ({{result.wordCount}} words)

Write a short markdown document (two paragraphs, no headings) that expands on the summary. Focus on why the subject matters.

Return the markdown document as plain text. No code fences, no commentary.
```

The variable `{{result.summary}}` resolves to the `summary` field of the JSON object `first` wrote to the `result` handoff. `{{result.wordCount}}` resolves to the number field. Any field present on the handoff object is accessible via `{{<handoffId>.<field>}}`.

Rebuild:

```
npm run build
```

---

## 8. Run again and verify both steps complete

```
relay run . --subject "the carbon cycle"
```

The progress display shows both steps in sequence:

```
●─▶●─▶●─▶●  my-flow  c3d4e5

flow     my-flow v0.1.0
input    the carbon cycle
run      c3d4e5  ·  2026-04-23 09:31
bill     subscription (max)  ·  no api charges
est      ~0.00  ·  2 steps  ·  ~2 min

state is saved after every step.

 ✓ first          sonnet     3.1s    0.8K→0.1K    $0.000
 ⠋ second         sonnet     turn 2
```

When both steps complete:

```
●─▶●─▶●─▶●  my-flow  c3d4e5  ✓

 ✓ first          sonnet     3.1s    0.8K→0.1K    $0.000
 ✓ second         sonnet     5.4s    0.4K→0.6K    $0.000

total  8.5s  ·  $0.000
output .relay/runs/c3d4e5/report.md
```

The `output` line points at the artifact `second` produced. Open it:

```
cat .relay/runs/c3d4e5/report.md
```

The file contains the markdown the second step wrote, with the summary from the first step incorporated via the handoff.

---

## What to read next

- [`docs/flow-package-format.md`](flow-package-format.md) — the complete directory layout, `package.json` schema, and README section requirements.
- [`docs/resume-semantics.md`](resume-semantics.md) — how checkpoints are written, what is preserved across a crash, and the full state machine.
- [`docs/troubleshooting.md`](troubleshooting.md) — every error class with cause and remediation.
