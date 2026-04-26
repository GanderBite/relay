The Relay project takes security seriously. If you discover a vulnerability, please follow the responsible disclosure process described below rather than opening a public issue.

## Supported versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | ✓         |

All other version ranges are not yet released.

## Reporting a vulnerability

Use the GitHub private security advisory form: navigate to the repository's Security tab, click "Report a vulnerability", and fill in the form. GitHub will keep the report private until a fix is ready.

As a fallback, you may email ganderbite@gmail.com with the subject line "[relay] Security report".

Please include the following in your report:

- A description of the vulnerability
- Steps to reproduce
- Affected versions
- A suggested fix or patch, if available

Do not open a public GitHub issue to report a security vulnerability.

## Response timeline

- Acknowledgement of receipt: within 48 hours of submission.
- Status update (confirmed, invalid, or in-progress): within 7 days.
- Fix and coordinated disclosure: timeline communicated once the issue is triaged.

## Scope

**In scope** — vulnerabilities the project wants to know about:

- Env-var leakage from ClaudeCliProvider — environment variables containing credentials passed through to subprocesses in unintended ways.
- Arbitrary command execution via flow definitions — a malicious or malformed flow package that causes the runner to execute unintended shell commands.
- Credential exposure in logs — auth tokens or API keys appearing in log output, state files, or run artifacts.
- Supply-chain compromise of @ganderbite/* packages — malicious code injected into the published npm packages.

**Out of scope** — please report to the upstream maintainer instead:

- Vulnerabilities in the claude CLI binary itself.
- Vulnerabilities in Node.js or pnpm.
- Issues in third-party dependencies not under the @ganderbite/* scope.
