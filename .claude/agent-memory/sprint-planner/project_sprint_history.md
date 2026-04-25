---
name: Sprint numbering and history
description: Last sprint in backlog is sprint-26; _work/ directory is wiped between sessions; always check git log to find the latest sprint number
type: project
---

The _work/ directory contains sprint JSON files during a session but is gitignored (.gitignore has _work/) — it is empty at session start. The last sprint committed to the repo is sprint-26 (confirmed from git log: "fix(catalog): address Finding 4 from sprint-25 review" and the session-start hook reporting sprint-26 in backlog). Next available sprints for new work: sprint-27, 28, 29...

**Why:** The _work/ directory is listed in .gitignore (committed in sprint-27 via the scaffolding removal task), so disk state does not reflect what is in HEAD. Always use `git log` to find the highest sprint number.

**How to apply:** Before generating sprint files, check `git log --oneline -20` for sprint references. The next sprint number = highest found + 1. Do not rely on `ls _work/`.
