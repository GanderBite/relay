# neverthrow Patterns

`neverthrow` is Relay's mechanism for type-safe error handling. Instead of `throw`, functions
return `Result<T, E>` (sync) or `ResultAsync<T, E>` (async). Every failure mode is encoded in
the return type — callers cannot accidentally ignore errors.

`@ganderbite/relay-core` re-exports neverthrow primitives so race authors and CLI code import from
one place:

```ts
import { ok, err, type Result, type ResultAsync } from '@ganderbite/relay-core';
```

---

## Core types

```ts
// A value is either Ok (success) or Err (failure)
type Result<T, E> = Ok<T, E> | Err<T, E>;

// The async variant wraps Promise<Result<T, E>> with the same chainable API
type ResultAsync<T, E>;
```

Use the existing Relay error classes as `E` — never plain strings:

```ts
Result<Race, RaceDefinitionError>
Result<string, BatonSchemaError>
ResultAsync<void, Error>
```

---

## Creating Results

```ts
import { ok, err, okAsync, errAsync } from '@ganderbite/relay-core';

// Sync
function parse(raw: unknown): Result<Config, RaceDefinitionError> {
  const r = ConfigSchema.safeParse(raw);
  if (!r.success) return err(toRaceDefError(r.error, 'invalid config'));
  return ok(r.data);
}

// Async
function readFile(path: string): ResultAsync<string, Error> {
  return ResultAsync.fromPromise(
    fs.readFile(path, 'utf8'),
    (e) => (e instanceof Error ? e : new Error(String(e))),
  );
}
```

---

## Wrapping throw-based code

Use `fromThrowable` (sync) or `fromPromise` (async) at integration boundaries — never inside
your own Result-returning functions:

```ts
import { fromThrowable, fromPromise } from '@ganderbite/relay-core';

// Sync — wraps JSON.parse which throws
const safeParse = fromThrowable(JSON.parse, (e) => new Error(`JSON parse failed: ${e}`));
const result = safeParse('{"ok":true}'); // Result<unknown, Error>

// Async — wraps a promise that may reject
const result = fromPromise(fetch('/api/data'), (e) => toNetworkError(e));
// ResultAsync<Response, NetworkError>
```

---

## Chaining operations

### `.map()` — transform Ok value, pass Err through

```ts
const upper: Result<string, RaceDefinitionError> = parse(raw).map((cfg) => cfg.name.toUpperCase());
```

### `.mapErr()` — transform Err value, pass Ok through

```ts
const result = buildGraph(runners).mapErr((e) => ({ code: e.code, message: e.message }));
```

### `.andThen()` — chain a fallible operation (short-circuits on Err)

```ts
function loadRace(path: string): Result<Race, RaceDefinitionError> {
  return readConfig(path).andThen((cfg) => defineRace(cfg));
}
```

Error types union automatically: if `readConfig` returns `Result<Config, ReadError>` and
`defineRace` returns `Result<Race, RaceDefinitionError>`, the chain returns
`Result<Race, ReadError | RaceDefinitionError>`.

### `.orElse()` — recover from Err or replace it

```ts
const result = buildGraph(runners).orElse((e) =>
  e.code === ERROR_CODES.RACE_DEFINITION ? ok(defaultGraph) : err(e),
);
```

### `.andTee()` — run side effect on Ok without consuming the value

```ts
defineRace(spec)
  .andTee((race) => logger.info({ raceId: race.id }, 'race loaded'))
  .match(startOrchestrator, reportError);
```

---

## Extracting values: `.match()` (preferred)

`.match()` is the canonical extraction point — it forces you to handle both paths:

```ts
const exitCode = defineRace(spec).match(
  (race) => { startOrchestrator(race); return 0; },
  (e) => { logger.error(e.message); return e.code === ERROR_CODES.RACE_DEFINITION ? 2 : 1; },
);
```

---

## Guards: `.isOk()` / `.isErr()` with early-return style

Inside complex sequential logic, the guard + early-return pattern is more readable than
nested `.andThen`:

```ts
function buildGraph(runners: Record<string, Runner>): Result<RaceGraph, RaceDefinitionError> {
  const topoResult = kahnTopoSort(keys, predecessors, successors);
  if (topoResult.isErr()) return err(topoResult.error);  // re-wrap to match return type
  const topoOrder = topoResult.value;

  const entryResult = resolveEntry(runnerMap, rootRunners, start);
  if (entryResult.isErr()) return err(entryResult.error);
  const entry = entryResult.value;

  return ok({ topoOrder, entry, ... });
}
```

Note: always use `err(result.error)` when propagating — returning `result` directly fails to
compile when `T` differs between the helper and the caller's return type.

---

## ResultAsync — async chains

`ResultAsync` is thenable; all `.map()`, `.mapErr()`, `.andThen()`, `.orElse()` methods accept
sync or async callbacks:

```ts
function atomicWriteText(path: string, data: string): ResultAsync<void, Error> {
  const toErr = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)));
  return ResultAsync.fromPromise(mkdir(dirname(path), { recursive: true }), toErr)
    .andThen(() => ResultAsync.fromPromise(writeFile(path, data, 'utf8'), toErr));
}
```

`.match()` on `ResultAsync` returns `Promise<A>`:

```ts
const exitCode = await doAsync().match(
  () => 0,
  (e) => { logger.error(e.message); return 1; },
);
```

---

## Combining multiple Results

```ts
import { Result } from 'neverthrow';

// Short-circuit on first error → Ok<[A, B, C]> or Err<E>
const combined = Result.combine([parseA(raw), parseB(raw), parseC(raw)]);

// Collect all errors → Ok<[A, B, C]> or Err<E[]>
const allErrors = Result.combineWithAllErrors([validateA(), validateB()]);
```

For async:

```ts
const combined = ResultAsync.combine([fetchUser(id), fetchRoles(id)]);
```

---

## Error discrimination

Use `error.code` (the `ErrorCode` constant) to discriminate without `instanceof`:

```ts
defineRace(spec).match(
  startRunner,
  (e) => {
    switch (e.code) {
      case ERROR_CODES.RACE_DEFINITION:  // RaceDefinitionError or ProviderCapabilityError
        process.exit(2);
      case ERROR_CODES.CLAUDE_AUTH:
        process.exit(3);
      default:
        process.exit(1);
    }
  },
);
```

---

## The `toRaceDefError` helper

Converts a Zod `$ZodError` into a `RaceDefinitionError` value (does not throw):

```ts
import { toRaceDefError } from '@ganderbite/relay-core';

const r = mySchema.safeParse(input);
if (!r.success) return err(toRaceDefError(r.error, 'invalid runner spec'));
```

---

## Anti-patterns

- **Do not `throw` inside a Result-returning function.** Convert errors to `err(...)` at every
  callsite. A `throw` inside an `andThen` callback will escape the Result chain entirely.
- **Do not use `_unsafeUnwrap()` in production code.** Reserve it for tests where you want
  Jest to surface the error clearly (`_unsafeUnwrap({ withStackTrace: true })`).
- **Do not use `fromSafePromise` on promises that can reject.** Use `fromPromise` with an
  error mapper instead.
- **Do not return the raw `Err` from a helper when `T` differs from the caller's return type.**
  Unwrap and re-wrap: `if (r.isErr()) return err(r.error)`.
