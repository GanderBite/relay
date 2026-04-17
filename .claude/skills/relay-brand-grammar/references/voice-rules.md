# Voice Rules — Long Form

Distilled from product spec §4. Reach for this when writing prose for READMEs, error messages, banner copy, marketing.

## The reader

A senior developer or PM who has used Claude Code, hit the "Claude forgot" moment, and is suspicious of yet another orchestration tool. They are scanning, not reading. Three sentences in, they decide whether to keep going.

Write for them: dense, specific, calm.

## Sentence shape

- **Subject + active verb + object**, in that order.
- Present tense by default. ("Relay runs" not "Relay will run.")
- Second person. ("You point Relay at a flow." not "Users point Relay...")
- One idea per sentence. If you reach a clause with "and also," start a new sentence.
- Numbers attach to claims. "11.4K tokens" beats "many tokens."

## Examples

### Status updates (terminal output)

✓ DO:
```
3 of 5 steps succeeded · $0.049 spent · state saved
```

✕ DON'T:
```
✨ Awesome! Some of your steps completed and we saved your progress! 🚀
```

### Error messages

✓ DO:
```
✕ env  ANTHROPIC_API_KEY is set in your environment
       running a flow now would bill your API account,
       not your Max subscription.

       fix:      unset ANTHROPIC_API_KEY
       permanent: remove the line from ~/.zshrc
       override: relay run --api-key (opts into API billing)
```

✕ DON'T:
```
⚠️ Warning: An environment variable is set that could affect billing.
   Please review your environment configuration.
```

### README opening lines

✓ DO:
> Relay is a CLI and TypeScript library for running multi-step Claude Code workflows that resume after crashes, never surprise you with a bill, and produce the same artifact every time.

✕ DON'T:
> Relay is the next-generation AI workflow orchestration platform that empowers developers to build powerful Claude-based pipelines with ease!

## Specific words to ban or replace

| Don't write | Write instead |
|---|---|
| simply | (just delete it — the sentence is fine without) |
| just | (usually filler — delete) |
| easy | (don't claim it; show it with a one-line example) |
| powerful | (replace with what makes it powerful: "5-step flow in 12 minutes for $0.40") |
| awesome / amazing / great | (use exact numbers) |
| seamless / effortless | (the user decides what's seamless; don't claim it) |
| robust | (test results say this, copy doesn't) |
| modern | (year-stamped already, don't say it) |
| next-generation | (always meaningless) |
| AI-powered | (everything is now; don't say it) |
| empower | (banned in all forms) |
| leverage | (use "use") |
| utilize | (use "use") |
| best-in-class | (banned) |
| world-class | (banned) |
| revolutionary | (banned) |

## Specific characters to ban

- Trailing `!` — replace with `.`
- All emojis — replace with the symbol vocabulary or delete
- Smart quotes (`"` and `'`) — use straight quotes (`"` and `'`) in code blocks; either is fine in prose
- Em-dash with spaces (` — `) is fine; en-dash is fine; double hyphen `--` only in CLI flag context

## Numbers over adjectives

| Adjective | Number |
|---|---|
| fast | 2.1s |
| cheap | $0.005 |
| many tokens | 1.4K tokens |
| small overhead | 47ms |
| under budget | spent $0.11 of $0.40 estimated |

If you don't have a number, omit the claim. Don't make one up. Don't round.

## Closing lines

Don't sign off. The terminal output ends with the last meaningful line. README sections end with a link or a code block, not a "Happy hacking!"

The exception: completion banners may end with a `next:` block listing actions the user can take. That's information, not signoff.
