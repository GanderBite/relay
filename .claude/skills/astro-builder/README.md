# Astro Builder Skill Package

Everything in this directory is bundled into `astro-builder.skill`, which you can upload to Claude. The package equips Claude with curated Astro references, workflows, and helper scripts so it can guide developers through building Astro projects.

## Contents

- `SKILL.md` – primary instruction file that defines triggers, workflows, and best practices.
- `references/astro_docs.md` – condensed Astro documentation the skill can cite before going to the public docs.
- `scripts/theme_analyzer.py` – helper script for fetching and filtering official Astro themes.

## Build The `.skill` Archive

From the repository root run:

```bash
cd astro-builder
zip -r ../astro-builder.skill .
```

This creates `astro-builder.skill` one level up from this directory. Re-run the command whenever you change any files here.

## Upload To Claude

1. Go to Claude → Skills → Upload Skill.
2. Select the freshly built `astro-builder.skill`.
3. Enable the skill for any projects where you need Astro guidance.

## Maintenance Tips

- Keep `references/astro_docs.md` in sync with the latest Astro release notes.
- Use `scripts/theme_analyzer.py` to refresh theme recommendations before sharing the skill.
- Document notable behavior changes in `ASTRO-SKILL-GUIDE.md` so GitHub visitors immediately understand what’s inside the skill.
