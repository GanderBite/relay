---
name: File collision resolution pattern
description: When multiple tasks in the same wave share a target file, merge them into one task rather than adding wave depth
type: feedback
---

When multiple small config changes all target the same file (e.g., packages/cli/package.json needs sideEffects, exports map, and bin cleanup), merge them into one combined task with a clear description of all three changes. Adding a new wave just to serialize tiny config changes wastes parallelism.

**Why:** The dependency rules forbid two tasks in the same wave from sharing a target_file. The natural fix is to merge collocated changes into one task that owns the file for that wave.

**How to apply:** During dependency assignment, scan each wave's target_files for duplicates. If two tasks collide on a config file (package.json, vitest.config.ts), merge them if their changes are independent and the combined task stays under the size limit. Only add a new wave if the changes are logically sequential (B must see A's output).
