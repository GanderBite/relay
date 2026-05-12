/**
 * Walks a dot-separated path into `root`, returning the value at that path or
 * `undefined` if any segment is missing. Never throws.
 *
 * Shared between executor modules that need to traverse runtime context maps
 * (script-env, agents-resolution) so the traversal rules stay identical.
 */
export function dotPath(root: Record<string, unknown>, path: string): unknown {
  let current: unknown = root;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}
