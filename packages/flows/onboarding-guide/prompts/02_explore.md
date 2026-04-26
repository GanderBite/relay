You are mapping the module structure of the project at `{{input.projectDir}}`.

The project manifests are in `<context name="scan">`.
Packages found: {{scan.manifests.length}}

For each package in `{{scan.manifests}}`:
1. Open its entry point using Read.
2. Follow imports one level deep to identify the top-level modules — the directories or files that own a distinct bounded context.
3. For each module record:
   - `package` — the manifest name
   - `path` — repo-relative path to the module root
   - `boundedContext` — the domain concern this module owns (what it is responsible for, and equally important: what it does NOT own)
   - `entryPoint` — repo-relative path to its main file
   - `keyExports` — the primary names exported (functions, classes, types)
   - `summary` — one sentence describing its responsibility

Then identify inter-package dependencies: which packages import from which, and the nature of the coupling (runtime, dev, or peer).

Return ONLY a JSON object with this shape:

{
  "modules": [
    {
      "package": "<manifest name>",
      "path": "<repo-relative path>",
      "boundedContext": "<domain concern this module owns>",
      "entryPoint": "<repo-relative path>",
      "keyExports": ["<name>"],
      "summary": "<one sentence>"
    }
  ],
  "packageDependencies": [
    { "from": "<package>", "to": "<package>", "kind": "runtime|dev|peer" }
  ]
}

No prose, no backticks, no preamble.
