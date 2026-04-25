## Summary

<!-- What does this PR change and why? -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor
- [ ] Documentation
- [ ] Configuration / CI

## Checklist

- [ ] `pnpm -r typecheck` passes
- [ ] `pnpm --filter './packages/**' test` passes
- [ ] No emojis added to user-visible strings
- [ ] No `as T` casts without a Zod parse guard
- [ ] Fallible functions return `Result<T, E>` via neverthrow
- [ ] Commit message follows conventional commits
