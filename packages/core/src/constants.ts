/**
 * Public constant values shared across @ganderbite/relay-core. This is the single
 * source for URLs, magic numbers, and any other configuration literal
 * that multiple modules would otherwise duplicate.
 */

/**
 * Base URL for the Relay project on GitHub. Surfaced in user-facing
 * error messages as the canonical place to report unknown issues.
 * Update to the real repo URL once the project is published.
 */
export const GITHUB_URL = 'https://github.com';

/**
 * Canonical URL for opening new issues against Relay. Derived from
 * GITHUB_URL. Error messages that fall through to the "report a bug"
 * path point users here.
 */
export const GITHUB_ISSUES_URL = `${GITHUB_URL}/issues`;
