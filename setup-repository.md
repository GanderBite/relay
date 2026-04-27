# GitHub Repository Setup Guide — Relay

This guide covers everything needed to securely configure the `ganderbite/relay` public repository on GitHub, protect the main branch, wire up npm publishing, and prepare GitHub Pages for the catalog.

---

## 1. Create the Repository

```bash
gh repo create ganderbite/relay \
  --public \
  --description "Run deterministic multi-step Claude Code workflows — checkpoint, resume, never bill by surprise" \
  --homepage "https://ganderbite.github.io/relay"
```

Push the existing local branch:

```bash
git remote add origin git@github.com:ganderbite/relay.git
git push -u origin main
```

---

## 2. Branch Protection — `main`

Navigate to **Settings → Branches → Add branch protection rule** for `main`, or apply with the GitHub CLI:

```bash
gh api repos/ganderbite/relay/branches/main/protection \
  --method PUT \
  --field required_status_checks='{"strict":true,"contexts":["CI / ci"]}' \
  --field enforce_admins=true \
  --field required_pull_request_reviews='{"required_approving_review_count":1,"dismiss_stale_reviews":true,"require_code_owner_reviews":true}' \
  --field restrictions=null \
  --field allow_force_pushes=false \
  --field allow_deletions=false \
  --field block_creations=false
```

### What each setting does

| Setting | Why |
|---|---|
| `required_status_checks: CI / ci` | PRs cannot merge unless the full typecheck + build + test pipeline passes |
| `strict: true` | The PR branch must be up to date with `main` before merge |
| `enforce_admins: true` | Even repo owners follow the rules — no force-push escape hatch |
| `required_approving_review_count: 1` | At least one human approval before merge |
| `dismiss_stale_reviews: true` | New pushes invalidate previous approvals |
| `require_code_owner_reviews: true` | CODEOWNERS (`@ganderbite`) must approve |
| `allow_force_pushes: false` | Prevents history rewrite on main |
| `allow_deletions: false` | Prevents accidental branch deletion |

### Require signed commits (optional, recommended)

```bash
gh api repos/ganderbite/relay/branches/main/protection/required_signatures \
  --method POST
```

This forces GPG/SSH-signed commits on `main`, making the git history tamper-evident.

---

## 3. GitHub Actions Secrets

These must be added under **Settings → Secrets and variables → Actions → Secrets**.

### Required secrets

| Secret name | Purpose | How to obtain |
|---|---|---|
| `NPM_TOKEN` | Publish `@ganderbite/*` packages to npm | See §4 below |

### Optional secrets

| Secret name | Purpose |
|---|---|
| `REGISTRY_EXTRA_PACKAGES` | Comma-separated npm package names to inject into the catalog registry at build time |

### Setting a secret via CLI

```bash
gh secret set NPM_TOKEN --body "<paste token here>"
```

Verify secrets are present (values are hidden):

```bash
gh secret list
```

---

## 4. npm — Create a Granular Publish Token

A granular (scoped) token limits blast radius if it ever leaks.

1. Log in to [npmjs.com](https://npmjs.com) as `ganderbite`.
2. Go to **Account → Access Tokens → Generate New Token → Granular Access Token**.
3. Configure:
   - **Name:** `relay-ci-publish`
   - **Expiration:** 1 year (rotate annually)
   - **Packages & scopes:** Select **specific packages** — add every `@ganderbite/*` package. Choose **Read and write** permission.
   - **Organizations:** Leave blank.
4. Copy the token immediately — it is shown only once.
5. Add it as `NPM_TOKEN` in GitHub secrets (see §3).

> The publish workflow uses `--provenance`, which attaches a signed SLSA provenance attestation to every release. This requires the `id-token: write` permission already present in `npm-publish.yml`.

---

## 5. GitHub Pages — Catalog Site

The `catalog-deploy.yml` workflow publishes the static catalog to GitHub Pages automatically on every push to `main`.

Enable Pages once:

1. **Settings → Pages → Source → GitHub Actions** (not the legacy "Deploy from branch" mode).
2. Leave custom domain blank unless you own `relay.dev` or similar.
3. The workflow uses `actions/deploy-pages@v4` with `GITHUB_TOKEN` (no extra secret needed).

After the first successful workflow run, the catalog will be live at:

```
https://ganderbite.github.io/relay
```

---

## 6. Dependabot

Create `.github/dependabot.yml` to automate dependency updates and get security alerts:

```yaml
version: 2
updates:
  - package-ecosystem: pnpm
    directory: /
    schedule:
      interval: weekly
      day: monday
      time: "09:00"
      timezone: Europe/Warsaw
    groups:
      devDependencies:
        dependency-type: development
    open-pull-requests-limit: 5

  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
      day: monday
      time: "09:00"
      timezone: Europe/Warsaw
    open-pull-requests-limit: 3
```

Dependabot PRs will target `main`. The branch protection rule means they must pass CI before merging.

---

## 7. CODEOWNERS

The existing `.github/CODEOWNERS` file is correct:

```
* @ganderbite
```

This means every PR requires a review from `@ganderbite`. No changes needed.

---

## 8. Repository Settings

Apply these in **Settings → General**:

| Setting | Value | Why |
|---|---|---|
| Default branch | `main` | Already set via push convention |
| Allow merge commits | Off | Force squash-or-rebase for clean history |
| Allow squash merging | On | Default merge strategy |
| Allow rebase merging | On | Preserve individual commits when useful |
| Always suggest updating PR branches | On | Reinforces the `strict` branch protection |
| Automatically delete head branches | On | Keeps branch list tidy post-merge |
| Issues | On | Already have ISSUE_TEMPLATE |
| Projects | Off (unless needed) | |
| Wiki | Off | Docs live in `docs/` |
| Discussions | Off (unless wanted) | |

---

## 9. Security Policy

Create `.github/SECURITY.md` so GitHub displays a "Report a vulnerability" button and so the security advisory form is pre-populated:

```markdown
# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes       |

## Reporting a Vulnerability

Please **do not** file a public GitHub issue for security vulnerabilities.

Send a private report using GitHub's built-in advisory form:
1. Go to the **Security** tab of this repository.
2. Click **Report a vulnerability**.
3. Describe the issue, steps to reproduce, and potential impact.

Alternatively, email **ganderbite@gmail.com** with subject: `[relay] Security disclosure`.

You will receive an acknowledgement within **48 hours** and a status update within **7 days**.

## Scope

Security issues relevant to Relay include:
- Environment variable leakage from `ClaudeCliProvider` subprocess
- Arbitrary command execution via flow definitions
- Credential exposure through log output
- Supply-chain compromises in published `@ganderbite/*` packages

## Out of Scope

- Issues in upstream tools (`claude` CLI, Node.js, pnpm)
- Best-practice suggestions unrelated to vulnerabilities
```

---

## 10. Enabling Private Vulnerability Reporting

In **Settings → Security → Private vulnerability reporting**, enable:

- [x] Enable private vulnerability reporting

This activates the "Report a vulnerability" button on the Security tab and routes disclosures to a private draft advisory — keeping vulnerability details off the public issue tracker until a fix ships.

---

## 11. npm Package Visibility

All `@ganderbite/*` packages publish to the public npm registry. Since they use a scoped name (`@ganderbite/`) they default to private on npm unless explicitly set public. Confirm the `publishConfig` field in every `package.json` reads:

```json
"publishConfig": {
  "access": "public"
}
```

The `npm-publish.yml` workflow passes `--access public` as well (belt-and-suspenders).

---

## 12. First-Push Checklist

Run through this before `git push -u origin main`:

```
[ ] pnpm install && pnpm -r typecheck      # zero type errors
[ ] pnpm -r build                           # all packages build
[ ] pnpm --filter './packages/**' test      # all tests pass
[ ] git status                              # no uncommitted files
[ ] git log --oneline -5                    # commits are clean & signed
[ ] gh repo create ganderbite/relay ...     # repo exists on GitHub
[ ] NPM_TOKEN secret added                  # confirmed via gh secret list
[ ] Branch protection rule applied          # no direct push to main possible
[ ] SECURITY.md committed                   # visible under Security tab
[ ] dependabot.yml committed                # auto-PRs will start next Monday
[ ] GitHub Pages source set to Actions      # not "Deploy from branch"
```

---

## 13. Post-Push Validation

After the first push and after CI completes:

```bash
# Confirm all checks passed
gh run list --repo ganderbite/relay --limit 5

# Confirm Pages deployed
curl -sI https://ganderbite.github.io/relay | head -5

# Confirm npm packages are live (after first tagged release)
npm info @ganderbite/relay-core
npm info @ganderbite/relay
npm info @ganderbite/relay-generator
```

---

## 14. Rotating Secrets

Schedule these recurring tasks:

| Secret | Rotation frequency | How |
|---|---|---|
| `NPM_TOKEN` | Annually | Delete old token on npmjs.com, generate new granular token, update GitHub secret |
| GPG signing key | Every 2 years | Generate new key, upload to GitHub, update `~/.gitconfig` |

Dependabot handles dependency security patches automatically (see §6).
