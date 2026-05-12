import { gray } from '../../color.js';
import { fmtK } from '../../format.js';
import { fmtHHMM } from './helpers.js';

export function renderFooter(runStartedAt: string, totalTokens: number): string {
  const elapsed = runStartedAt !== '' ? fmtHHMM(runStartedAt) : '00:00';
  return `  elapsed  ${elapsed}    tokens  ${fmtK(totalTokens)}    ${gray('ctrl-c saves state')}`;
}
