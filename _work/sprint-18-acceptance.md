Sprint 18 — Worktree Isolation Acceptance Checklist

All scenarios must be run on a dev machine inside the relay git repo unless otherwise noted.
Status column: pending / pass / fail

| # | Scenario | Steps | Expected | Status |
|---|----------|-------|----------|--------|
| 1 | Worktree created and removed on normal run | 1. `cd` into the relay repo root. 2. Run `relay run ./examples/hello-world-mocked`. 3. Before the run completes, in a second shell run `ls $TMPDIR/relay-worktrees/` and record any entries. 4. After the run completes, run `ls $TMPDIR/relay-worktrees/` again. | During the run: exactly one directory exists under `$TMPDIR/relay-worktrees/` whose name matches the run's `runId`. After the run: that directory is gone. | pending |
| 2 | Concurrent runs each get a distinct worktree | 1. From the relay repo root, start two background jobs: `relay run ./examples/hello-world-mocked &` and `relay run ./examples/hello-world-mocked &`. 2. Immediately run `ls $TMPDIR/relay-worktrees/`. 3. Wait for both jobs to finish (`wait`). 4. Run `ls $TMPDIR/relay-worktrees/` again. | During the run: two directories exist under `$TMPDIR/relay-worktrees/`, each with a distinct name. Both background jobs exit 0. After: both directories are gone. | pending |
| 3 | Non-git directory skips worktree with debug log | 1. `cd /tmp`. 2. Run `relay run <absolute-path-to-hello-world-mocked> --log-level debug 2>&1 \| tee /tmp/relay-nongit.log`. 3. Inspect the log. | The run completes successfully (exit 0). The log contains a line with `worktree.skip_no_repo` or the phrase "proceeding without worktree isolation". No directory is created under `$TMPDIR/relay-worktrees/`. | pending |
| 4 | `--no-worktree` flag disables worktree entirely | 1. From the relay repo root, run `relay run ./examples/hello-world-mocked --no-worktree`. 2. While it runs, check `ls $TMPDIR/relay-worktrees/`. | The run completes successfully (exit 0). No directory is created under `$TMPDIR/relay-worktrees/` at any point during the run. | pending |
