import { branchStep } from './steps/branch.js';
import { parallelStep } from './steps/parallel.js';
import { promptStep } from './steps/prompt.js';
import { scriptStep } from './steps/script.js';
import { terminalStep } from './steps/terminal.js';

export const step = {
  prompt: promptStep,
  script: scriptStep,
  branch: branchStep,
  parallel: parallelStep,
  terminal: terminalStep,
} as const;

export type {
  BranchStepSpec,
  ParallelStepSpec,
  PromptStepOutput,
  PromptStepSpec,
  ScriptStepSpec,
  TerminalStepSpec,
} from './types.js';
