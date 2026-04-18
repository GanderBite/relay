import { FlowDefinitionError } from './errors.js';
import { Logger } from './logger.js';

// Token types produced by the tokenizer.
type TextToken = { kind: 'TEXT'; value: string };
type VarToken = { kind: 'VAR'; path: string };
type EachOpenToken = { kind: 'EACH_OPEN'; path: string };
type EachCloseToken = { kind: 'EACH_CLOSE' };

type Token = TextToken | VarToken | EachOpenToken | EachCloseToken;

// Tokenizes a template string into a flat list of tokens.
// Splits on {{ ... }} delimiters; classifies each tag.
function tokenize(tpl: string): Token[] {
  const tokens: Token[] = [];
  // Split by {{ and }}. Odd-indexed chunks are inside {{ }}.
  const parts = tpl.split(/(\{\{[\s\S]*?\}\})/);

  for (const part of parts) {
    if (!part.startsWith('{{')) {
      tokens.push({ kind: 'TEXT', value: part });
      continue;
    }

    const inner = part.slice(2, -2).trim();

    if (inner.startsWith('#each ')) {
      const path = inner.slice(6).trim();
      tokens.push({ kind: 'EACH_OPEN', path });
    } else if (inner === '/each') {
      tokens.push({ kind: 'EACH_CLOSE' });
    } else {
      tokens.push({ kind: 'VAR', path: inner });
    }
  }

  return tokens;
}

// Resolves a dotted/bracket path against a scope object.
// Supports: "name", "a.b.c", "a[0]", "a[0].b", "." (current item sentinel).
// Returns the resolved value or undefined if any segment is missing.
function resolvePath(path: string, scope: Record<string, unknown>): unknown {
  if (path === '.') {
    // "." is only meaningful inside #each; the caller provides the item as
    // the "." key in the merged scope.
    return scope['.'];
  }

  // Normalize bracket notation: a[0] -> a.0
  const normalized = path.replace(/\[(\d+)\]/g, '.$1');
  const segments = normalized.split('.');

  let current: unknown = scope;
  for (const seg of segments) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[seg];
  }

  return current;
}

// Resolves a path against a stack of scopes (innermost first).
// The innermost scope wins; if not found there, falls back to outer scopes.
// Missing path → returns undefined and logs a debug warning.
function resolveScoped(path: string, scopes: Record<string, unknown>[]): string {
  for (const scope of scopes) {
    const value = resolvePath(path, scope);
    if (value !== undefined) {
      return String(value);
    }
  }

  Logger.debug({ path }, 'template path not found');
  return '';
}

// Walks a slice of tokens in the current scope stack, recursively handling
// nested #each blocks. Returns the rendered string and the index of the token
// immediately after the consumed block.
function walk(
  tokens: Token[],
  start: number,
  end: number,
  scopes: Record<string, unknown>[],
): string {
  let output = '';
  let i = start;

  while (i < end) {
    const token = tokens[i];
    if (token === undefined) break;

    switch (token.kind) {
      case 'TEXT': {
        output += token.value;
        i++;
        break;
      }

      case 'VAR': {
        output += resolveScoped(token.path, scopes);
        i++;
        break;
      }

      case 'EACH_OPEN': {
        // Find the matching /each, accounting for nesting.
        const blockStart = i + 1;
        let depth = 1;
        let j = blockStart;

        while (j < end && depth > 0) {
          const t = tokens[j];
          if (t === undefined) break;
          if (t.kind === 'EACH_OPEN') depth++;
          if (t.kind === 'EACH_CLOSE') depth--;
          j++;
        }

        if (depth !== 0) {
          throw new FlowDefinitionError(
            `Unbalanced {{#each ${token.path}}}: no matching {{/each}}`,
          );
        }

        // blockEnd points at the EACH_CLOSE token; block body is [blockStart, j-1).
        const blockEnd = j - 1;

        // Resolve the raw value for iteration; missing or non-array → no output.
        const rawValue = resolveRaw(token.path, scopes);

        if (Array.isArray(rawValue)) {
          for (const item of rawValue) {
            // Inside the block, "." is the current item.
            // If item is an object, spread its keys so {{field}} works directly.
            const itemScope: Record<string, unknown> =
              item !== null && typeof item === 'object' && !Array.isArray(item)
                ? { '.': item, ...(item as Record<string, unknown>) }
                : { '.': item };

            output += walk(tokens, blockStart, blockEnd, [itemScope, ...scopes]);
          }
        }
        // Non-array or missing path: no iterations, no output.

        // Advance past the EACH_CLOSE.
        i = j;
        break;
      }

      case 'EACH_CLOSE': {
        // A bare EACH_CLOSE at the top level (not consumed by EACH_OPEN) is unbalanced.
        throw new FlowDefinitionError('Unbalanced {{/each}}: no matching {{#each}}');
      }
    }
  }

  return output;
}

// Resolves a path to its raw (uncoerced) value for array iteration.
function resolveRaw(path: string, scopes: Record<string, unknown>[]): unknown {
  if (path === '.') {
    for (const scope of scopes) {
      if ('.' in scope) return scope['.'];
    }
    return undefined;
  }

  for (const scope of scopes) {
    const value = resolvePath(path, scope);
    if (value !== undefined) return value;
  }

  return undefined;
}

/**
 * Renders a template string, substituting `{{path}}` placeholders and
 * `{{#each arr}}...{{/each}}` blocks using the provided variable map.
 *
 * Supported syntax:
 *   {{name}}               — top-level variable
 *   {{name.path.to.field}} — dot-notation path
 *   {{name[i].field}}      — bracket index then dot notation
 *   {{#each name}}...{{/each}} — iteration over an array
 *
 * Inside {{#each}}: {{.}} is the current item; {{field}} resolves against
 * the current item first, then falls back to outer vars.
 * Missing paths resolve to empty string (a debug warning is logged).
 * Unbalanced {{#each}}/{{/each}} throws FlowDefinitionError.
 */
export function renderTemplate(tpl: string, vars: Record<string, unknown>): string {
  const tokens = tokenize(tpl);

  // Validate that all EACH_CLOSE tokens are balanced at the top level.
  // walk() handles nested validation recursively; here we catch top-level orphans.
  // walk() throws on both missing close and orphan close, so just call it.
  return walk(tokens, 0, tokens.length, [vars]);
}
