# Zod Patterns

Zod is the only mandatory runtime dep beyond Node built-ins for `@relay/core`. It's used for:

- Race `input` schemas (parsed by the CLI from positional args / flags).
- Baton schemas (validated on read AND write).
- Runner-level prompt output schemas (forwarded as JSON Schema to the Claude SDK).

The library re-exports `z` so race authors don't pin a mismatched version: `import { z } from '@relay/core'`.

## Schema + inferred type, always paired

```ts
import { z } from 'zod';

export const InventorySchema = z.object({
  packages: z.array(z.object({
    path: z.string(),
    name: z.string(),
    language: z.enum(['ts', 'py', 'go', 'rust', 'other']),
    entryPoints: z.array(z.string()),
  })),
});

export type Inventory = z.infer<typeof InventorySchema>;
```

Now `Inventory` and `InventorySchema` can't drift. Anywhere you have one, you have the other.

## Parsing at boundaries

The pattern: at boundaries (CLI input, file read, network response), parse with Zod. Inside the system, use the inferred type.

```ts
// ✅ At the boundary — parse, throw on invalid
async function loadInventory(path: string): Promise<Inventory> {
  const raw = JSON.parse(await readFile(path, 'utf8'));
  return InventorySchema.parse(raw);   // throws ZodError if invalid
}

// ✅ Internal code — use the type, no further validation
function summarizePackages(inv: Inventory): string {
  return `${inv.packages.length} packages`;
}
```

## `safeParse` when you want to handle errors gracefully

```ts
const result = BatonSchema.safeParse(json);
if (!result.success) {
  throw new BatonSchemaError(batonId, result.error.issues);
}
return result.data;
```

The BatonStore uses this pattern — it wraps Zod's issues in Relay's typed error.

## Schemas with defaults

```ts
export const InputSchema = z.object({
  repoPath: z.string(),
  audience: z.enum(['pm', 'dev', 'both']).default('both'),
  maxFiles: z.number().int().positive().default(100),
});

// type Input = { repoPath: string; audience: 'pm' | 'dev' | 'both'; maxFiles: number; }
// — defaults are reflected in the inferred type
```

The CLI's `parseInputFromArgv` reads the schema's `.default()` values to fill in missing positionals.

## `.describe()` for self-documenting schemas

```ts
export const InputSchema = z.object({
  repoPath: z.string().describe('Absolute or relative path to the repo to analyze'),
  audience: z.enum(['pm', 'dev', 'both']).default('both').describe('Who the report is for'),
});
```

The CLI's `renderHelpFromSchema` reads `.describe()` to generate the `--help` text.

## Refinement (custom validation beyond shape)

```ts
export const SemverString = z.string().refine(
  (s) => /^\d+\.\d+\.\d+(-.*)?$/.test(s),
  { message: 'must be a valid semver string (x.y.z)' }
);
```

Use refinements sparingly — they can't always be expressed as JSON Schema, which means they won't apply when the schema is forwarded to the Claude SDK as `--json-schema`.

## Transforms (parse + reshape in one step)

```ts
export const PortNumber = z.union([z.string(), z.number()]).transform((v) => {
  const n = typeof v === 'string' ? parseInt(v, 10) : v;
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error('invalid port');
  return n;
});
```

Useful at CLI boundaries where strings need to become typed values.

## Discriminated unions in Zod

```ts
export const RunnerOutputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('baton'),    baton: z.string(), schema: z.any().optional() }),
  z.object({ kind: z.literal('artifact'), artifact: z.string() }),
  z.object({ kind: z.literal('both'),     baton: z.string(), artifact: z.string(), schema: z.any().optional() }),
]);
```

`z.discriminatedUnion` is faster than `z.union` because it picks the variant by the discriminator instead of trying each.

## Composing schemas

```ts
const BaseRunnerSpec = z.object({
  dependsOn: z.array(z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
});

export const PromptRunnerSpec = BaseRunnerSpec.extend({
  promptFile: z.string(),
  output: RunnerOutputSchema,
  maxRetries: z.number().int().nonnegative().default(0),
});
```

`.extend()`, `.merge()`, `.pick()`, `.omit()`, `.partial()` all return new schemas without mutating.

## Forwarding to the Claude SDK as JSON Schema

The Claude Agent SDK's `output: { schema }` option expects a JSON Schema object, not a Zod schema. Convert via `zod-to-json-schema`:

```ts
import { zodToJsonSchema } from 'zod-to-json-schema';

const jsonSchema = zodToJsonSchema(InventorySchema, { target: 'jsonSchema7' });
// pass to query({ options: { output: { schema: jsonSchema } } })
```

Caveats:
- `.transform()` can't round-trip — use `.refine()` if you need both sides.
- Recursive schemas may not convert cleanly — flatten first.
- The `zod-to-json-schema` package is the only acceptable converter; the SDK accepts JSON Schema 7.

## Anti-patterns

- **Don't define a TypeScript type AND a Zod schema separately.** Always derive the type via `z.infer`.
- **Don't `.parse()` in hot loops.** Parse once at the boundary; use the typed value internally.
- **Don't catch ZodError silently.** Wrap it in a typed Relay error (`BatonSchemaError`, `RaceDefinitionError`) with context.
- **Don't use `z.any()` casually.** It defeats the system. Use `z.unknown()` and narrow.
