/**
 * Returns true when the argument looks like a filesystem path rather than a
 * plain flow name or bare identifier.
 *
 * Positives: starts with '.', '/', or '~', or contains a path separator
 * ('/' or '\').
 */
export function looksLikePath(s: string): boolean {
  return (
    s.startsWith('./') ||
    s.startsWith('../') ||
    s.startsWith('/') ||
    s.startsWith('~') ||
    s.includes('/') ||
    s.includes('\\')
  );
}
