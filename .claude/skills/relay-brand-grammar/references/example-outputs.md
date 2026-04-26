# Example Outputs (Verbatim from Product Spec §6)

When a sprint task says "MUST match product spec §6.X verbatim," these are the canonical blocks. Copy them, don't rewrite.

## Pre-run banner (§6.3)

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

Rules: `bill` row is mandatory. The final gray line is the trust contract — never omit. The horizontal rule is 56 chars (`─` × 56).

## Live progress (§6.4)

```
●─▶●─▶●─▶●  codebase-discovery · f9c3a2

 ✓ inventory       sonnet     2.1s    1.4K→0.3K    $0.005
 ⠋ entities        sonnet     turn 3  0.8K→0.4K    ~$0.019
 ⠋ services        sonnet     turn 2  0.7K→0.3K    ~$0.017
 ○ designReview    waiting on entities, services
 ○ report          waiting on designReview

 est  $0.40    spent  $0.11    elapsed  00:47    ctrl-c saves state
```

Notes:
- One leading space before each step row.
- `~` prefix on cost when in-flight.
- `waiting on X, Y` not "pending."
- Footer line always ends with `ctrl-c saves state`.

## Success banner (§6.5)

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

The `next:` block is the user's menu. Always present.

## Failure banner (§6.6)

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

Rules:
1. Always name the successful work ("3 of 5 steps succeeded").
2. Always name the cost spent so far.
3. Always show the resume command verbatim.
4. The failing step expands to two indented lines naming the error class + the specific field.

## Doctor — happy path (§6.2)

```
●─▶●─▶●─▶●  relay doctor

 ✓ node         20.10.0  (≥ 20.10 required)
 ✓ claude       2.4.1 at /usr/local/bin/claude
 ✓ auth         subscription (max) via CLAUDE_CODE_OAUTH_TOKEN
 ✓ env          no conflicting ANTHROPIC_API_KEY
 ✓ dir          ./.relay writable

ready to run.
```

## Doctor — blocked (§6.2)

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

Exit code: 3 (ClaudeAuthError).

## Splash help (§6.1)

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

## Glossary subcommand (§13)

```
●─▶●─▶●─▶●  glossary

flow        a named, versioned pipeline you can run
step        one node in a flow (prompt, script, branch, parallel)
handoff     the JSON one step produces and a later step consumes
run         one execution of a flow; identified by a run id
checkpoint  the saved state of a run after each step completes
```

## Version output (§6.10)

```
●─▶●─▶●─▶●  relay 0.1.0
            @ganderbite/relay 0.1.0
            @ganderbite/relay-core 0.1.0
            node 20.10.0 · claude 2.4.1
```

Four lines. Optimized for paste-into-GitHub-issue.
