# Relay — Product Specification

**Status:** v1 Product Design
**Date:** 2026-04-17
**Owner:** Ganderbite
**Design companion to:** `pipelinekit-tech_spec.md`

---

## 0. Reading Guide

This is the *product* spec — the side of the product the user sees, touches, and
talks about. It is a sibling to the technical spec, not a substitute for it.

Where the tech spec answers **"what does it do and how is it built?"** this
document answers four questions:

1. **Who is it for, and what problem do they actually feel?**
2. **How does it introduce itself?** (name, voice, brand, first impression)
3. **What does it look like on screen?** (CLI output, ASCII, progress, errors)
4. **How do we tell strangers they need it?** (messaging, README hero, launch)

If the tech spec ships without this spec, engineers will invent these answers
ad-hoc — and the product will be correct but forgettable. If this spec ships
without the tech spec, we have a beautiful promise we cannot keep. Both matter.

A note on naming: the working name in the tech spec is "PipelineKit." This
document recommends a rename to **Relay** (rationale in §3). Every visual,
copy, and command example below assumes Relay. If the name sticks, the tech
spec can be search-and-replaced in an afternoon. If not, the visual grammar
below transfers to any short, concrete name (cascade, baton, conduit).

---

## 1. The Problem (as the user feels it)

The tech spec describes what Relay *does*. This section describes the three
moments in a Claude Code power user's life that Relay eliminates — because
those moments are the real product.

### 1.1 The "Claude forgot" moment

> You've been driving a multi-step Claude Code workflow for thirty minutes.
> Step 4 fails. You don't know what Claude saw in steps 1–3. Starting over
> means starting over.

This is the single most common frustration among people who try to do
anything ambitious with Claude Code. They hit it once, try harder, hit it
twice, and decide "Claude Code is for small tasks." The ceiling on user
ambition is set by this moment.

### 1.2 The surprise bill

> You ran a long flow overnight. You assumed it was billing your Max
> subscription. You wake up to a $47 API charge because
> `ANTHROPIC_API_KEY` was set in your `.zshrc` from that time last month
> you were testing the SDK.

This happens. It's well-documented (Anthropic GitHub #37686). It destroys
trust with a single incident, and once trust is destroyed with a CLI tool,
users do not come back.

### 1.3 The copy-paste ritual

> You're manually shuttling Claude's output from one prompt to the next.
> The JSON from step 1 is almost-but-not-quite-valid after Claude's
> preamble. You strip the backticks by hand. You paste it into step 2.
> You repeat this six times. You are sweating. This is not engineering.

Power users know this is the wrong shape. They reach for LangGraph, find it
too generic. They reach for SuperClaude, find it too opinionated. They reach
for `aaddrick/claude-pipeline`, find it's a static template, not a tool.

**Relay's product promise is that these three moments never happen again.**

---

## 2. The Promise

One sentence for the tagline slot. Five for the elevator pitch. Everything
else in this document flows from this block.

### Tagline (one line)

> **Relay — Claude pipelines you can run twice.**

### One-liner (what it is, literally)

> Relay is a CLI and TypeScript library for running multi-step Claude Code
> workflows that resume after crashes, never surprise you with a bill, and
> produce the same artifact every time.

### Elevator pitch (three sentences)

> If you've ever lost thirty minutes of Claude Code progress to a single
> failed step, or woken up to an API bill you thought your subscription
> covered, Relay is the tool you've been building in pieces. Define your
> workflow in a small TypeScript file, point Relay at it, and watch a
> crash-proof, cost-transparent, subscription-safe pipeline execute on
> your machine. Installable flows from the catalog get you a production
> artifact in one command — `relay run codebase-discovery .`.

### Landing-page hero (what appears above the fold)

```
    ●─▶●─▶●─▶●

    Claude pipelines you can run twice.

    Deterministic orchestration. Crash-proof state.
    Transparent cost. Runs on your Pro/Max subscription.

    ─────────────────────────────────

      $ npx relay run codebase-discovery .

    ─────────────────────────────────

    [ install ]  [ watch 2-minute demo ]  [ browse catalog ]
```

The implicit argument: *one command, real pipeline, no hidden costs.* Every
other message below supports this.

---

## 3. The Name

### 3.1 Why not "PipelineKit"

The tech spec's open questions (§10.1) flagged it: "PipelineKit" is
descriptive but generic. Three specific concerns:

- **Every orchestration tool is a "pipeline kit."** The name describes a
  category, not a product. It does no work on the reader's attention.
- **No mental hook.** You cannot evangelize "PipelineKit" at a conference
  bar. You can evangelize "Relay."
- **npm / trademark risk.** The `pipelinekit` npm namespace is plausible
  but crowded-adjacent. `relay` collides with existing packages but the
  scoped `@relay-ai/*` or `@relay/*` is available paths (verify at
  registration).

### 3.2 Why "Relay"

A relay race is a team of runners passing a baton. Each runner does their
leg and hands off. The whole team's time depends on every leg, but also on
every handoff. The metaphor lines up with the product's actual primitives
without contortion:

| Product primitive | Relay metaphor |
|---|---|
| Flow | The race |
| Step | A leg / a runner |
| Handoff | The baton |
| Checkpoint / resume | The baton survives if a runner stumbles |
| Cost transparency | You see every split time |
| Catalog flow | A pre-trained team you can hire |

"Relay" is also short, typable, memorable, and already familiar — the word
does not require explanation. Users understand the metaphor the first time
they see the CLI output.

### 3.3 Fallbacks (ranked)

If `relay` on npm is blocked and we cannot secure a workable scope:

1. **Baton** — doubles down on the handoff metaphor. More distinctive,
   slightly more quirky.
2. **Cascade** — clean, visual, slightly more generic.
3. **Conduit** — more technical-sounding; appeals to infra-minded users.
4. **PipelineKit** — acceptable fallback; describes the category.

### 3.4 Namespace implications

If we adopt Relay, the tech spec's package names map as:

| Tech spec name | Relay name |
|---|---|
| `@pipelinekit/core` | `@relay/core` |
| `@pipelinekit/cli` | `@relay/cli` |
| `@pipelinekit/generator` | `@relay/generator` |
| `@ganderbite/flow-*` | `@ganderbite/relay-*` |
| `flows.pipelinekit.dev` | `relay.dev` or `relay.ganderbite.com` |

The binary name is `relay`. The CLI verb is `run`. The full-form command
`relay run codebase-discovery .` reads as English.

---

## 4. Brand & Voice

### 4.1 Voice principles

Power users hate cuteness in terminal tools. They also hate condescension.
Relay's voice is **calm, specific, and honest**. It sounds like a senior
engineer giving you a status update, not a product trying to entertain you.

| Do | Don't |
|---|---|
| State what happened | Celebrate what happened |
| Give exact numbers | Round for vibes |
| Name the next action | Hope the user figures it out |
| Label costs honestly | Bury cost disclosures |
| Say "subscription (max)" | Say "Pro user! 🚀" |

### 4.2 Copy rules

- Every error message names the specific file/line/command that caused it,
  then names the exact command to try next.
- The word "simply" is banned. If something were simple, we would have
  automated it.
- Numbers over adjectives. "2.1s" beats "quickly." "$0.38" beats "low cost."
- Second person ("you"), present tense, active voice.
- No trailing exclamation marks. One exception: the final completion
  message may end with a period or nothing. No `!`.

### 4.3 Colors & symbols (TTY)

- **Green** for completed steps, successful auth, money-in-subscription.
- **Yellow** for in-flight work, warnings, API-billing mode.
- **Red** for failed steps, broken auth, refused runs.
- **Gray** (dim) for pending steps, metadata, secondary text.
- **No color** when stdout is not a TTY — one INFO line per event.

Symbol vocabulary (consistent across every command):

| Symbol | Meaning |
|---|---|
| `✓` | Step or check succeeded |
| `✕` | Step or check failed |
| `⚠` | Warning, user should read |
| `⠋` (spinner) | Step is running |
| `○` | Pending |
| `·` | Separator |
| `●─▶●` | The relay mark (logo/signature) |
| `▶` | Arrow / flow direction |

These are Unicode, not emoji. They render cleanly in every terminal we
care about. No emoji anywhere in output.

---

## 5. The Mark (ASCII Identity)

### 5.1 The signature

The one thing users should recognize across every surface:

```
●─▶●─▶●─▶●
```

Four nodes, three arrows. Reads as "steps connected by handoffs." It is:

- **Short.** Renders on one line at any terminal width.
- **Semantic.** The shape *is* the product.
- **Composable.** Can prefix a banner, end a signature line, bracket a
  version number. Works at any color.
- **Copy-pasteable.** Users can paste it into READMEs and GitHub comments.

Use sites:

- Every banner starts with it.
- `relay --version` prints it next to the version.
- The catalog homepage uses it as a favicon-scale mark.
- The GitHub social preview image centers it on a dark background.

### 5.2 Alternative marks (rejected, documented for posterity)

```
  [ · · · ]              # too abstract
  ▸▸▸                     # reads as "fast-forward," wrong affordance
  R─E─L─A─Y              # letter-based, fights the metaphor
```

### 5.3 Wordmark

For places where the mark alone is ambiguous (headers, page titles):

```
●─▶●─▶●─▶●  relay
```

Always lowercase in the wordmark. Uppercase "Relay" is acceptable in prose
sentences where it's the first word or in proper-noun position.

---

## 6. CLI UX — the Surface Users Touch

This is the most important section in the document. Every command below
specifies its happy-path output, its failure output, and the copy the user
reads.

### 6.1 `relay` (help / splash)

Running `relay` with no arguments prints a compact help page. No long
scroll of flags. The goal is "what can I do?" at a glance.

```
●─▶●─▶●─▶●  relay · Claude pipelines you can run twice

USAGE
    relay <flow> [input]           run a flow (shorthand)
    relay run <flow> [input]       same, explicit form
    relay resume <runId>            continue a failed or stopped run
    relay doctor                    check your environment before running

CATALOG
    relay list                      flows installed in this project
    relay search <query>            find flows in the public catalog
    relay install <flow>            add a flow to this project
    relay upgrade [<flow>]          fetch the latest version

AUTHORING
    relay new <name>                scaffold a new flow
    relay test [<flow>]             run a flow's snapshot tests
    relay publish                   lint + publish a flow to npm

DIAGNOSTICS
    relay runs                      recent runs in this directory
    relay logs <runId>              structured run log
    relay --help <command>          help for a specific command

LEARN
    ●─▶●─▶●─▶●   relay.dev                    the catalog
    ●─▶●─▶●─▶●   relay.dev/docs/first-flow    scaffold one in 5 minutes
```

### 6.2 `relay doctor`

The first command a new user should run. Also the first command in any
CI job. Its job is to confirm — or deny — that the environment is safe
to run a flow in.

#### Happy path:

```
●─▶●─▶●─▶●  relay doctor

 ✓ node         20.10.0  (≥ 20.10 required)
 ✓ claude       2.4.1 at /usr/local/bin/claude
 ✓ auth         subscription (max) via CLAUDE_CODE_OAUTH_TOKEN
 ✓ env          no conflicting ANTHROPIC_API_KEY
 ✓ dir          ./.relay writable

ready to run.
```

#### Blocking failure (the money-saver):

```
●─▶●─▶●─▶●  relay doctor

 ✓ node         20.10.0  (≥ 20.10 required)
 ✓ claude       2.4.1 at /usr/local/bin/claude
 ✓ auth         subscription (max) via CLAUDE_CODE_OAUTH_TOKEN
 ✕ env          ANTHROPIC_API_KEY is set in your environment
                  running a flow now would bill your API account,
                  not your Max subscription.

                  fix:      unset ANTHROPIC_API_KEY
                  permanent: remove the line from ~/.zshrc
                  override: relay run --api-key (opts into API billing)

 ✓ dir          ./.relay writable

1 blocker before you can run.
```

Exit code 3 (§8.2 of the tech spec). The copy names the file, the command,
and the override — the user never needs to google "how to unset env var."

### 6.3 `relay run <flow>` — the launch banner

Before the first token is spent, the runner prints a pre-flight banner.
This is where trust is earned. Three specific facts, unambiguously stated.

```
●─▶●─▶●─▶●  relay

flow     codebase-discovery v0.1.0
input    .  (audience=both)
run      f9c3a2  ·  2026-04-17 14:32
bill     subscription (max)  ·  no api charges
est      $0.40  ·  5 steps  ·  ~12 min

press ctrl-c any time — state is saved after every step.
───────────────────────────────────────────────────────
```

Rules:

- The `bill` line is never silent. Every run says which account pays.
- The `est` line labels dollars as estimated, matches the tech spec's
  honesty about subscription billing (§4.7).
- The final gray line is a contract: *your work will survive ctrl-c.*

### 6.4 `relay run <flow>` — the live progress display

The hero UX moment of the product. This is what users screenshot and
share. This is what convinces coworkers to try Relay.

```
●─▶●─▶●─▶●  codebase-discovery · f9c3a2

 ✓ inventory       sonnet     2.1s    1.4K→0.3K    $0.005
 ⠋ entities        sonnet     turn 3  0.8K→0.4K    ~$0.019
 ⠋ services        sonnet     turn 2  0.7K→0.3K    ~$0.017
 ○ designReview    waiting on entities, services
 ○ report          waiting on designReview

 est  $0.40    spent  $0.11    elapsed  00:47    ctrl-c saves state
```

Design decisions — each one is deliberate:

- **Step names left-aligned, monospace width.** The eye scans the status
  column, not the label column. Status is the live signal.
- **Model shown per step.** Users want to verify "did it use sonnet or
  opus?" without digging through logs.
- **Token counts as `in→out`.** Compact, readable, honest about ratios.
- **Live cost accrual per step** prefixed with `~` because it's
  estimated-in-flight.
- **Spent vs. est at the bottom.** At a glance: are we on budget?
- **"waiting on X, Y"** not "pending." Explicit about *why* it's waiting.
- **Ctrl-C reminder at the bottom.** Never out of sight.

When stdout is not a TTY (CI, piped, redirected), the fallback is one
newline-delimited line per state transition:

```
2026-04-17T14:32:01Z info  step.start   stepId=inventory  model=sonnet
2026-04-17T14:32:03Z info  step.end     stepId=inventory  durMs=2104  costUsd=0.005
2026-04-17T14:32:03Z info  step.start   stepId=entities   model=sonnet
2026-04-17T14:32:03Z info  step.start   stepId=services   model=sonnet
```

### 6.5 `relay run <flow>` — successful completion

```
●─▶●─▶●─▶●  codebase-discovery · f9c3a2  ✓

 ✓ inventory       sonnet     2.1s     $0.005
 ✓ entities        sonnet     4.8s     $0.021
 ✓ services        sonnet     5.1s     $0.023
 ✓ designReview    -          0.1s     $0.000
 ✓ report          sonnet     3.9s     $0.329

all 5 steps succeeded in 11m 42s

cost     $0.38  (estimated api equivalent; billed to subscription)
output   ./.relay/runs/f9c3a2/report.html

next:
    open the report        open ./.relay/runs/f9c3a2/report.html
    run again fresh        relay run codebase-discovery . --fresh
    share with team        relay share f9c3a2   (coming v1.1)
```

The final `next:` block is not decoration — it is the user's menu. After
eleven minutes of running, they have decisions to make. We list them.

### 6.6 `relay run <flow>` — failure

This is the *most* important UX moment. A failing pipeline is when trust
is won or lost.

```
●─▶●─▶●─▶●  codebase-discovery · f9c3a2  ✕

 ✓ inventory       sonnet     2.1s     $0.005
 ✓ entities        sonnet     4.8s     $0.021
 ✓ services        sonnet     5.1s     $0.023
 ✕ designReview    exit 1     0.2s
      branch 'entities' raised HandoffSchemaError
      handoff 'entities' missing required field: entities[3].language

3 of 5 steps succeeded · $0.049 spent · state saved

to resume after fixing:
    relay resume f9c3a2

to restart from scratch:
    relay run codebase-discovery . --fresh

to inspect:
    relay logs f9c3a2                   full structured log
    cat ./.relay/runs/f9c3a2/handoffs/entities.json
```

Rules for failure messages:

1. **Always name the successful work.** "3 of 5 steps succeeded" reassures
   the user their progress isn't lost.
2. **Always name the cost so far.** Users want to know what they paid for
   the partial work.
3. **Always show the resume command, verbatim.** Never ask the user to
   figure out the syntax.
4. **Point to the artifact that caused the failure.** `cat
   ./.relay/runs/f9c3a2/handoffs/entities.json` lets the user reproduce
   the failure locally without running Claude.

### 6.7 `relay resume <runId>`

```
●─▶●─▶●─▶●  relay resume f9c3a2

flow     codebase-discovery v0.1.0
picking up from: designReview

 ✓ inventory       (cached, ran 14:32)
 ✓ entities        (cached, ran 14:33)
 ✓ services        (cached, ran 14:33)
 ⠋ designReview    running
 ○ report          waiting on designReview

spent so far: $0.049 · resume cost est: $0.33
```

The word "cached" is stronger copy than "skipped" — it reassures the user
that previous work counts. The spent-vs-to-come accounting continues
across the resume boundary.

### 6.8 `relay list` / `relay search` / `relay install`

`relay list` — what's installed:

```
●─▶●─▶●─▶●  installed flows (./.relay/flows/)

 codebase-discovery    v0.1.0    20m  $0.40   PM-ready report on an unknown repo
 api-audit             v0.2.1    15m  $0.25   surface stale or risky HTTP routes

2 flows installed. search more: relay search <query>
```

`relay search migration` — the catalog:

```
●─▶●─▶●─▶●  search: migration

 migration-planner          v0.3.0    25m  $0.60    verified
 dependency-upgrade-plan    v0.1.4    12m  $0.30    verified
 framework-port             v0.0.2    30m  $0.80    community

3 matches. install with: relay install <name>
```

The `verified` badge is a trust signal — flows that Ganderbite has
hand-reviewed vs. community flows. The tech spec's catalog tiers
(§7.5-ish) wire this up.

`relay install codebase-discovery` — installation:

```
●─▶●─▶●─▶●  installing codebase-discovery

 ✓ resolved @ganderbite/relay-codebase-discovery@0.1.0 from npm
 ✓ unpacked to ./.relay/flows/codebase-discovery/
 ✓ compiled flow.ts
 ✓ validated flow definition against @relay/core

installed in 4.1s.

try it:
    relay run codebase-discovery .
```

### 6.9 `relay new <name>` — the scaffolder

Handoff to the Claude Code skill if installed, fallback to a local
template otherwise. When the skill picks up:

```
●─▶●─▶●─▶●  relay new

the relay generator skill is installed in claude code.

open a new claude code session in this directory and say:

    scaffold a new relay flow

or, to skip the skill and start from a blank template:

    relay new my-flow --template blank
```

When the skill is *not* installed, the CLI emits a static template without
prompting:

```
●─▶●─▶●─▶●  relay new my-flow (blank template)

 ✓ wrote ./my-flow/package.json
 ✓ wrote ./my-flow/flow.ts
 ✓ wrote ./my-flow/prompts/hello.md
 ✓ wrote ./my-flow/README.md
 ✓ installed dev dependencies

try it:
    cd my-flow && relay run .
```

### 6.10 `relay --version`

```
●─▶●─▶●─▶●  relay 1.0.0
           @relay/cli 1.0.0
           @relay/core 1.0.0
           node 20.10.0 · claude 2.4.1
```

Every debug report a user pastes into an issue includes this. It is four
lines, not twelve. Make it easy to paste.

---

## 7. Moments That Matter (the end-to-end UX)

The CLI output above covers the individual surfaces. This section stitches
them into the end-to-end narrative of *the user's first encounter with
Relay.* Every moment here is a decision point where we can earn or lose the
install.

### 7.1 Moment 1: hearing about Relay

Happens on HN, Reddit, Claude Code Discord, Twitter, a coworker's Slack.
The canonical shareable artifact is this GIF (render via `vhs`):

```
$ npx relay run codebase-discovery .

●─▶●─▶●─▶●  relay
flow     codebase-discovery v0.1.0
bill     subscription (max)  ·  no api charges
est      $0.40  ·  5 steps  ·  ~12 min
────────────────────────────────────────
 ✓ inventory     2.1s   $0.005
 ⠋ entities      turn 3...
 ⠋ services      turn 2...
 ○ designReview  waiting
 ○ report        waiting
────────────────────────────────────────
...
 ✓ all 5 steps succeeded in 11m 42s
 output: ./.relay/runs/f9c3a2/report.html
```

What the GIF communicates in 30 seconds: *one command, real pipeline, no
hidden costs, you get a real artifact.* This is the viral unit.

### 7.2 Moment 2: the README

The top of the README is the user's second encounter. It must lead with
the promise, not the architecture.

```markdown
<p align="center">
  <br>
  <code>●─▶●─▶●─▶●  relay</code>
  <br><br>
  <strong>Claude pipelines you can run twice.</strong>
  <br><br>
</p>

Deterministic orchestration. Crash-proof state. Transparent cost.
Runs on your Pro/Max subscription — no surprise API bills.

## 60-second tour

```bash
npm install -g @relay/cli
relay doctor                              # check your environment
relay run codebase-discovery .            # ship a real artifact
```

The first command tells you if you're safe to run. The second command
produces an HTML report describing this repo — in about 12 minutes,
for about $0.40 (estimated API equivalent; billed to your subscription).
```

The rest of the README follows the tech spec's §7.4 — what it does,
sample output, cost/duration, install, run, configure, customize, license.

### 7.3 Moment 3: the first `relay doctor`

The user types `relay doctor` because the README told them to. One of
three things happens:

- **All green.** They move on confidently. We earned trust in three
  seconds.
- **Blocker found (ANTHROPIC_API_KEY).** The error message names the
  exact command to unset it and the exact override if they want API
  billing. We prevented a $50 mistake before it happened. They will tell
  people.
- **`claude` not installed.** We link to Anthropic's install page and
  name the minimum version. They install it and run `relay doctor` again.

No branch of this produces a dead-end. No branch requires googling.

### 7.4 Moment 4: the first run

After `doctor` is green, the user runs the suggested catalog flow. The
banner appears, the progress display ticks, eleven minutes pass. At the
end, they have:

1. A real artifact on disk (HTML report, markdown doc, migration plan).
2. A precise cost number ($0.38, labeled honestly).
3. A feeling that *this tool knows what it's doing.*

The third is the one we design for. Every piece of output, every label,
every gray line of secondary text contributes to it.

### 7.5 Moment 5: the first failure

This will happen. A prompt step returns malformed JSON, an exit-code-1
script breaks the chain, the network blips mid-flow.

The product's job is to make this feel like a *pause*, not a *loss*. The
failure display in §6.6 does this work: 3 of 5 steps succeeded, $0.049
spent, resume command shown, handoff file pointed to. The user fixes the
issue, runs `relay resume f9c3a2`, and the run finishes. They tell one
person about this.

### 7.6 Moment 6: the second run

The user runs the same flow again, on a different codebase. Same banner,
same progress, same artifact. *It worked the same way.* This is the
"run twice" promise made concrete.

They now reach for Relay for their next pipeline-shaped problem. They
become a user.

### 7.7 Moment 7: the first flow they write

Happens weeks later. They hit a problem they can't solve with a catalog
flow. They type `relay new my-flow`, the generator skill walks them
through it, they write four prompts, they run `relay run .`, it works.

This is the conversion from *user* to *author*. Authors are the seed of
the catalog. Authors stay.

---

## 8. Messaging Kit

A paste-ready set of copy blocks for the team to reuse verbatim across
README, landing page, HN post, Twitter bio, conference talk abstract.

### 8.1 One-liners (pick one per context)

- **Tagline:** Claude pipelines you can run twice.
- **Alt tagline:** The orchestrator for Claude Code that remembers.
- **Utilitarian:** Deterministic, subscription-safe Claude workflows.
- **For infra folks:** Crash-proof Claude pipelines in a single CLI.

### 8.2 The 140-character pitch

> Relay runs multi-step Claude Code workflows that survive crashes, never
> surprise-bill your API account, and ship the same artifact every time.

### 8.3 The HN title

> Show HN: Relay — multi-step Claude Code workflows that resume after
> crashes and never surprise-bill you

The specificity is load-bearing. "Multi-step" rules out small queries.
"Resume after crashes" names a pain the audience has felt. "Never
surprise-bill you" is the hook that gets the click.

### 8.4 The Anthropic Discord pitch

> If you've hit the "Claude forgot what it was doing" wall, or woken up
> to an API bill you thought your subscription covered, Relay is for you.
> It's a CLI that runs multi-step Claude Code workflows with checkpoint,
> resume, and explicit billing mode. One command from install to
> shipping a report: `relay run codebase-discovery .`.

### 8.5 The README "why not X" table

| I already use... | ...and Relay gives you |
|---|---|
| `claude -p` in a shell script | checkpoint, resume, typed handoffs, cost tracking, TTY progress |
| LangGraph or CrewAI | a Claude-native runner; no framework to learn; ships with pre-built flows |
| SuperClaude / BMAD | a tool, not a persona layer; you define the pipeline |
| `aaddrick/claude-pipeline` | a generator + catalog, not a static template to hand-adapt |
| Claude Code Skills | multi-step orchestration across skills, with state and resume |

This table is the "why adopt Relay, specifically" answer. It goes on the
README and the landing page. It does not apologize for other tools.

### 8.6 Feature copy (for the landing page)

Four blocks. Headline + one sentence each. No emojis, no marketing verbs.

> **Run twice, get the same result.**
> Every flow is a typed DAG in a file. Same input, same steps, same
> artifact — reproducible by design.

> **Survive crashes.**
> State is saved after every step. A failed run resumes with
> `relay resume <runId>`. Successful work never gets redone.

> **Never surprise-billed.**
> The CLI checks your auth before the first token. If
> `ANTHROPIC_API_KEY` is set, Relay refuses to run until you opt in.

> **Hire a pre-built flow.**
> The public catalog ships verified flows for codebase discovery, API
> audits, and migration planning. Installable in one command.

---

## 9. Comparison & Positioning Grid

A one-page chart for the landing page. Users who arrive with a tool
already in mind will find their answer here.

```
                  stateful  subscription-   pre-built   Claude-
                  resume    safe by default flows       native
                  ────────  ──────────────  ─────────   ───────
 Relay            ✓         ✓               catalog     ✓
 claude -p shell  ·         depends on env  ·           ✓
 LangGraph        partial   ·               ·           ·
 CrewAI           ·         ·               ·           ·
 SuperClaude      ·         depends on env  ·           ✓
 claude-pipeline  ·         ·               templates   ✓
 Skills (native)  ·         ✓               ·           ✓
```

The four columns are the four things a reader cares about in this space.
Relay is the only tool that fills all four. That's the pitch.

---

## 10. Visual & Asset System

### 10.1 Terminal output rendering

- Monospace-first. Every visual in this doc must render identically in
  default macOS Terminal, iTerm2, Alacritty, Kitty, Windows Terminal,
  and the common Linux terminals.
- No Nerd Font dependencies. Unicode box-drawing + geometric shapes
  only.
- 80-column-safe. Every banner and table must fit in 80 columns. Wider
  terminals get more whitespace, not wider tables.

### 10.2 Documentation rendering

- Code blocks quote CLI output verbatim. Never "pretty up" terminal
  output with emoji or pseudo-color in screenshots. Render real output,
  then use the CLI's own color scheme.
- GIFs: `vhs` with a consistent cassette (12 fps, Menlo 14pt, 800x500).
- Social cards: the `●─▶●─▶●─▶●` mark centered on `#0e1116`.

### 10.3 Catalog site (`relay.dev`)

v1 is a static site. Structure:

```
relay.dev/
├── /                    hero + 60-second tour + catalog preview
├── /flows               full catalog, filterable by tag
├── /flows/<name>        per-flow landing page with sample output
├── /docs                installation, first flow, authoring guide
├── /docs/first-flow     the 5-minute tutorial
└── /blog                launch posts, monthly catalog updates
```

Each per-flow page carries:

- The flow's `pipelinekit` metadata block from the tech spec (§7.2)
  rendered as "cost: $0.20–$0.80 · duration: 5–20 min · audience: pm,dev".
- A live code sample: the `relay run <flow>` invocation.
- The HTML artifact rendered inline (for the codebase-discovery family)
  or a screenshot (for everything else).
- Install tab + Run tab + Customize tab.

---

## 11. What Users Want to See During Execution (the live display,
specified)

This section exists because the task briefed it explicitly. It expands
on §6.4 with the moment-by-moment information scent users actually need.

### 11.1 What users are looking for, in priority order

1. **Is it working?** — the spinner must *move.* A frozen spinner = panic.
2. **What step am I on?** — the step name must be unambiguous.
3. **How much have I spent?** — live cost accrual, at the bottom.
4. **How long until it's done?** — rough ETA, at the bottom.
5. **What will happen if I ctrl-c?** — always visible on the last line.

That's the hierarchy. Every other piece of information is secondary.

### 11.2 The three zones of the display

```
┌─────────────────────────────────┐
│  HEADER (fixed, one line)       │  → flow name + run id
├─────────────────────────────────┤
│                                  │
│  STEP GRID (one line per step)   │  → the primary scan target
│                                  │
├─────────────────────────────────┤
│  FOOTER (fixed, two lines)       │  → totals + ctrl-c hint
└─────────────────────────────────┘
```

Rules:

- **Header is static.** No information that changes during the run.
- **Step grid reflows only when step state changes.** Spinner frames tick
  in place; the grid doesn't scroll.
- **Footer never disappears.** Even at the narrowest terminal width, the
  ctrl-c reminder stays visible.

### 11.3 Per-step information, specified

```
 ⠋ entities        sonnet     turn 3  0.8K→0.4K    ~$0.019
 │ │                │          │       │             │
 │ └ step name      │          │       │             └ live cost estimate
 │                  │          │       └ tokens in → tokens out
 │                  │          └ progress within the step
 │                  └ model being used
 └ live status symbol
```

Columns are width-fixed so the eye can scan diagonally down a column
without re-anchoring.

### 11.4 What we deliberately DON'T show during execution

- **No raw Claude output.** This is not a REPL. Users who want raw
  output can `tail -f ./.relay/runs/<id>/run.log`.
- **No progress bar.** We don't know the step's duration in advance; a
  fake progress bar is worse than none. The spinner is honest.
- **No percentage complete.** Same reason. "4 of 5 steps done" is
  honest; "80%" is not.
- **No emoji-laden celebrations.** The `✓` is the celebration.

### 11.5 What happens on ctrl-c

```
^C

●─▶●─▶●─▶●  codebase-discovery · f9c3a2  (paused)

 ✓ inventory       sonnet     2.1s     $0.005
 ✓ entities        sonnet     4.8s     $0.021
 ⊘ services        cancelled mid-step (turn 2)
 ○ designReview    not started
 ○ report          not started

state saved. $0.026 spent.

resume: relay resume f9c3a2
```

Ctrl-c is not an error. It's "I'll finish this later." The display
reflects that — paused, not failed. Resume is the very next line.

---

## 12. Error States (every error has a name and a next action)

The product's stance on errors: every error message is a small piece of
UX. The user is frustrated. Our job is to point at the next action, not
explain the underlying system.

### 12.1 Error message template

```
✕ <one-line headline>

  <one-sentence explanation in plain English>

  → <exact command or edit to try next>
```

### 12.2 The common errors, written

**`ANTHROPIC_API_KEY` set (the big one):**

```
✕ Refusing to run: ANTHROPIC_API_KEY would override your subscription

  Relay detected ANTHROPIC_API_KEY in your environment. Running now would
  bill your API account instead of your Max subscription — a surprise we
  prevent by default.

  → unset ANTHROPIC_API_KEY                 use subscription (recommended)
  → relay run codebase-discovery . --api-key  explicitly use API billing
  → relay doctor                             full environment check
```

**Flow definition error (cycle in DAG):**

```
✕ Flow has a dependency cycle

  Steps form a cycle: inventory → entities → services → inventory

  → edit flow.ts to remove the back-edge from services to inventory
```

**Handoff schema mismatch:**

```
✕ Handoff 'entities' failed schema validation

  Step 'entities' produced JSON that doesn't match its declared schema:
    entities[3].language expected one of ['ts','py','go','rust','other']
    got: "javascript"

  → relay logs f9c3a2 --step entities        see what Claude produced
  → edit prompts/02_entities.md              tighten the prompt
  → relay resume f9c3a2                      retry after fixing
```

**Timeout:**

```
✕ Step 'report' timed out after 10m 0s

  The prompt ran longer than its configured timeout. This usually means
  the prompt is asking for too much in a single turn, or a tool call is
  hanging.

  → check the partial output: ./.relay/runs/f9c3a2/artifacts/report.html.partial
  → raise the timeout in flow.ts: step.prompt({ timeoutMs: 20 * 60 * 1000 })
  → relay resume f9c3a2                      retry with the new config
```

**Claude CLI missing:**

```
✕ 'claude' command not found

  Relay invokes the Claude CLI. It's not installed on this machine.

  → install: https://claude.com/code/install
  → then run: relay doctor
```

Every error above follows the template. Every error names the next
command to type. No error ends with the user having to google.

---

## 13. Naming Conventions (the internal vocabulary)

Power users care about names because they type them. The tech spec
defines the vocabulary in §4.1; this section commits to the user-facing
words and the words to *avoid*.

| Concept | The word we use | Words to avoid |
|---|---|---|
| The thing a user runs | **flow** | "pipeline" (too generic), "workflow" (too loaded) |
| A node in the flow | **step** | "task" (conflicts with TaskCreate), "stage" |
| Structured data between steps | **handoff** | "context," "message" |
| A single execution of a flow | **run** | "session" (conflicts with Claude session), "job" |
| A point-in-time snapshot | **checkpoint** | "save," "state" (the file is called state.json, but the UX word is checkpoint) |
| A fetched, installed flow | **catalog flow** | "template" (implies you customize it) |
| The ganderbite-reviewed tier | **verified** | "official," "recommended" |

One-line glossary that appears in `relay --help glossary`:

```
flow        a named, versioned pipeline you can run
step        one node in a flow (prompt, script, branch, parallel)
handoff     the JSON one step produces and a later step consumes
run         one execution of a flow; identified by a run id
checkpoint  the saved state of a run after each step completes
```

---

## 14. The Catalog as a Product Surface

The tech spec treats the catalog as downstream of the three packages.
This spec argues the catalog is the *product's primary storefront* —
the thing that converts first-time visitors into users.

### 14.1 Minimum viable catalog

Three flows at launch (from tech spec §9.4):

1. **codebase-discovery** — the canonical example; ships the HTML report.
2. **api-audit** — for the sysadmin / backend audience.
3. **migration-planner** — for the staff-engineer audience.

Each of these is a *complete* demo of Relay's value. A visitor can
arrive, read the page, and run the flow in under five minutes.

### 14.2 Per-flow page structure

```
●─▶●─▶●─▶●  codebase-discovery

Turn an unknown repo into a PM-ready HTML report. Identifies packages,
services, entities, and surfaces design-review questions.

COST        $0.20 – $0.80  (estimated API equivalent)
DURATION    5 – 20 min
AUDIENCE    PMs, new hires, stakeholders
VERIFIED    reviewed by Ganderbite · v0.1.0

─────────────────────────────────

$ npx relay run codebase-discovery .

─────────────────────────────────

[ sample output: rendered HTML report ]
[ how it works: the 5 steps, expanded ]
[ customize: fork this flow in 1 command ]
```

### 14.3 Author incentives

For the catalog to grow, third-party authors need a reason to publish.
The spec's answer:

- **Discoverability.** The catalog search surface is the audience every
  flow author wants reach into.
- **Tier badges.** `community` → `verified` → `showcase` is a ladder
  authors can climb.
- **Installation stats.** Each flow's page shows install count (from
  npm download stats). Authors can cite this.
- **Featured rotation.** The catalog homepage rotates a featured flow
  monthly. Getting featured is a real signal.

v1 does not need third-party flows. v1.x needs them. Design the catalog
such that the jump is painless.

---

## 15. Launch Plan (the product-side view)

The tech spec's §9 gives engineering milestones. This section proposes
the *launch surface* aligned to them.

### 15.1 Pre-launch (during M1–M3)

- Private demos to 10 Claude Code power users from the team's network.
  Goal: find three who will talk about it publicly at launch.
- One long-form blog post draft: *"The three moments that broke my
  Claude Code workflows (and the tool I wish had existed)."* Publishable
  the day the CLI goes live.
- A 90-second demo video showing `relay run codebase-discovery .` end
  to end. Hosted on the catalog site.

### 15.2 Launch day (M4/M5 boundary)

- HN "Show HN" post with the title in §8.3.
- Anthropic Discord #showcase announcement.
- r/ClaudeAI post.
- Tweet thread from the team's main account: screenshots of the
  progress display, cost banner, resume behavior.
- Catalog site live with three flows.

### 15.3 Post-launch (first 30 days)

- Weekly catalog update: one new flow per week for four weeks.
- A "here's what people shipped" roundup blog post at day 30.
- Office-hours session with the first 20 external authors.

### 15.4 Success criteria (product, not engineering)

- **500 GitHub stars in 30 days.** Validation of "there is a real
  audience here" from the review document.
- **10 externally-authored flows in 90 days.** Validation that the
  catalog model works.
- **One "I replaced my shell script with Relay" testimonial.** The
  specific narrative that converts skeptics.

If the first two miss by 2x, the product is smaller than we thought —
consider the pivot to "pattern library + three bundled flows" from the
review doc.

---

## 16. What This Spec Does NOT Cover

A short list of things the team will need to decide but which don't
belong in the product spec:

- **Pricing / business model.** v1 is free OSS; the question of a
  hosted tier or paid catalog is v2 territory.
- **Hosting provider for `relay.dev`.** Vercel/Netlify-grade static
  hosting is fine.
- **Trademark registration.** The name recommendation in §3 is
  contingent on clearing a search. Not blocking v1.
- **Specific verifiable flow-author agreement.** We'll need a light CLA
  for catalog contributions; not blocking v1.
- **Telemetry dashboard design.** The tech spec §8.4 defines what's
  collected. The team still needs an internal dashboard.

---

## 17. Open Product Questions (decide before launch)

1. **"Relay" final name check.** Confirm `@relay/*` npm scope
   availability, check the relay.com / relay.dev landscape. Fall back to
   §3.3 in writing before any rename costs are sunk.
2. **Does the progress display ship colored by default, or do we
   default to mono and let users opt in?** Recommendation: color by
   default when TTY + `NO_COLOR` unset, matching the
   [no-color.org](https://no-color.org) convention.
3. **`relay share <runId>` in v1 or v1.1?** Cheap to build (upload
   state.json + artifacts to an ephemeral URL), but carries privacy
   concerns (are handoffs safe to share?). Recommendation: v1.1.
4. **The `~$0.019` live-cost estimates — accurate enough to show?**
   Subscription users might find the dollar numbers confusing since
   they're not being charged. Recommendation: keep the number, keep the
   "estimated API equivalent" labeling, but also show a per-run token
   total for subscription-billed users as the primary metric.
5. **How opinionated is the starter template?** The `relay new` blank
   template could ship with a full worked example (opinionated) or a
   near-empty flow.ts (blank-canvas). Recommendation: blank-canvas, but
   link prominently to three worked examples in the catalog.

---

## 18. Appendix: Copy Snippets Ready to Paste

### 18.1 The 30-second pitch (for a talk)

> Claude Code is great for conversation. But when you want to build a
> real multi-step workflow on top of it — the kind with handoffs between
> steps, survival across crashes, and a deterministic artifact at the
> end — you're on your own. People end up writing shell scripts they
> can't re-run, or adopting generic orchestration frameworks that don't
> know anything about Claude.
>
> Relay is a small CLI and TypeScript library that closes that gap. You
> define your workflow in a typed TS file, point Relay at it, and get
> back a run with checkpointed state, transparent cost, and a
> subscription-safe default that refuses to bill your API account by
> surprise. One command gets you from "I installed this" to "I have an
> HTML report describing this unknown codebase." That's the pitch.

### 18.2 The GitHub repo description

> Claude pipelines you can run twice. Multi-step workflows with
> checkpoint/resume, transparent cost, and subscription-safe defaults.

### 18.3 The `package.json` description

> Run deterministic multi-step Claude Code workflows with checkpoint
> and resume.

### 18.4 The "about" paragraph on relay.dev

> Relay is an open-source CLI and TypeScript library for building
> deterministic multi-step workflows on top of Claude Code. Made by
> Ganderbite, dogfooded on our own codebase-discovery and API-audit
> flows. MIT licensed. Install with `npm install -g @relay/cli`.

---

## 19. The Signature

One more look at the mark, at the scale every user will encounter it:

```
●─▶●─▶●─▶●  relay
```

Four dots. Three arrows. One word. That's the product.
