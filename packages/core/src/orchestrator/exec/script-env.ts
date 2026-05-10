import { resolve } from 'node:path';
import { err, ok, type Result } from 'neverthrow';

import { FlowDefinitionError } from '../../errors.js';
import { isScriptEnvFromSpec, type ScriptEnvValueSpec } from '../../flow/types.js';
import { renderTemplate } from '../../template.js';

export interface ScriptEnvContext {
  input: Record<string, unknown>;
  handoffs: Record<string, unknown>;
  runDir: string;
  flowDir: string;
  handoffsDir: string;
}

/**
 * Walks a dot-separated path into `root`, returning the value at that path or
 * `undefined` if any segment is missing. Never throws.
 */
function dotPath(root: Record<string, unknown>, path: string): unknown {
  const segments = path.split('.');
  let current: unknown = root;
  for (const segment of segments) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Resolves a single env entry's `ScriptEnvValueSpec` against the runtime
 * context, returning the final string value. Returns `err` when a required
 * source resolves to `undefined` or `null`.
 */
function resolveOne(
  key: string,
  spec: ScriptEnvValueSpec,
  ctx: ScriptEnvContext,
): Result<string, FlowDefinitionError> {
  const templateVars: Record<string, unknown> = {
    input: ctx.input,
    ...ctx.handoffs,
    runDir: ctx.runDir,
    flowDir: ctx.flowDir,
    handoffsDir: ctx.handoffsDir,
  };

  if (!isScriptEnvFromSpec(spec)) {
    // String value — render as Handlebars template.
    return renderTemplate(spec, templateVars);
  }

  // ScriptEnvFromSpec — resolve the `from` path.
  const { from, required, resolve: resolveMode } = spec;

  let resolved: unknown;

  if (from.startsWith('input.')) {
    const suffix = from.slice('input.'.length);
    resolved = dotPath(ctx.input, suffix);
  } else if (from.startsWith('handoff.')) {
    const suffix = from.slice('handoff.'.length);
    resolved = dotPath(ctx.handoffs, suffix);
  } else {
    return err(
      new FlowDefinitionError(
        `env key "${key}": unrecognized from prefix in "${from}" — expected "input.<path>" or "handoff.<path>"`,
      ),
    );
  }

  if (resolved === undefined || resolved === null) {
    if (required === true) {
      return err(
        new FlowDefinitionError(
          `env key "${key}": required source "${from}" resolved to ${resolved === null ? 'null' : 'undefined'}`,
        ),
      );
    }
    return ok('');
  }

  let value = String(resolved);

  if (resolveMode === 'fromCwd') {
    value = resolve(process.cwd(), value);
  }

  return ok(value);
}

/**
 * Resolves a script step's env map against the runtime context, returning a
 * flat `Record<string, string>` ready to merge into the process environment.
 *
 * Returns `ok({})` when `env` is `undefined`.
 * Returns `err(FlowDefinitionError)` when a required env source is missing or
 * an unrecognized `from` prefix is encountered.
 */
export function resolveScriptEnv(
  env: Record<string, ScriptEnvValueSpec> | undefined,
  ctx: ScriptEnvContext,
): Result<Record<string, string>, FlowDefinitionError> {
  if (env === undefined) return ok({});

  const result: Record<string, string> = {};

  for (const [key, spec] of Object.entries(env)) {
    const valueResult = resolveOne(key, spec, ctx);
    if (valueResult.isErr()) return err(valueResult.error);
    result[key] = valueResult.value;
  }

  return ok(result);
}
