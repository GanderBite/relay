import type { InvocationRequest } from '../types.js';

export interface ClaudeCliProviderOptions {
  extraEnv?: Record<string, string>;
  binaryPath?: string;
}

// The fixed prefix is the same for every claude -p invocation. The
// --dangerously-skip-permissions flag is paired with --tools so that
// headless runs never block on a permission prompt: the model is allowed
// to execute any tool present in req.tools without prompting. The tool
// set in req.tools is therefore authoritative and auto-approved — every
// name that reaches the subprocess will be executed without a user
// confirmation gate. The upstream capability-check in
// orchestrator/capability-check.ts gates req.tools against the
// provider's declared builtInTools list, which is the only safeguard
// against an unknown tool name reaching the subprocess.
const FIXED_PREFIX: readonly string[] = [
  '-p',
  '--output-format',
  'stream-json',
  '--include-partial-messages',
  '--input-format',
  'text',
  '--no-session-persistence',
  '--verbose',
  '--dangerously-skip-permissions',
];

/**
 * Translate relay's AgentDefinition shape to the claude CLI --agents wire
 * format. The wire is a JSON object keyed by agent name, where each value is
 * an object containing description, prompt (NOT systemPrompt), tools, model,
 * skills, etc. Relay-only resolution fields (extends, skillsMerge) are
 * stripped before serialization.
 */
function translateAgents(
  agents: Array<Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
  const wire: Record<string, Record<string, unknown>> = {};
  for (const agent of agents) {
    const name = agent['name'] as string;
    const entry: Record<string, unknown> = {};
    if (agent['description'] !== undefined) entry['description'] = agent['description'];
    if (agent['systemPrompt'] !== undefined) entry['prompt'] = agent['systemPrompt'];
    if (agent['tools'] !== undefined) entry['tools'] = agent['tools'];
    if (agent['model'] !== undefined) entry['model'] = agent['model'];
    if (agent['skills'] !== undefined) entry['skills'] = agent['skills'];
    wire[name] = entry;
  }
  return wire;
}

export function buildCliArgs(req: InvocationRequest, _opts: ClaudeCliProviderOptions): string[] {
  const args: string[] = [...FIXED_PREFIX];

  if (req.model !== undefined) {
    args.push('--model', req.model);
  }

  if (req.systemPrompt !== undefined) {
    args.push('--system-prompt', req.systemPrompt);
  }

  if (req.tools !== undefined && req.tools.length > 0) {
    args.push('--tools', req.tools.join(','));
  }

  if (req.jsonSchema !== undefined) {
    args.push('--json-schema', JSON.stringify(req.jsonSchema));
  }

  if (req.maxBudgetUsd !== undefined) {
    args.push('--max-budget-usd', String(req.maxBudgetUsd));
  }

  if (req.agents !== undefined && req.agents.length > 0) {
    args.push('--agents', JSON.stringify(translateAgents(req.agents)));
  }

  return args;
}
