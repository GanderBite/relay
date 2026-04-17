# Bin Shim Patterns

Each Relay package that ships an executable has a `bin/` directory with one or more `.js` files. They are intentionally tiny — the dispatcher / installer / generator logic lives in the bundled `dist/`.

## The canonical shim

```js
#!/usr/bin/env node
import('../dist/cli.js')
  .then((mod) => mod.main(process.argv))
  .catch((err) => {
    console.error(err?.stack ?? err);
    process.exit(1);
  });
```

## Per-package shims

### `packages/cli/bin/relay.js`

```js
#!/usr/bin/env node
import('../dist/cli.js')
  .then((mod) => mod.main(process.argv))
  .catch((err) => {
    console.error(err?.stack ?? err);
    process.exit(1);
  });
```

### `packages/generator/bin/relay-generator.js`

```js
#!/usr/bin/env node
import('../dist/install.js')
  .then((mod) => mod.installSkill())
  .catch((err) => {
    console.error('relay-generator install failed:', err?.stack ?? err);
    process.exit(1);
  });
```

### `packages/cli/bin/generate-registry.js`

```js
#!/usr/bin/env node
import('../dist/registry.js')
  .then((mod) => mod.generateAndPrint(process.argv.slice(2)))
  .catch((err) => {
    console.error(err?.stack ?? err);
    process.exit(1);
  });
```

## `package.json` bin block

```json
{
  "bin": {
    "relay": "./bin/relay.js",
    "generate-registry": "./bin/generate-registry.js"
  }
}
```

For globally installed packages, this creates a symlink in the user's `$PATH`. For workspace usage, `pnpm exec relay --version` works.

## Why the dynamic `import()`

Two reasons:

1. **Top-level await is fine in the shim itself**, but `import()` lets you wrap the whole thing in a `.catch()` that handles ESM resolution failures cleanly. A plain top-level `await import()` that throws produces an unhandled rejection — uglier output.
2. **The dist file might not exist** during certain dev workflows. The catch handler can print a nicer message ("did you forget to `pnpm build`?") in those cases.

## Adding executable bit

When you commit a new bin file, mark it executable:

```bash
chmod +x packages/cli/bin/relay.js
git update-index --chmod=+x packages/cli/bin/relay.js
```

(npm/pnpm also re-set the bit on install based on the shebang.)

## Don't do

- **Don't put logic in the shim.** A shim that's more than 10 lines is a sign the logic should move to a `dist/` module.
- **Don't depend on cwd.** Use `import.meta.url`-relative paths.
- **Don't print a banner from the shim.** The dispatcher owns startup output. The shim is invisible.
- **Don't read env vars in the shim.** The dispatcher does that — single source of truth.
