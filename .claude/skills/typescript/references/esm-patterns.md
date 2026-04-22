# ESM Patterns — NodeNext Survival Guide

Relay is ESM-only. NodeNext resolution mirrors what Node actually does at runtime. The cost is a few syntax requirements you must remember; the win is your code runs in Node identically to how `tsc` saw it.

## The `.js` extension rule

```ts
// ✅ ALWAYS include .js — even though source is .ts
import { Runner } from './runner/runner.js';
import { z } from 'zod';                          // bare specifier — no extension
import { fileURLToPath } from 'node:url';         // node: prefix — no extension

// ❌ Wrong — TypeScript will compile but Node will fail at runtime
import { Runner } from './runner/runner';
import { Runner } from './runner/runner.ts';      // never .ts
```

The compiler erases the `.js` to nothing during emit; the compiled code becomes `import { Runner } from './runner/runner.js'`. Without the extension, Node's runtime ESM resolver throws `ERR_MODULE_NOT_FOUND`.

## Type-only imports

`verbatimModuleSyntax` forbids inline `type` markers — use the form-level `import type`:

```ts
// ✅
import type { Race, RaceSpec } from './race/types.js';
import { defineRace } from './race/define.js';

// ❌ Won't compile under verbatimModuleSyntax
import { type Race, defineRace } from './race/define.js';

// ✅ For mixed value+type imports, split into two statements
import { defineRace } from './race/define.js';
import type { Race } from './race/types.js';
```

## Replacing `__dirname` and `__filename`

ESM doesn't have these. Use `import.meta.url`:

```ts
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Or skip the assignment if you only need a path resolved:
const templatesDir = fileURLToPath(new URL('./templates', import.meta.url));
```

The `new URL('./templates', import.meta.url)` form is idiomatic for asset paths inside a package.

## Dynamic imports

```ts
// Static (preferred when possible)
import { ClaudeProvider } from './providers/claude/provider.js';

// Dynamic (when path is computed)
const raceModule = await import(`file://${racePath}/dist/race.js`);
const race = raceModule.default;
```

When importing from a dynamic absolute path on disk, use the `file://` URL prefix — Node's ESM resolver requires it for absolute paths.

## Top-level await

Allowed in ESM. Use it freely at module scope:

```ts
// packages/cli/src/cli.ts
const { default: registry } = await import('./providers/registry.js');
const config = await loadConfig();
```

## `package.json` ESM markers

Every Relay package has `"type": "module"` and uses `exports`:

```json
{
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  }
}
```

`exports` is the modern entry point. `main`/`types` stay as fallbacks for older resolvers.

## Importing JSON

```ts
// ✅ Node 20.10+ supports JSON import attributes
import pkg from '../package.json' with { type: 'json' };

// ⚠ Older syntax `assert { type: 'json' }` is deprecated; use `with`
```

For TypeScript to allow this, set `"resolveJsonModule": true` in the package's tsconfig.

## Reading files synchronously at module load

For static config reads:

```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const versionTxt = readFileSync(
  fileURLToPath(new URL('./version.txt', import.meta.url)),
  'utf8'
);
```

## `node:` prefix is required for built-ins

```ts
// ✅
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

// ⚠ Bare specifier still works but the prefix is preferred (and required by some lint rules)
import { readFile } from 'fs/promises';
```

## Common pitfalls

| Symptom | Cause |
|---|---|
| `ERR_MODULE_NOT_FOUND` for own files | Missing `.js` extension on a relative import |
| `ERR_REQUIRE_ESM` from a consumer | Consumer is CJS trying to `require()` an ESM package |
| `import.meta is not allowed in CommonJS` | Mixing CJS and ESM — pick one (Relay picks ESM) |
| `__dirname is not defined` | Forgot to derive it from `import.meta.url` |
| Type imports break at runtime | `import type` accidentally became `import` (or vice versa) — re-check the imports |
| `Cannot find module` for a JSON file | Missing `with { type: 'json' }` attribute |

## When `tsup` differs from `tsc`

`tsup` (esbuild-based) is more permissive than `tsc` about some things. The rule: if `pnpm typecheck` (which runs `tsc --noEmit`) is green, the code is correct. `tsup` will faithfully bundle it. If `tsup` succeeds but `tsc` fails, the code has type errors that are about to bite — don't ship it.
