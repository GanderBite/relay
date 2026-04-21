# Sprint 12 Library Choices — Research Artifact

**Task:** task_109  
**Scope:** HTTP client, npm-registry interaction, static catalog site approach, semver availability.  
**Status:** FINAL — gates tasks 72–76.

---

## (a) HTTP client for telemetry (task_74)

### Conclusion: no extra dependency needed

Node 20.10+ ships `fetch` as a stable global, implemented by the built-in `undici` module. The project's `engines` field already requires `>=25.8`, so the global `fetch` is unconditionally available without an `import`.

Rationale: Adding a third-party HTTP client (`node-fetch`, `axios`, `got`) for a single fire-and-forget POST would pull a dependency that provides zero benefit over what the runtime already supplies.

### Timeout pattern — AbortController

The §8.4 telemetry endpoint is called at the end of `relay run`. The call must not block the terminal for more than 2 seconds on a slow or unreachable host. The correct pattern:

```ts
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 2_000);
try {
  await fetch("https://telemetry.relay.dev/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(evt),
    signal: controller.signal,
  });
} catch {
  // swallow all errors silently — telemetry must never fail the run
} finally {
  clearTimeout(timer);
}
```

`AbortController` is a Node 20.10+ global; no import required.

---

## (b) npm registry interaction — subprocess vs pacote

### Candidates

| Approach | Description |
|---|---|
| **subprocess (`npm` binary)** | Shell out to `npm install`, `npm publish`, etc. via `child_process.execFile` or `spawnSync`. |
| **`pacote`** | npm's own programmatic tarball/manifest resolver (~350 kB, pulls in `@npmcli/*` tree). |

### Analysis

`pacote` exposes a rich programmatic API for resolving, extracting, and packing npm tarballs without spawning a process. It is the engine behind `npm install` itself.

However, for Relay's use cases the complexity is not justified:

- **`relay install`** (task_54 / §5.3.2): the spec explicitly says "runs `npm install --no-save --prefix …` against the package". The spec chose subprocess deliberately; see tech spec §5.3.2 commentary: "Why npm and not a custom registry: npm already has versioning, signing, mirroring, security advisories, and a publish workflow."
- **`relay publish`** (task_75 / §9.4): the spec says "run `npm publish --access public`". Devs publish manually with the same command; subprocess keeps the output transparent and auditable.
- **`relay upgrade`** (task_56): resolve the latest version tag, then install — both steps done through subprocess with `npm view <pkg> version` and `npm install`.

Adding `pacote` would introduce ~10+ transitive `@npmcli/*` packages, add a surface for semver mismatches with whatever `npm` version the user has installed, and diverge from how the spec expects the commands to behave.

### Recommendation: subprocess

Invoke the `npm` binary via `child_process.execFile` (or `spawnSync` for synchronous install checks). One sentence: subprocess matches the spec's intent, stays transparent to the user, and avoids a heavyweight transitive dep tree for tasks the npm CLI already handles.

---

## (c) Static catalog site — plain HTML/JS/CSS vs framework

### Spec mandate

Product spec §10.3 states: "v1 is a static site." The section describes a plain URL structure (`/`, `/flows`, `/flows/<name>`, `/docs`, `/blog`) with no mention of any site-generator framework.

Sprint 12 task_76 description is explicit: "Use a minimal approach: plain HTML + a tiny JS file … No framework (confirmed by task_109 research per product spec §14)."

Product spec §14 contextualises the catalog as the product's "primary storefront" but says nothing that would require a static-site generator — it specifies content and conversion goals, not tooling.

### Candidates evaluated

| Option | Assessment |
|---|---|
| **Plain HTML + vanilla JS + inline/external CSS** | Zero build step, no Node dependency, deploys as-is to GitHub Pages, trivially auditable. |
| **Eleventy** | Adds a build step, Node templating dependency, learning curve for contributors. Justified for large multi-author sites; overkill for a handful of pages. |
| **Zola** | Rust binary, TOML config, Tera templates — entirely alien to the existing TypeScript/Node stack. No path to reusing existing tooling. |

### Confirmation

Plain HTML + vanilla JS + CSS is the correct approach. The `app.js` file fetches `registry.json` at runtime and renders the flow list in the browser — no server-side templating needed. The "build script" for the catalog package is `echo static site; exit 0` as the task spec states. CSS can be inline or a single `styles.css` file loaded from `index.html`. No CDN JavaScript frameworks should be pulled in; the catalog JS must stay auditable and load instantly.

One sentence: the spec mandates a static site and the content (a JSON-driven flow list) is simple enough that a single JS file covers the full rendering need without a build toolchain.

---

## (d) semver package availability

### Findings

`semver` is present in the pnpm virtual store as a **transitive dependency**, version 7.7.4, pulled in by `istanbul-lib-report` → `make-dir@4.0.0` → `semver@7.7.4` (part of the vitest / coverage toolchain).

It is **not** listed as a direct dependency in any workspace package's `package.json`.

### Usability

`semver@7.7.4` ships as CommonJS (`"main": "index.js"`, no `"type": "module"`, no `exports` map). In an ESM file with `"type": "module"` it is importable via a named default import:

```ts
import semver from "semver";
// or, for specific functions:
import { diff, satisfies, valid } from "semver";
```

Node's ESM interop allows default-importing CJS modules; named exports are also available because `semver` exposes them from its CJS main via `module.exports` properties.

### Recommendation

Add `semver` as a **direct dependency** of `@relay/cli` rather than relying on the transitive path. Transitive deps are not guaranteed to stay available across toolchain updates (e.g., if vitest drops `istanbul-lib-report`). The package is tiny (~25 kB) and widely trusted.

```jsonc
// packages/cli/package.json — dependencies
"semver": "^7.7.4"
```

For TypeScript type safety, add `@types/semver` to `devDependencies`.

---

## Decision Block

| Choice | Decision | Rationale |
|---|---|---|
| HTTP client | built-in `fetch` (Node global) | No extra dep needed on Node ≥20.10; `AbortController` covers the 2s timeout requirement. |
| npm registry interaction | subprocess (`npm` binary) | Matches spec intent (§5.3.2), keeps publish output transparent, avoids the `pacote`/`@npmcli/*` dep tree. |
| Static catalog site | plain HTML + vanilla JS + CSS | Spec mandates a static site (§10.3, §14); no SSG framework is warranted for a JSON-driven flow list with a handful of pages. |
| semver | add as direct dep (`^7.7.4`) | Currently only a transitive dep via test toolchain; must be declared direct to guarantee availability; add `@types/semver` for type safety. |
