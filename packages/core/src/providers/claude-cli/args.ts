import type { InvocationRequest } from '../types.js';

export interface ClaudeCliProviderOptions {
  extraEnv?: Record<string, string>;
  binaryPath?: string;
}

const FIXED_PREFIX: readonly string[] = [
  '-p',
  '--output-format',
  'stream-json',
  '--include-partial-messages',
  '--input-format',
  'text',
  '--no-session-persistence',
  '--verbose',
];

export function buildCliArgs(
  req: InvocationRequest,
  _opts: ClaudeCliProviderOptions,
): string[] {
  const args: string[] = [...FIXED_PREFIX];

  if (req.model !== undefined) {
    args.push('--model', req.model);
  }

  if (req.systemPrompt !== undefined) {
    args.push('--system-prompt', req.systemPrompt);
  }

  if (req.tools !== undefined && req.tools.length > 0) {
    args.push('--allowedTools', req.tools.join(' '));
  }

  if (req.jsonSchema !== undefined) {
    args.push('--json-schema', JSON.stringify(req.jsonSchema));
  }

  if (req.maxBudgetUsd !== undefined) {
    args.push('--max-budget-usd', String(req.maxBudgetUsd));
  }

  return args;
}
