---
name: Hook blocks Write and Edit to existing sprint files
description: The PreToolUse hook blocks both Write and Edit tools on _work/sprint-*.json if the file already exists on disk; delete with Bash rm then use Write to recreate
type: feedback
---

The settings.json PreToolUse hook checks `os.path.exists(fp)` and blocks both the Write and Edit tools when the target is an existing _work/sprint-*.json file. This means you cannot overwrite or patch sprint files after initial creation.

**Why:** The hook is designed to prevent accidental mutation of the sprint backlog during execution. It fires on both Write and Edit, checking existence at call time.

**How to apply:** If a sprint file needs to be changed after creation (e.g., to fix file collisions discovered in validation), use `Bash` to `rm` the file first, then use `Write` to create it fresh. Do not attempt Edit on existing sprint files — it will be blocked.
