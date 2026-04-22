import { branchStep } from './runners/branch.js';
import { parallelStep } from './runners/parallel.js';
import { promptStep } from './runners/prompt.js';
import { scriptStep } from './runners/script.js';
import { terminalStep } from './runners/terminal.js';

export const runner = {
  prompt: promptStep,
  script: scriptStep,
  branch: branchStep,
  parallel: parallelStep,
  terminal: terminalStep,
} as const;
