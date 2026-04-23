# Relay Copy Kit

any public copy not in this file is wrong — refer here first.

---

## Taglines

> Claude flows you can run twice.

> The orchestrator for Claude Code that remembers.

> Deterministic, subscription-safe Claude flows.

> Crash-proof Claude flows in a single CLI.

---

## 140-character pitch

> Relay runs multi-step Claude Code flows that survive crashes, never
> surprise-bill your API account, and ship the same artifact every time.

---

## HN title

> Show HN: Relay — multi-step Claude Code flows that resume after
> crashes and never surprise-bill you

---

## Discord pitch

> If you've hit the "Claude forgot what it was doing" wall, or woken up
> to an API bill you thought your subscription covered, Relay is for you.
> It's a CLI that runs multi-step Claude Code flows with checkpoint,
> resume, and explicit billing mode. One command from install to
> shipping a report: `relay run codebase-discovery .`.

---

## 30-second talk pitch

> Claude Code is great for conversation. But when you want to build a
> real multi-step flow on top of it — the kind with handoffs passed
> between steps, survival across crashes, and a deterministic artifact
> at the end — you're on your own. People end up writing shell scripts
> they can't re-run, or adopting generic orchestration frameworks that
> don't know anything about Claude.
>
> Relay is a small CLI and TypeScript library that closes that gap. You
> define your flow in a typed TS file, point Relay at it, and get back a
> run with checkpointed state, transparent cost, and a subscription-safe
> default that refuses to bill your API account by surprise. One command
> gets you from "I installed this" to "I have an HTML report describing
> this unknown codebase." That's the pitch.

---

## GitHub repo description

> Claude flows you can run twice. Multi-step flows with
> checkpoint/resume, transparent cost, and subscription-safe defaults.

---

## package.json description

```
Run deterministic multi-step Claude Code flows with checkpoint and resume.
```

Use this exact string in the `description` field of `@relay/core` and `@relay/cli`.

---

## relay.dev about paragraph

> Relay is an open-source CLI and TypeScript library for building
> deterministic multi-step flows on top of Claude Code. Made by
> Ganderbite, dogfooded on our own codebase-discovery and API-audit
> flows. MIT licensed. Install with `npm install -g @relay/cli`.

---

## Feature copy blocks

**Run twice, get the same result.**
Every flow is a typed DAG in a file. Same input, same steps, same artifact — reproducible by design.

**Survive crashes.**
State is saved after every step. A failed run resumes with `relay resume <runId>`. Successful work never gets redone.

**Never surprise-billed.**
The CLI checks your auth before the first token. If `ANTHROPIC_API_KEY` is set, Relay refuses to run until you opt in.

**Hire a pre-built flow.**
The public catalog ships verified flows for codebase discovery, API audits, and migration planning. Installable in one command.

---

## Glossary

The block below is reproduced verbatim in `relay --help glossary`. Do not paraphrase.

```
flow        a named, versioned sequence of steps you can run
step        one node in a flow (prompt, script, branch, parallel)
handoff     the JSON one step produces and a later step consumes
run         one execution of a flow; identified by a run id
checkpoint  the saved state of a run after each step completes
```
