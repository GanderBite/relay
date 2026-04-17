---
name: javascript
description: Plain JavaScript patterns for the narrow surface where Relay uses JS instead of TypeScript — the executable bin shims (`bin/relay.js`, `bin/relay-generator.js`, `bin/generate-registry.js`), the static catalog site's vanilla browser JS (`catalog/app.js`), and any GitHub Actions workflow snippets. Trigger this skill when editing any `.js` file in the repo. The goal is JS that behaves identically to the surrounding TypeScript at runtime — same ESM rules, same Node version target.
---

# JavaScript in Relay

The repo is TypeScript-first. Plain JavaScript appears in three places:

1. **Bin shims** — the entry-point executables under `packages/*/bin/*.js`.
2. **Static catalog site** — `catalog/app.js` runs in the browser, fetches `registry.json`, and renders flow cards.
3. **GitHub Actions snippets** — small inline `node -e '...'` calls or a `scripts/*.js` helper for a workflow step.

There is no other JavaScript in this repo. If you're tempted to write `.js` somewhere else, the answer is `.ts`.

## Bin shim pattern

The canonical bin shim:

```js
#!/usr/bin/env node
import('../dist/cli.js').then((mod) => {
  return mod.main(process.argv);
}).catch((err) => {
  console.error(err?.stack ?? err);
  process.exit(1);
});
```

Rules:

- **Always use the shebang `#!/usr/bin/env node`** — the file must be marked executable in `package.json`'s `bin` block.
- **Dynamic `import()`, not `require()`** — the package is ESM.
- **Catch and print** — uncaught rejection in a bin script gives a useless stack. Format and exit with non-zero.
- **`process.argv` is the source** — the dispatcher reads it, not `process.argv.slice(2)` (the dispatcher does the slicing).
- **No top-level work other than the import** — keep the shim trivial. Real logic lives in the bundled `dist/`.

If `package.json` has `"bin": { "relay": "./bin/relay.js" }`, npm/pnpm sets the executable bit on install.

## Browser JS for the catalog (`catalog/app.js`)

The catalog site runs in a static-hosted browser context. No bundler, no framework. Vanilla DOM + `fetch`.

```js
// catalog/app.js
async function main() {
  const res = await fetch('./registry.json');
  if (!res.ok) {
    document.getElementById('flows').textContent = 'Failed to load catalog.';
    return;
  }
  const registry = await res.json();
  renderFlows(registry.flows);
}

function renderFlows(flows) {
  const container = document.getElementById('flows');
  container.innerHTML = '';
  for (const flow of flows) {
    container.appendChild(renderFlowCard(flow));
  }
}

function renderFlowCard(flow) {
  const card = document.createElement('article');
  card.className = 'flow-card';
  // ...build DOM with createElement / textContent (NEVER innerHTML for user data)
  return card;
}

document.addEventListener('DOMContentLoaded', main);
```

Rules:

- **No `innerHTML` for user data.** Use `textContent` and `createElement`. The catalog never wants an XSS vector.
- **No build step.** Plain ES modules in the browser. `<script type="module" src="./app.js"></script>` in the HTML.
- **No `npm install`.** No external deps. Tailwind via CDN is acceptable; everything else is hand-rolled.
- **Browser-target — not Node.** No `process`, no `fs`, no `node:` imports.

## GitHub Actions inline JS

Sometimes a workflow needs a small JS step. Use `node -e` for one-liners:

```yaml
- name: Bump version
  run: node -e "const p=require('./package.json'); p.version=process.env.NEW_VERSION; require('fs').writeFileSync('./package.json', JSON.stringify(p, null, 2));"
```

For anything more than 3 lines, put it in `scripts/<name>.mjs` (use `.mjs` so Node treats it as ESM regardless of the `package.json` `type`).

```yaml
- name: Generate registry
  run: node scripts/generate-registry.mjs
```

## ESM rules still apply in JS

The same rules as the TypeScript skill: include `.js` extensions in relative imports, use `import.meta.url` instead of `__dirname`, prefer `node:` prefix for built-ins.

```js
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(await readFile(join(__dirname, '../config.json'), 'utf8'));
```

## Anti-patterns

- **Don't use CommonJS (`require`, `module.exports`)** anywhere in the repo. The package.json says `"type": "module"`; CJS would fail at runtime.
- **Don't put logic in bin shims.** They re-export and exit. Logic lives in `dist/`.
- **Don't write `.js` files in `packages/*/src/`.** Source is TypeScript. `.js` is for compiled output and bin shims only.
- **Don't `eval` or `new Function`.** Ever. Even in catalog JS — especially in catalog JS.
- **Don't use jQuery, lodash, axios in catalog JS.** Vanilla DOM + native `fetch` covers every case.

## Why this skill exists

The bin shims and catalog JS are small, but they're easy to get wrong if you reflex-write CommonJS or reach for `npm install`. This skill is the reminder that the JS surface is intentional and bounded.
