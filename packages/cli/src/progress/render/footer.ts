import { gray } from '../../color.js';
import { fmtCostApprox } from '../../format.js';
import { fmtHHMM } from './helpers.js';
import type { AuthInfo } from './types.js';

export function renderFooter(runStartedAt: string, auth: AuthInfo, spentUsd: number): string {
  const elapsed = runStartedAt !== '' ? fmtHHMM(runStartedAt) : '00:00';
  return `  est  ${fmtCostApprox(auth.estUsd)}    spent  ${fmtCostApprox(spentUsd)}    elapsed  ${elapsed}    ${gray('ctrl-c saves state')}`;
}
