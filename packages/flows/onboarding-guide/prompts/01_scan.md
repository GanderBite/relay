You are scanning the project at `{{input.projectDir}}` to prepare for onboarding guide generation.

Use Glob to discover all of the following under `{{input.projectDir}}`. Skip `node_modules/`, `dist/`, `.git/`, and generated output directories.

- All `*.md` files
- All package manifests (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`)
- CI workflow files (`.github/workflows/*.yml`, `.circleci/config.yml`, `Jenkinsfile`)

Then execute these steps in order:

1. Find the root README file (prefer `README.md`; accept `readme.md` or `README`). Record its repo-relative path in `readmePath`. Read it to extract `projectName` (fall back to the root `package.json` `name` field) and `description` (the first non-heading paragraph, one sentence).
2. Check whether `{{input.projectDir}}/CONTRIBUTING.md` exists. If yes, record its repo-relative path in `contributingGuidePath`. If absent, set `contributingGuidePath` to `""`.
3. For each manifest: record its repo-relative `path`, the declared `name`, a one-word `language` (use `ts`, `js`, `py`, `go`, `rust`, or `other`), and any listed entry points in `entryPoints`.
4. Record all other `*.md` paths (excluding the root README and CONTRIBUTING) in `docPaths`.
5. Record the repo-relative paths of all CI files in `ciFilePaths`.
6. Use Grep to scan the README and CONTRIBUTING files for environment variable references (`$VAR_NAME`, `process.env.VAR_NAME`, `os.environ['VAR_NAME']`). Collect unique names in `envVarKeys`.

Return ONLY a JSON object in this exact shape. No prose, no backticks, no preamble.

{
  "projectName": "my-project",
  "description": "One sentence from the README or manifest.",
  "readmePath": "README.md",
  "contributingGuidePath": "CONTRIBUTING.md",
  "docPaths": ["docs/setup.md", "docs/architecture.md"],
  "manifests": [
    {
      "path": "packages/core",
      "name": "@my/core",
      "language": "ts",
      "entryPoints": ["src/index.ts"]
    }
  ],
  "ciFilePaths": [".github/workflows/ci.yml"],
  "envVarKeys": ["DATABASE_URL", "API_KEY"]
}
