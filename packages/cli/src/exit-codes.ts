/**
 * Re-export shim — all exit-code logic lives in packages/cli/src/errors/.
 * Existing import sites continue to compile unchanged.
 */

export type { ExitCode } from './errors/codes.js';
export { EXIT_CODES } from './errors/codes.js';
export { exitCodeFor, formatError } from './errors/format.js';
export type { ErrorHandler, RegistryEntry } from './errors/registry.js';
export { errorRegistry, makeHandler } from './errors/registry.js';
