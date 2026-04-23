# Resume semantics

`relay resume <runId>` · `relay runs` · `StateMachine` · `state.json`

---

## What state is preserved across a crash

Every mutation to a run's checkpoint is written via an atomic rename. The sequence is:

1. Write the serialized JSON to a temp file at `<path>.tmp-<uuid>`.
2. Call `fsync` on the file descriptor, flushing bytes to stable storage before the handle closes.
3. Rename the temp file onto the final path in a single syscall.

Because rename is atomic at the filesystem level, readers see either the previous complete file or the new complete file — never a partial write. If the process dies between step 2 and step 3, the temp file is left behind on disk. Relay does not sweep orphaned temp files on the next save — they accumulate in the run directory until the run directory is removed or the OS reclaims them. The final path is never torn.

Files written this way:

| File | Content | Written when |
|---|---|---|
| `.relay/runs/<runId>/state.json` | Full `RunState` snapshot — step statuses, attempt counts, handoff keys, artifact paths, timestamps | After each step transitions (start, complete, fail); at run start and at run end |
| `.relay/runs/<runId>/handoffs/<id>.json` | JSON value produced by a step for downstream consumption | When a step calls `output.handoff(id, value)` |
| `.relay/runs/<runId>/flow-ref.json` | Flow name, version, and absolute path to `flow.ts` | Once, at run start |
| `.relay/runs/<runId>/metrics.json` | Cumulative token and cost data | After each provider invocation |

What can be lost in a hard crash (SIGKILL, power loss):

- Any in-progress provider invocation. The step was `running` when the process died; it had not yet written its handoff or flipped its status to `succeeded`.
- The `metrics.json` entry for that invocation, so the "spent so far" total on the next resume banner may be lower than actual cost.
- The live display files under `.relay/runs/<runId>/live/`. These are display-only; losing them does not affect resume correctness.

What cannot be lost:

- The checkpoint of any step that completed before the crash. `state.json` was fsynced and renamed before the Orchestrator started the next step.
- Handoff files for completed steps. Each `handoffs/<id>.json` was written atomically before `completeStep` was called.

---

## Which steps re-execute on resume vs. which are skipped

The rule is: `succeeded` and `skipped` steps are never re-dispatched. Every other status is eligible.

`seedReadyQueueForResume` (`packages/core/src/orchestrator/resume.ts`) builds the initial queue for a resumed run by walking the flow's topological order and applying this filter:

- A step with status `succeeded` or `skipped` → omitted from the queue.
- A step with status `failed`, `running`, or `pending` → included if its predecessors are all `succeeded`, `skipped`, or `failed` with `onFail: 'continue'`.

The step-level in-process result cache (`StateMachine.#stepResults`) is not serialized to disk. A fresh process that resumes from disk starts with an empty cache. Parallel branch executors that short-circuit on a cached result will not find cached values on resume; they fall back to the on-disk step status instead.

---

## What happens to a step that was RUNNING when the process died

A SIGKILL or OS crash bypasses `markRun()`, so the on-disk `state.json` may carry one or more steps with status `running` after the process exits. These are called zombie steps.

On resume, the Orchestrator sweeps zombie steps before dispatching any new work:

```
for (const [stepId, stepState] of Object.entries(persistedState.steps)) {
  if (stepState.status === 'running') {
    sweptSteps[stepId] = {
      ...stepState,
      status: 'failed',
      completedAt: zombieSweepIso,
      errorMessage: 'run aborted by crash',
    };
  }
}
```

After the sweep, the Orchestrator resets every `failed` step — including the swept zombie steps — to `pending`, increments nothing (the `attempts` counter survives from the zombie state), then dispatches them through the normal retry path.

The state transition diagram for a single step:

```
          ┌─────────────────────────────────┐
          │         startStep()             │
  pending ─────────────────────────────────▶ running
     ▲         (attempts += 1)                 │
     │                                         │
     │ resetStep()               completeStep()│
     │ (failed → pending)                      ▼
  failed ◀──────────────────────────────  succeeded
     │         failStep()
     │◀────────────────────────────────── running
     │
     │  (only from pending, via skipStep)
     ▼
  skipped
```

Valid transitions:

| From | To | Method | Guard |
|---|---|---|---|
| `pending` | `running` | `startStep` | only from `pending` |
| `running` | `succeeded` | `completeStep` | only from `running` |
| `running` | `failed` | `failStep` | only from `running` |
| `pending` | `skipped` | `skipStep` | only from `pending` |
| `failed` | `pending` | `resetStep` | only from `failed` |

Illegal transitions produce a `StateTransitionError` rather than silently corrupting state.

Partial output from the crashed step is discarded. The handoff file for a step is only written inside `output.handoff(id, value)` as the step executes; `completeStep` then records the handoff key on `StepState`. If the step died mid-execution, no handoff file for that step exists on disk, and `StepState.handoffs` for it is absent. On resume the step re-executes from scratch.

---

## Guarantees about side effects

Relay does not track side effects beyond what the step explicitly reports via `output.handoff()` and `output.artifact()`. If a prompt step wrote files to the worktree, called an external API, or made any mutation before the crash, Relay has no record of it.

On resume, the step re-executes in full. This means:

- Any output files the step produced before the crash may be overwritten or duplicated, depending on how the step's prompt constructs them.
- Any external API calls the step made before the crash are not rolled back.
- The per-run git worktree (when isolation is enabled) is created fresh for the resumed run. The previous run's worktree was either torn down in the run's `finally` block or left under `$TMPDIR/relay-worktrees` if the process was SIGKILL'd. The OS reclaims orphaned worktrees on reboot; `git worktree prune` removes them manually.

If you need idempotent side effects, write the step's prompt or script to check for existing output before writing. Relay's guarantee is: the step's handoff and artifact records are consistent with the on-disk files, because both are written before `completeStep` is called.

---

## How to use `relay resume`

### Command syntax

```
relay resume <runId> [--provider <name>] [--no-worktree]
```

`<runId>` is the six-character hex identifier printed in the run banner and in `relay runs` output. You can pass any prefix that uniquely identifies the run directory under `.relay/runs/`.

Options:

| Flag | Effect |
|---|---|
| `--provider <name>` | Override the provider for this resume (same resolution as `relay run`) |
| `--no-worktree` | Disable per-run git worktree isolation for this resume |

### Where to find the runId

```
relay runs
```

Output:

```
●─▶●─▶●─▶●  recent runs

 ✓  f9c3a2    codebase-discovery v0.1.0    2h ago      11m 42s
 ✕  a1b2c3    codebase-discovery v0.1.0    3d ago      0s
 ⊘  d4e5f6    codebase-discovery v0.1.0    1w ago      -

resume any: relay resume <runId>
```

Run directories are stored at `.relay/runs/<runId>/` relative to the working directory where `relay run` was first invoked. You can also list them with `ls .relay/runs/`.

### What the pre-resume banner shows

```
●─▶●─▶●─▶●  relay resume f9c3a2

flow     codebase-discovery v0.1.0
picking up from: designReview

 ✓ inventory       (cached, ran 14:32)
 ✓ entities        (cached, ran 14:33)
 ✓ services        (cached, ran 14:33)
 ⠋ designReview    running
 ○ report          waiting on designReview

spent so far: $0.049
```

Steps marked `✓` are cached: they will not re-execute. The first non-cached step is the one Relay picks up from. Steps that depend on it are shown as waiting.

### Resuming an already-succeeded run

If `state.json` records `status: "succeeded"`, `relay resume` returns the final result immediately without re-dispatching any step. This is safe to call multiple times; it reads the persisted result without touching any step.

---

## What `relay resume` cannot recover

### `StateCorruptError`

Raised when `state.json` or `flow-ref.json` exists but cannot be parsed or does not match the expected schema. This happens when:

- The file was manually edited and the JSON is now invalid.
- A partial write landed at the final path without an fsync + rename (only possible if something bypassed the atomic write path).
- The schema version changed between the Relay release that wrote the file and the one now reading it.

There is no automatic recovery from a `StateCorruptError`. The checkpoint is unreadable. Start a fresh run:

```
relay run <flow> <input>
```

### `StateVersionMismatchError`

Raised when the run was recorded by a different flow name or version than the one currently installed. The check compares `state.json` fields `flowName` and `flowVersion` against `flow-ref.json` and against the live flow module. A mismatch means:

- You upgraded the flow package and changed its `version` field while a run was in progress.
- You renamed the flow and are trying to resume under the old name.

`relay resume` prints the expected and actual name/version pair and instructs you to start a fresh run:

```
  ✕ run state is not compatible with this flow:
    expected codebase-discovery@0.2.0, found codebase-discovery@0.1.0.
    start a new run: relay run codebase-discovery .
```

### Missing `flowPath` in `flow-ref.json`

If `flowPath` is `null` in `flow-ref.json`, the Orchestrator cannot re-import the flow module in the new process. This happens when the run was started programmatically without passing `flowPath` to `Orchestrator.run()`. The CLI always supplies a path, so this case only arises in library usage.

```
  ✕ run <runId> has no recorded flow path — cannot resume
    start a fresh run: relay run <flowName> .
```

### Runs with status `aborted` or `failed` that exhaust retry budgets

A run whose every failed step has already consumed its full `maxRetries` budget re-dispatches those steps on resume but they will fail again immediately without executing. The run reaches a `failed` terminal state and no further resume is useful. Start a fresh run.

---

## Vocabulary

```
flow        a named, versioned sequence of steps you can run
step        one node in a flow (prompt, script, branch, parallel)
handoff     the JSON one step produces and a later step consumes
run         one execution of a flow; identified by a run id
checkpoint  the saved state of a run after each step completes
```
